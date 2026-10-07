"""Read only the requested ERA5 times and layers, with a bounded RAM cache."""
from collections import OrderedDict
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import re
from pathlib import Path
import threading

import numpy as np

from .physics import G, full_pressure, hydrostatic_height, interpolate_columns, sample_grid

try:
    from netCDF4 import Dataset
    ENGINE = "netCDF4"
except ImportError:
    from scipy.io import netcdf_file
    ENGINE = "scipy (NetCDF3 only)"


class DataError(ValueError):
    pass


def attr(var, key, default=None):
    value = getattr(var, key, default)
    return value.decode("utf-8", errors="replace") if isinstance(value, bytes) else value


@contextmanager
def open_nc(path):
    if ENGINE == "netCDF4":
        nc = Dataset(str(path), "r")
        nc.set_auto_maskandscale(False)
    else:
        try:
            nc = netcdf_file(str(path), "r", mmap=False)
        except TypeError as exc:
            raise DataError("This file needs netCDF4. Run: .venv/bin/python -m pip install -r requirements.txt") from exc
    try:
        yield nc
    finally:
        nc.close()


def decode(var, index=slice(None)):
    """Mask packed missing values BEFORE applying scale_factor/add_offset."""
    raw = np.array(var[index], copy=True)
    mask = np.zeros(raw.shape, dtype=bool)
    for name in ("_FillValue", "missing_value"):
        missing = attr(var, name)
        if missing is not None:
            for value in np.atleast_1d(missing):
                mask |= raw == value
    if attr(var, "_Unsigned", "").lower() == "true" and raw.dtype.kind == "i":
        raw = raw.view(np.dtype(raw.dtype.str.replace("i", "u")))
    result = raw.astype("float64") * float(attr(var, "scale_factor", 1)) + float(attr(var, "add_offset", 0))
    result[mask] = np.nan
    return result


def time_values(var):
    units = attr(var, "units", "")
    calendar = attr(var, "calendar", "standard")
    if calendar not in ("gregorian", "standard", "proleptic_gregorian"):
        raise DataError(f"Unsupported time calendar: {calendar}. Use Gregorian ERA5 dates.")
    match = re.fullmatch(
        r"\s*(seconds?|minutes?|hours?|days?)\s+since\s+(\d{4}-\d{2}-\d{2})"
        r"(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?)?(?:\s*(?:UTC|Z|\+00:00))?\s*",
        units, re.I)
    if not match:
        raise DataError(f"Unsupported CF time units: {units!r}")
    unit, date, hour, minute, second = match.groups()
    origin = datetime.fromisoformat(date).replace(tzinfo=timezone.utc)
    origin += timedelta(hours=int(hour or 0), minutes=int(minute or 0), seconds=float(second or 0))
    factor = {"s": 1, "m": 60, "h": 3600, "d": 86400}[unit[0].lower()]
    result = []
    for value in decode(var).ravel():
        if not np.isfinite(value):
            raise DataError("The time coordinate contains a missing value.")
        result.append(origin + timedelta(seconds=float(value) * factor))
    return result


def iso(dt):
    return dt.isoformat(timespec="seconds").replace("+00:00", "Z")


def grid_spacing(axis):
    steps = np.diff(axis)
    step = float(np.median(steps))
    return step, bool(np.allclose(steps, step, rtol=1e-4, atol=1e-5))


class ByteCache:
    def __init__(self, limit_mb=256):
        self.limit = max(16, int(limit_mb)) * 1024 * 1024
        self.items = OrderedDict()
        self.bytes = 0

    def get(self, key):
        if key in self.items:
            self.items.move_to_end(key)
            return self.items[key]
        return None

    def put(self, key, value):
        if key in self.items:
            self.bytes -= self.items.pop(key).nbytes
        if value.nbytes <= self.limit:
            while self.items and self.bytes + value.nbytes > self.limit:
                self.bytes -= self.items.popitem(last=False)[1].nbytes
            value.flags.writeable = False
            self.items[key] = value
            self.bytes += value.nbytes
        return value


