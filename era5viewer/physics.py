"""ERA5 L137 pressure and hydrostatic height, following ECMWF equations.

References and assumptions are described in SCIENCE.md. All pressures are Pa,
temperatures K and heights geopotential metres. Heights are deliberately not
presented as geometric altitude.
"""
from pathlib import Path

import numpy as np

G = 9.80665
R_D = 287.06
EARTH_RADIUS = 6371000.0
_COEFF = np.genfromtxt(Path(__file__).with_name("l137.csv"), delimiter=",", names=True, comments="#", skip_header=2)
A = _COEFF["a"]
B = _COEFF["b"]


def half_pressure(surface_pressure):
    sp = np.asarray(surface_pressure, dtype=np.float64)
    shape = (138,) + (1,) * sp.ndim
    return A.reshape(shape) + B.reshape(shape) * sp


def full_pressure(surface_pressure, levels):
    ph = half_pressure(surface_pressure)
    levels = np.asarray(levels, dtype=int)
    return ((ph[levels - 1] + ph[levels]) * 0.5).astype("float32")


def hydrostatic_height(temperature, surface_pressure, levels, humidity=None):
    """Return height above ground, with q=0 when humidity is not supplied.

    Integrate only complete contiguous layers from level 137 upwards. If a
    lower layer is absent, a height cannot be reconstructed for levels above
    that gap. Missing T/q/lnsp propagate instead of being guessed.
    """
    levels = np.asarray(levels, dtype=int)
    temperature = np.asarray(temperature, dtype=np.float64)
    tv = temperature if humidity is None else temperature * (1.0 + 0.609133 * humidity)
    ph = half_pressure(surface_pressure)
    out = np.full(temperature.shape, np.nan, dtype="float32")
    zh = np.zeros(temperature.shape[1:], dtype=np.float64)
    indices = {int(level): i for i, level in enumerate(levels)}
    with np.errstate(divide="ignore", invalid="ignore"):
        for level in range(137, 0, -1):
            if level not in indices:
                break
            i = indices[level]
            upper, lower = ph[level - 1], ph[level]
            if level == 1:
                dlog = np.log(lower / 0.1)
                alpha = np.log(2.0)
            else:
                dlog = np.log(lower / upper)
                alpha = 1.0 - upper / (lower - upper) * dlog
            rt = R_D * tv[i]
            out[i] = (zh + rt * alpha) / G
            zh = zh + rt * dlog
    return out


def interpolate_columns(coordinate, values, target, logarithmic=False):
    """Interpolate between adjacent model levels; never bridge a missing layer.

    Coordinate may increase or decrease with level. Below/above the first/last
    full level, or in a missing bracket, the result remains NaN.
    """
    c = np.asarray(coordinate, dtype=np.float64)
    v = np.asarray(values)
    if c.shape != v.shape:
        raise ValueError("Coordinate and variable shapes differ.")
    if logarithmic:
        with np.errstate(divide="ignore", invalid="ignore"):
            c = np.log(c)
        target = np.log(target)
    out = np.full(c.shape[1:], np.nan, dtype="float32")
    # Exact levels remain valid even if a neighbour is missing.
    for i in range(c.shape[0]):
        exact = np.isfinite(c[i]) & np.isclose(c[i], target, rtol=0, atol=1e-7)
        out = np.where(exact, v[i], out)
    for i in range(c.shape[0] - 1):
        a, b = c[i], c[i + 1]
        valid = np.isfinite(a) & np.isfinite(b) & np.isfinite(v[i]) & np.isfinite(v[i + 1])
        bracket = valid & (target > np.minimum(a, b)) & (target < np.maximum(a, b))
        with np.errstate(divide="ignore", invalid="ignore"):
            weight = (target - a) / (b - a)
            value = v[i] + weight * (v[i + 1] - v[i])
        out = np.where(bracket, value, out)
    return out.astype("float32")


def bracket(axis, value, cyclic=False):
    axis = np.asarray(axis)
    if cyclic:
        value = (value - axis[0]) % 360 + axis[0]
        if value > axis[-1]:
            return len(axis) - 1, 0, (value - axis[-1]) / (axis[0] + 360 - axis[-1])
    if value < axis[0] - 1e-7 or value > axis[-1] + 1e-7:
        raise ValueError("Location is outside the data grid.")
    value = float(np.clip(value, axis[0], axis[-1]))
    high = min(max(int(np.searchsorted(axis, value, side="right")), 1), len(axis) - 1)
    low = high - 1
    return low, high, (value - axis[low]) / (axis[high] - axis[low])


def sample_grid(array, latitudes, longitudes, lat, lon, cyclic=False):
    yi, yj, yw = bracket(latitudes, lat)
    if not cyclic:
        centre = (longitudes[0] + longitudes[-1]) / 2
        lon += 360 * round((centre - lon) / 360)
    xi, xj, xw = bracket(longitudes, lon, cyclic)
    result = np.zeros(np.asarray(array).shape[:-2], dtype=np.float64)
    for y, wy in ((yi, 1 - yw), (yj, yw)):
        for x, wx in ((xi, 1 - xw), (xj, xw)):
            weight = wy * wx
            if weight > 1e-12:
                # Do not renormalise away a missing corner near terrain.
                result = result + array[..., y, x] * weight
    return result
