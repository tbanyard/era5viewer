"""Great-circle transects through ERA5 model-level columns."""
from collections import defaultdict

import numpy as np

from .data import DataError, open_nc
from .physics import EARTH_RADIUS, G, full_pressure, grid_weights, hydrostatic_height, interpolate_columns

MAX_WAYPOINTS = 26
MAX_SAMPLES = 512
SECTION_AXES = ("height_msl", "height_agl", "pressure")


def route_samples(waypoints, spacing_km):
    try:
        points = np.asarray(waypoints, dtype=float)
    except (TypeError, ValueError) as exc:
        raise DataError("Supply waypoints as [latitude, longitude] pairs.") from exc
    if (points.ndim != 2 or points.shape[1] != 2 or not 2 <= len(points) <= MAX_WAYPOINTS
            or not np.isfinite(points).all() or np.any(np.abs(points[:, 0]) > 90)
            or np.any(np.abs(points[:, 1]) > 180)):
        raise DataError(f"Supply 2–{MAX_WAYPOINTS} valid latitude/longitude pairs.")

    lat, lon = np.deg2rad(points.T)
    vectors = np.column_stack((np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)))
    starts, ends = vectors[:-1], vectors[1:]
    angles = np.arctan2(np.linalg.norm(np.cross(starts, ends), axis=1), np.sum(starts * ends, axis=1))
    if np.any(angles < 1e-9):
        raise DataError("Consecutive waypoints must be at different locations.")
    if np.any(np.pi - angles < 1e-8):
        raise DataError("Add an intermediate waypoint between antipodal locations.")

    lengths = angles * (EARTH_RADIUS / 1000)
    cumulative = np.r_[0, np.cumsum(lengths)]
    spacing = max(spacing_km, cumulative[-1] / (MAX_SAMPLES - len(points)))
    path = [points[:1]]
    distances = [np.array([0.0])]
    indices = [0]
    for leg, (angle, length) in enumerate(zip(angles, lengths)):
        fraction = np.linspace(0, 1, int(np.ceil(length / spacing)) + 1)[1:]
        xyz = (np.sin((1 - fraction) * angle)[:, None] * starts[leg]
               + np.sin(fraction * angle)[:, None] * ends[leg]) / np.sin(angle)
        coords = np.rad2deg(np.column_stack((np.arctan2(xyz[:, 2], np.hypot(xyz[:, 0], xyz[:, 1])),
                                            np.arctan2(xyz[:, 1], xyz[:, 0]))))
        coords[-1] = points[leg + 1]
        path.append(coords)
        distances.append(cumulative[leg] + length * fraction)
        indices.append(indices[-1] + len(fraction))
    return np.concatenate(path), np.concatenate(distances), indices