class Archive:
    def __init__(self, root, cache_mb=256):
        self.root = Path(root).expanduser().resolve()
        self.cache = ByteCache(cache_mb)
        self.lock = threading.RLock()  # netCDF4/HDF5 must not be used concurrently.
        self.metadata = {}
        self.files = {}
        self.dates = {}
        self.messages = []
        self.topography = None
        self.topography_error = None
        self.scan()

    def scan(self):
        with self.lock:
            self.files, self.dates, self.metadata, self.messages = {}, {}, {}, []
            self.cache = ByteCache(self.cache.limit // 1024**2)
            self.topography, self.topography_error = None, None
            if not self.root.is_dir():
                self.messages.append(f"Data directory does not exist: {self.root}")
                return self.catalog()
            topo = self.root / "era5_topo.nc"
            if topo.is_file():
                try:
                    self.topography = self.load_topography(topo)
                except (OSError, ValueError, RuntimeError) as exc:
                    self.topography_error = f"era5_topo.nc: {exc}"
                    self.messages.append(self.topography_error)
            for path in sorted(self.root.rglob("*.nc")):
                if not path.resolve().is_relative_to(self.root):
                    continue
                if path == topo:
                    continue
                relative = str(path.relative_to(self.root))
                fid = hashlib.sha256(relative.encode()).hexdigest()[:20]
                self.files[fid] = path
                # The user's daily naming scheme is indexed without opening large files.
                match = re.fullmatch(r"era5_(\d{4})d(\d{3})\.nc", path.name, re.I)
                if match:
                    year, day = map(int, match.groups())
                    if not (1 <= day <= 366):
                        continue
                    date = datetime(year, 1, 1) + timedelta(days=day - 1)
                    if date.year != year:
                        continue
                    days = [date.date().isoformat()]
                else:
                    try:
                        days = sorted({dt.date().isoformat() for dt in self.meta(fid)["times"]})
                    except (OSError, ValueError, RuntimeError) as exc:
                        self.messages.append(f"Skipped {relative}: {exc}")
                        continue
                for day in days:
                    self.dates.setdefault(day, []).append(fid)
            return self.catalog()

    def catalog(self):
        dates = sorted(self.dates)
        return {"root": str(self.root), "dates": dates, "years": sorted({d[:4] for d in dates}),
                "file_count": len(self.files), "engine": ENGINE, "messages": self.messages[:30],
                "cache_limit_mb": self.cache.limit // 1024**2,
                "topography": "era5_topo.nc" if self.topography else None,
                "topography_error": self.topography_error}

    def load_topography(self, path):
        """Read one invariant surface geopotential grid, never a weather day."""
        if not path.resolve().is_relative_to(self.root):
            raise DataError("Topography must be inside the ERA5 root directory.")
        with open_nc(path) as nc:
            coordinates = []
            for names in (("latitude", "lat"), ("longitude", "lon")):
                name = next((n for n in names if n in nc.variables), None)
                if name is None or len(nc.variables[name].dimensions) != 1:
                    raise DataError("Topography needs one-dimensional latitude and longitude coordinates.")
                coordinates.append((nc.variables[name].dimensions[0], decode(nc.variables[name]).ravel()))
            (latdim, lat), (londim, lon) = coordinates
            if "z" not in nc.variables:
                raise DataError("Topography needs a surface geopotential variable named z (m² s⁻²).")
            var = nc.variables["z"]
            unit = str(attr(var, "units", "m2 s-2")).replace(" ", "").replace("**", "").replace("^", "")
            if unit not in ("m2s-2", "m2/s2", "m²s⁻²"):
                raise DataError("z must be geopotential in m² s⁻², rather than elevation in metres.")
            selection, remaining = [], []
            for dim, size in zip(var.dimensions, var.shape):
                if dim in (latdim, londim):
                    selection.append(slice(None)); remaining.append(dim)
                elif size == 1:
                    selection.append(0)
                else:
                    raise DataError("Topography must be static; extra time/level dimensions must have size one.")
            if set(remaining) != {latdim, londim} or len(remaining) != 2:
                raise DataError("z must have latitude and longitude dimensions.")
            z = np.transpose(decode(var, tuple(selection)), [remaining.index(latdim), remaining.index(londim)])
            lon = np.mod(lon, 360)
            yi, xi = np.argsort(lat), np.argsort(lon)
            lat, lon, z = lat[yi], lon[xi], z[yi][:, xi].astype("float32")
            # Accept a duplicate cyclic endpoint, as in a 0..360 degree grid.
            keep = np.r_[True, np.diff(lon) > 1e-7]
            lon, z = lon[keep], z[:, keep]
            if not np.all(np.isfinite(lat)) or not np.all(np.isfinite(lon)) or np.any(np.diff(lat) <= 0):
                raise DataError("Invalid topography coordinates.")
            if z.nbytes > self.cache.limit:
                raise DataError("Topography exceeds the configured cache budget; increase cache_mb.")
            z.flags.writeable = False
            return {"lat": lat, "lon": lon, "z": z}

    def topography_indices(self, lat, lon):
        topo = self.topography
        if topo is None or len(lat) != len(topo["lat"]) or len(lon) != len(topo["lon"]):
            return None
        yi = np.searchsorted(topo["lat"], lat - 1e-5)
        target = np.mod(lon, 360)
        xi = np.searchsorted(topo["lon"], target - 1e-5)
        if (np.any(yi >= len(lat)) or np.any(xi >= len(lon)) or
                not np.allclose(topo["lat"][yi], lat, atol=1e-5, rtol=0) or
                not np.allclose(topo["lon"][xi], target, atol=1e-5, rtol=0)):
            return None
        return yi, xi

    def surface_geopotential(self, fid, index):
        with self.lock:
            meta = self.meta(fid)
            if meta["surface_z"]:
                return self.read(fid, index, meta["surface_z"])
            if meta["topo_indices"] is not None:
                yi, xi = meta["topo_indices"]
                return self.topography["z"][yi][:, xi]
            raise DataError("Sea-level height needs surface z in the weather file or matching era5_topo.nc in the ERA5 root.")

    def meta(self, fid):
        with self.lock:
            if fid not in self.files:
                raise DataError("Unknown file. Refresh the archive index.")
            path = self.files[fid]
            stat = path.stat()
            stamp = (stat.st_mtime_ns, stat.st_size)
            old = self.metadata.get(fid)
            if old and old["stamp"] == stamp:
                return old
            with open_nc(path) as nc:
                def coord(names):
                    name = next((n for n in names if n in nc.variables), None)
                    if name is None:
                        raise DataError(f"{path.name}: missing coordinate {'/'.join(names)}")
                    var = nc.variables[name]
                    if len(var.dimensions) != 1:
                        raise DataError(f"{name} must be a one-dimensional coordinate.")
                    return name, var.dimensions[0], decode(var).ravel()
                latname, latdim, lat = coord(("latitude", "lat"))
                lonname, londim, lon = coord(("longitude", "lon"))
                levelname, leveldim, levels = coord(("level", "model_level", "model_level_number", "lev"))
                timename = next((n for n in ("time", "valid_time") if n in nc.variables), None)
                if timename is None:
                    raise DataError("No time/valid_time coordinate found.")
                timevar = nc.variables[timename]
                if len(timevar.dimensions) != 1:
                    raise DataError("The time coordinate must have one dimension.")
                timedim = timevar.dimensions[0]
                times = time_values(timevar)
                if not times:
                    raise DataError("File has no available times.")
                if not np.all(np.isfinite(lat)) or not np.all(np.isfinite(lon)):
                    raise DataError("Missing latitude/longitude coordinates.")
                if len(lat) < 2 or len(lon) < 2 or np.any(np.abs(lat) > 90):
                    raise DataError("At least 2×2 valid latitude/longitude grid points are required.")
                if attr(nc.variables[levelname], "units", "").lower() in ("pa", "hpa", "millibar", "mbar"):
                    raise DataError("This version expects ERA5 model-level files; pressure levels are derived from lnsp.")
                if not np.all(np.isfinite(levels)) or not np.all(levels == np.round(levels)):
                    raise DataError("Expected integer ERA5 L137 model level numbers.")
                if np.any((levels < 1) | (levels > 137)) or len(np.unique(levels)) != len(levels):
                    raise DataError("Model levels must be distinct numbers between 1 and 137.")
                yi = np.argsort(lat)
                unwrapped = np.rad2deg(np.unwrap(np.deg2rad(lon)))
                xi = np.argsort(unwrapped)
                lon = unwrapped[xi]
                keep = np.r_[True, np.diff(lon) > 1e-7]
                xi, lon = xi[keep], lon[keep]
                # Do not treat a repeated 0/360 node as an additional longitude.
                if len(lon) > 2 and abs(lon[-1] - lon[0] - 360) < 1e-6:
                    lon, xi = lon[:-1], xi[:-1]
                lat = lat[yi]
                if np.any(np.diff(lat) <= 0) or len(lon) < 2:
                    raise DataError("Duplicate or invalid grid coordinates.")
                li = np.argsort(levels)
                levels = levels[li].astype(int)
                cyclic = lon[-1] - lon[0] + np.median(np.diff(lon)) >= 359.99
                fields = {}
                for name, var in nc.variables.items():
                    dims = set(var.dimensions)
                    extras = dims - {timedim, leveldim, latdim, londim}
                    dtype = np.dtype(var.dtype if hasattr(var, "dtype") else var.data.dtype)
                    if dtype.kind in "iuf" and {leveldim, latdim, londim}.issubset(dims) and all(len(nc.dimensions[d]) == 1 if ENGINE == "netCDF4" else nc.dimensions[d] == 1 for d in extras):
                        fields[name] = {"id": name, "name": attr(var, "long_name", name),
                                        "units": attr(var, "units", ""), "derived": False}
                if not fields:
                    raise DataError("No variables on model level/latitude/longitude dimensions were found.")
                if "u" in fields and "v" in fields:
                    fields["wind_speed"] = {"id": "wind_speed", "name": "Wind speed", "units": "m s⁻¹", "derived": True}
                surface_z = next((n for n in ("z", "surface_geopotential", "orog_geopotential")
                                  if n in nc.variables and leveldim not in nc.variables[n].dimensions
                                  and {latdim, londim}.issubset(nc.variables[n].dimensions)), None)
                pressure_available = "lnsp" in nc.variables or "sp" in nc.variables
                # A partial column with the bottom missing cannot be integrated from ground.
                height_available = pressure_available and "t" in fields and 137 in levels
                topo_indices = self.topography_indices(lat, lon)
                warnings = []
                if height_available and "q" not in fields:
                    warnings.append("Height uses dry air approximation (q absent)")
                if surface_z is None and topo_indices is None:
                    warnings.append(self.topography_error or (
                        "era5_topo.nc grid does not match this weather grid: sea-level height is unavailable."
                        if self.topography else "Surface geopotential is absent: add era5_topo.nc for sea-level heights."))
                if not np.array_equal(levels, np.arange(1, 138)):
                    warnings.append("Partial L137 column: height stops at the first missing layer above ground.")
                meta = {"id": fid, "path": path, "stamp": stamp, "times": times, "levels": levels,
                        "lat": lat, "lon": lon, "yi": yi, "xi": xi, "li": li,
                        "dims": (timedim, leveldim, latdim, londim), "cyclic": bool(cyclic),
                        "fields": fields, "surface_z": surface_z, "warnings": warnings,
                        "topo_indices": topo_indices, "variables": set(nc.variables),
                        "pressure_available": pressure_available, "height_available": height_available}
            self.metadata[fid] = meta
            return meta

    def day(self, date):
        if date not in self.dates:
            raise DataError(f"No data file for {date}. Use the available-date list or the day arrows.")
        entries = []
        for fid in self.dates[date]:
            meta = self.meta(fid)
            for i, time in enumerate(meta["times"]):
                if time.date().isoformat() == date:
                    entries.append((time, fid, i))
        entries.sort()
        if not entries:
            raise DataError(f"The filename indicates {date}, but its time coordinate contains no records on that date.")
        if len({e[0] for e in entries}) != len(entries):
            raise DataError(f"Duplicate timestamps for {date}. Keep one complete ERA5 file per timestamp.")
        return {"date": date, "times": [self.record(fid, i) for _, fid, i in entries]}

    def record(self, fid, index):
        meta = self.meta(fid)
        if index < 0 or index >= len(meta["times"]):
            raise DataError("Time index is outside the file.")
        dy, regular_y = grid_spacing(meta["lat"])
        dx, regular_x = grid_spacing(meta["lon"])
        return {"file": fid, "index": index, "datetime": iso(meta["times"][index]),
                "filename": str(meta["path"].relative_to(self.root)),
                "levels": meta["levels"].tolist(), "fields": list(meta["fields"].values()),
                "bounds": [float(meta["lat"][0]), float(meta["lon"][0]), float(meta["lat"][-1]), float(meta["lon"][-1])],
                "shape": [len(meta["lat"]), len(meta["lon"])], "cyclic": meta["cyclic"],
                "pressure_available": meta["pressure_available"], "height_available": meta["height_available"],
                "msl_available": meta["height_available"] and (meta["surface_z"] is not None or meta["topo_indices"] is not None),
                "surface_z_source": meta["surface_z"] or ("era5_topo.nc" if meta["topo_indices"] is not None else None),
                "resolution": {"longitude": dx, "latitude": dy, "regular": regular_x and regular_y},
                "warnings": meta["warnings"]}

    def read(self, fid, index, name, layer=None):
        with self.lock:
            meta = self.meta(fid)
            if index < 0 or index >= len(meta["times"]):
                raise DataError("Time index is outside the file.")
            key = (fid, meta["stamp"], index, name, layer)
            cached = self.cache.get(key)
            if cached is not None:
                return cached
            if layer is not None:
                cube = self.cache.get((fid, meta["stamp"], index, name, None))
                if cube is not None:
                    return cube[int(np.flatnonzero(meta["levels"] == layer)[0])]
            timedim, leveldim, latdim, londim = meta["dims"]
            with open_nc(meta["path"]) as nc:
                if name not in nc.variables:
                    raise DataError(f"Variable {name!r} is absent.")
                var = nc.variables[name]
                selection, remaining = [], []
                for dim, size in zip(var.dimensions, var.shape):
                    if dim == timedim:
                        selection.append(index)
                    elif dim == leveldim and layer is not None:
                        matches = np.flatnonzero(meta["levels"] == layer)
                        if not len(matches):
                            raise DataError(f"Model level {layer} is absent from this file.")
                        selection.append(int(meta["li"][matches[0]]))
                    elif dim in (leveldim, latdim, londim):
                        selection.append(slice(None))
                        remaining.append(dim)
                    elif size == 1:
                        selection.append(0)
                    else:
                        raise DataError(f"Variable {name} has unsupported dimension {dim}.")
                arr = decode(var, tuple(selection))
                order = [remaining.index(d) for d in (leveldim, latdim, londim) if d in remaining]
                if latdim not in remaining or londim not in remaining:
                    raise DataError(f"{name} must have latitude and longitude dimensions.")
                arr = np.transpose(arr, order)
                if leveldim in remaining:
                    arr = arr[meta["li"]]
                arr = np.take(np.take(arr, meta["yi"], axis=-2), meta["xi"], axis=-1).astype("float32")
            return self.cache.put(key, arr)

    def pressure(self, fid, index):
        with self.lock:
            meta = self.meta(fid)
            key = (fid, meta["stamp"], index, "@pressure", None)
            cached = self.cache.get(key)
            if cached is not None:
                return cached
            sp = self.surface_pressure(fid, index)
            return self.cache.put(key, full_pressure(sp, meta["levels"]))

    def surface_pressure(self, fid, index):
        meta = self.meta(fid)
        if not meta["pressure_available"]:
            raise DataError("Pressure selection needs lnsp or sp in the file.")
        if "lnsp" in meta["variables"]:
            lnsp = self.read(fid, index, "lnsp")
            if lnsp.ndim == 3 and lnsp.shape[0] == 1:
                lnsp = lnsp[0]
            if lnsp.ndim != 2:
                raise DataError("lnsp must be a surface latitude/longitude field.")
            return np.exp(lnsp.astype("float64"))
        return self.read(fid, index, "sp").astype("float64")

    def _variable_names(self, fid):
        # Only called under the archive's lock by the main readers.
        with self.lock, open_nc(self.meta(fid)["path"]) as nc:
            return set(nc.variables)

    def height(self, fid, index):
        with self.lock:
            meta = self.meta(fid)
            if not meta["height_available"]:
                raise DataError("Height selection needs T, lnsp/sp and a column extending to model level 137.")
            key = (fid, meta["stamp"], index, "@height_agl", None)
            cached = self.cache.get(key)
            if cached is not None:
                return cached
            t = self.read(fid, index, "t")
            q = self.read(fid, index, "q") if "q" in meta["fields"] else None
            height = hydrostatic_height(t, self.surface_pressure(fid, index), meta["levels"], q)
            return self.cache.put(key, height)

    def coordinate(self, fid, index, mode, reference="agl"):
        if mode == "pressure":
            return self.pressure(fid, index)
        if mode == "height":
            h = self.height(fid, index)
            if reference == "msl":
                return h + self.surface_geopotential(fid, index) / G
            return h
        raise DataError("Choose model, pressure or height.")

    def layer(self, fid, index, variable, mode, value, reference="agl"):
        with self.lock:
            meta = self.meta(fid)
            key = (fid, meta["stamp"], index, "@layer", variable, mode, value, reference)
            cached = self.cache.get(key)
            if cached is not None:
                return cached
            result = self._layer(fid, index, variable, mode, value, reference)
            # A model plane obtained from a cached cube is a view. Give the
            # completed-frame cache its own buffer, otherwise a tiny plane can
            # retain an evicted multi-megabyte cube outside the byte budget.
            if not result.flags.owndata:
                result = result.copy()
            return self.cache.put(key, result)

    def _layer(self, fid, index, variable, mode, value, reference="agl"):
        meta = self.meta(fid)
        if variable not in meta["fields"]:
            raise DataError(f"Variable {variable!r} is unavailable at this time.")
        if not np.isfinite(value):
            raise DataError("Layer value must be finite.")
        if reference not in ("agl", "msl"):
            raise DataError("Height reference must be agl or msl.")
        if mode == "model":
            if value != int(value) or int(value) not in meta["levels"]:
                raise DataError(f"Model level {value:g} is absent from this file.")
        elif mode == "pressure":
            if not 0 < value <= 1200:
                raise DataError("Pressure must be greater than 0 and no more than 1200 hPa.")
        elif mode == "height":
            if not 0 <= value <= 100:
                raise DataError("Height must be between 0 and 100 km.")
        else:
            raise DataError("Choose model, pressure or height.")
        if variable == "wind_speed":
            # Interpolate components first, then take the magnitude.
            return np.hypot(self.layer(fid, index, "u", mode, value, reference),
                            self.layer(fid, index, "v", mode, value, reference)).astype("float32")
        if mode == "model":
            return self.read(fid, index, variable, int(value))
        cube = self.read(fid, index, variable)
        c = self.coordinate(fid, index, mode, reference)
        result = interpolate_columns(c, cube, value * (100 if mode == "pressure" else 1000), mode == "pressure")
        # Do not interpolate over omitted model layers, even if arrays are adjacent.
        gaps = np.flatnonzero(np.diff(meta["levels"]) != 1)
        target = value * (100 if mode == "pressure" else 1000)
        for i in gaps:
            result = np.where((target > np.minimum(c[i], c[i+1])) & (target < np.maximum(c[i], c[i+1])), np.nan, result)
        return result

    def slice(self, fid, index, variable="t", mode="height", value=5, reference="agl", winds=True):
        with self.lock:
            meta = self.meta(fid)
            record = self.record(fid, index)
            arrays = {"values": self.layer(fid, index, variable, mode, value, reference)}
            if winds and {"u", "v"}.issubset(meta["fields"]):
                arrays["u"] = self.layer(fid, index, "u", mode, value, reference)
                arrays["v"] = self.layer(fid, index, "v", mode, value, reference)
            finite = arrays["values"][np.isfinite(arrays["values"])]
            if len(finite):
                low, high = map(float, np.percentile(finite, [2, 98]))
                if variable in ("u", "v"):
                    low, high = -max(abs(low), abs(high), 1), max(abs(low), abs(high), 1)
                if high <= low:
                    low, high = low - 1, high + 1
                stats = {"min": float(finite.min()), "max": float(finite.max()), "low": low, "high": high,
                         "valid": int(len(finite)), "total": int(arrays["values"].size)}
            else:
                stats = {"min": None, "max": None, "low": 0, "high": 1, "valid": 0, "total": int(arrays["values"].size)}
            return {"record": record, "variable": meta["fields"][variable], "mode": mode, "value": value,
                    "reference": reference, "latitudes": meta["lat"].tolist(), "longitudes": meta["lon"].tolist(),
                    "shape": [len(meta["lat"]), len(meta["lon"])], "cyclic": meta["cyclic"],
                    "stats": stats, "cache_mb": round(self.cache.bytes / 1024**2, 1)}, arrays

    def profile(self, fid, index, lat, lon, mode, value, reference="agl", variable="t"):
        with self.lock:
            meta = self.meta(fid)
            if not np.isfinite(lat) or not np.isfinite(lon) or not -90 <= lat <= 90:
                raise DataError("Invalid point coordinates.")
            def sample(arr):
                return sample_grid(arr, meta["lat"], meta["lon"], lat, lon, meta["cyclic"])
            profiles = {}
            for name in ("t", "u", "v", variable):
                if name in meta["fields"] and name != "wind_speed" and name not in profiles:
                    profiles[name] = sample(self.read(fid, index, name))
            if meta["pressure_available"]:
                profiles["pressure_hpa"] = sample(self.pressure(fid, index)) / 100
            if meta["height_available"]:
                profiles["height_agl_m"] = sample(self.height(fid, index))
                if meta["surface_z"] or meta["topo_indices"] is not None:
                    profiles["height_msl_m"] = profiles["height_agl_m"] + float(sample(self.surface_geopotential(fid, index))) / G
            if "u" in profiles and "v" in profiles:
                profiles["wind_speed"] = np.hypot(profiles["u"], profiles["v"])
            selected = {}
            for name in ("t", "u", "v", variable):
                if name in meta["fields"] and name not in selected:
                    selected[name] = float(sample(self.layer(fid, index, name, mode, value, reference)))
            if "u" in selected and "v" in selected:
                u, v = selected["u"], selected["v"]
                selected["wind_speed"] = float(np.hypot(u, v))
                selected["wind_from_deg"] = None if np.hypot(u, v) < 1e-8 else float((np.degrees(np.arctan2(-u, -v)) + 360) % 360)
            return {"record": self.record(fid, index), "latitude": lat, "longitude": (lon+180) % 360-180,
                    "levels": meta["levels"].tolist(), "selected": selected,
                    "profiles": {name: np.asarray(values).tolist() for name, values in profiles.items()}}