class RouteColumns:
    """Read only the small source-grid windows touched by this transect."""

    def __init__(self, archive, meta, record, path):
        self.archive, self.meta, self.record = archive, meta, record
        self.weights = np.zeros((len(path), 4))
        self.indices = np.zeros((len(path), 4), dtype=int)
        self.valid = np.zeros(len(path), dtype=bool)
        corners = {}
        for row, (lat, lon) in enumerate(path):
            try:
                weights = list(grid_weights(meta["lat"], meta["lon"], lat, lon, meta["cyclic"]))
            except ValueError:
                continue  # Regional grids can cover just part of a route.
            self.valid[row] = True
            for col, (y, x, weight) in enumerate(weights):
                self.indices[row, col] = corners.setdefault((y, x), len(corners))
                self.weights[row, col] = weight
        self.y, self.x = np.array(list(corners), dtype=int).reshape(-1, 2).T
        sy, sx = meta["yi"][self.y], meta["xi"][self.x]
        tiles = defaultdict(list)
        for i, (y, x) in enumerate(zip(sy, sx)):
            tiles[y // 32, x // 32].append(i)
        self.windows = []
        for indices in tiles.values():
            y, x = sy[indices], sx[indices]
            y0, x0 = y.min(), x.min()
            self.windows.append((indices, (slice(y0, y.max() + 1), slice(x0, x.max() + 1)), y-y0, x-x0))

    def read(self, nc, name):
        meta, record = self.meta, self.record
        cached = self.archive.cache.get((record["file"], meta["stamp"], record["index"], name, None))
        if cached is not None:
            return cached[..., self.y, self.x]
        has_levels = meta["dims"][1] in nc.variables[name].dimensions
        shape = (len(meta["levels"]), len(self.y)) if has_levels else (len(self.y),)
        result = np.empty(shape, dtype="float32")
        for indices, window, y, x in self.windows:
            block = self.archive.read_window(nc, meta, record["index"], name, window=window)
            result[..., indices] = block[..., y, x]
        return result

    def sample(self, corners):
        if not len(self.y):
            return np.full(corners.shape[:-1] + (len(self.valid),), np.nan)
        values = corners[..., self.indices]
        result = np.sum(np.where(self.weights > 0, values, 0) * self.weights, axis=-1)
        result[..., ~self.valid] = np.nan
        return result


def cross_section(archive, fid, index, variable, axis, waypoints):
    if axis not in SECTION_AXES:
        raise DataError("Choose sea-level height, height above ground, or pressure for the cross-section.")
    with archive.lock:
        record = archive.record(fid, index)
        meta = archive.meta(fid)
        if variable not in meta["fields"]:
            raise DataError(f"Variable {variable!r} is unavailable at this time.")
        available = {"pressure": record["pressure_available"], "height_agl": record["height_available"],
                     "height_msl": record["msl_available"]}
        if not available[axis]:
            raise DataError("The requested cross-section vertical coordinate is unavailable at this time.")
        spacing = min(60, max(2, min(record["resolution"][key] for key in ("latitude", "longitude")) * 55))
        path, distance, waypoints = route_samples(waypoints, spacing)
        columns = RouteColumns(archive, meta, record, path)
        names = ("u", "v") if variable == "wind_speed" else (variable,)
        with open_nc(meta["path"]) as nc:
            data = {name: columns.read(nc, name) for name in names}
            if "lnsp" in meta["variables"]:
                log_pressure = columns.read(nc, "lnsp")
                if log_pressure.ndim != 1:
                    if log_pressure.shape[0] != 1:
                        raise DataError("lnsp must be a surface latitude/longitude field.")
                    log_pressure = log_pressure[0]
                sp = np.exp(log_pressure.astype("float64"))
            else:
                sp = columns.read(nc, "sp").astype("float64")
            if sp.ndim != 1:
                raise DataError("Surface pressure must be a latitude/longitude field.")

            sp = np.where(np.isfinite(sp) & (sp > 0), sp, np.nan)

            if axis == "pressure":
                coordinate = columns.sample(full_pressure(sp, meta["levels"]))
                terrain = columns.sample(sp) / 100
                vertical = np.geomspace(1200, .01, 401)
            else:
                temperature = data["t"] if "t" in data else columns.read(nc, "t")
                humidity = (data["q"] if "q" in data else columns.read(nc, "q")) if "q" in meta["fields"] else None
                coordinate = columns.sample(hydrostatic_height(temperature, sp, meta["levels"], humidity))
                terrain = np.where(columns.valid, 0.0, np.nan)
                if axis == "height_msl":
                    if meta["surface_z"]:
                        terrain = columns.sample(columns.read(nc, meta["surface_z"])) / G
                    else:
                        yi, xi = meta["topo_indices"]
                        terrain = columns.sample(archive.topography["z"][yi[columns.y], xi[columns.x]]) / G
                    coordinate = coordinate + terrain
                terrain /= 1000
                vertical = np.linspace(-1 if axis == "height_msl" else 0, 100, 405)

        sampled = [columns.sample(data[name]) for name in names]

    pressure = axis == "pressure"
    targets = vertical[:, None] * (100 if pressure else 1000)
    values = [interpolate_columns(coordinate[:, None, :], column[:, None, :], targets,
                                  logarithmic=pressure, levels=meta["levels"]) for column in sampled]
    raster = np.hypot(*values) if variable == "wind_speed" else values[0]
    below = vertical[:, None] > terrain if pressure else vertical[:, None] < terrain
    raster[below] = np.nan
    return {"record": record, "variable": meta["fields"][variable], "axis": axis,
            "path": path.tolist(), "distance_km": distance.tolist(), "waypoints": waypoints,
            "vertical": vertical.tolist(), "surface": terrain.tolist(), "shape": list(raster.shape)}, raster
