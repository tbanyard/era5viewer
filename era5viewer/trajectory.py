"""Midpoint horizontal drift on a selected ERA5 layer (not a landing forecast)."""
from bisect import bisect_left
from collections import OrderedDict
from datetime import timedelta
import math

import numpy as np

from .data import DataError, iso
from .physics import EARTH_RADIUS, sample_grid


def trace(archive, fid, index, lat, lon, mode, value, reference, hours=1, step=120):
    archive.record(fid, index)
    if not all(np.isfinite(v) for v in (lat, lon, hours, value, step)) or not 0 < hours <= 240:
        raise DataError("Choose a finite drift duration greater than 0 and no more than 240 hours (10 days).")
    if not 30 <= step <= 3600:
        raise DataError("Drift integration step must be between 30 and 3600 seconds.")
    if abs(lat) > 85 or abs(lon) > 540:
        raise DataError("Drift starts must be between 85°S and 85°N with a valid longitude.")
    start = archive.meta(fid)["times"][index]
    finish = start + timedelta(hours=hours)
    records = []
    date = start.date()
    # A finish between the last record and midnight needs the next day's
    # first timestamp as its upper interpolation bracket.
    while date <= finish.date() + timedelta(days=1):
        if date.isoformat() in archive.dates:
            for item in archive.day(date.isoformat())["times"]:
                meta = archive.meta(item["file"])
                records.append((meta["times"][item["index"]], item["file"], item["index"]))
        if records and max(r[0] for r in records) >= finish:
            break
        date += timedelta(days=1)
    records.sort()
    high = bisect_left([r[0] for r in records], finish)
    records = [r for r in records[:high+1] if r[0] >= start]
    dates = [r[0] for r in records]
    if not dates or start < dates[0] or finish > dates[-1]:
        end = iso(dates[-1]) if dates else "none"
        raise DataError(f"Future data do not cover this drift. Last available time in the requested interval: {end}.")
    layers = OrderedDict()
    used_files = set()
    def wind_record(r, s):
        time, file, ti = r
        if (file, ti) not in layers:
            meta = archive.meta(file)
            if not {"u", "v"}.issubset(meta["fields"]):
                raise DataError("Wind drift needs both U and V at every contributing time.")
            layers[file, ti] = (meta, archive.layer(file, ti, "u", mode, value, reference),
                               archive.layer(file, ti, "v", mode, value, reference))
            while len(layers) > 4:
                layers.popitem(last=False)
        layers.move_to_end((file, ti))
        used_files.add(str(archive.files[file].relative_to(archive.root)))
        meta, u, v = layers[file, ti]
        us = float(sample_grid(u, meta["lat"], meta["lon"], s[0], s[1], meta["cyclic"]))
        vs = float(sample_grid(v, meta["lat"], meta["lon"], s[0], s[1], meta["cyclic"]))
        if not np.isfinite(us) or not np.isfinite(vs):
            raise DataError("Drift reached missing winds, an unrepresented layer, or a layer below terrain.")
        return np.array([us, vs])

    def velocity(s, elapsed):
        if abs(s[0]) > 85:
            raise DataError("Drift reached the 85° latitude limit.")
        time = start + timedelta(seconds=float(elapsed))
        high = bisect_left(dates, time)
        if high < len(dates) and dates[high] == time:
            uv = wind_record(records[high], s)
        else:
            if high == 0 or high == len(dates):
                raise DataError("Drift exceeded available time coverage.")
            a, b = records[high-1], records[high]
            gap = (b[0]-a[0]).total_seconds()
            if gap > 6*3600:
                raise DataError("A gap longer than six hours prevents this drift.")
            weight = (time-a[0]).total_seconds()/gap
            uv = wind_record(a, s) * (1-weight) + wind_record(b, s) * weight
        radius = EARTH_RADIUS + (value*1000 if mode == "height" else 0)
        return np.array([uv[1]/radius*180/math.pi,
                         uv[0]/(radius*math.cos(math.radians(s[0])))*180/math.pi])

    state = np.array([lat, lon], dtype=float)
    path = []
    elapsed = 0.0
    while True:
        velocity(state, elapsed)
        path.append({"datetime": iso(start+timedelta(seconds=elapsed)), "latitude": float(state[0]),
                     "longitude": float((state[1]+180) % 360-180), "elapsed_seconds": elapsed})
        remaining = hours*3600-elapsed
        if remaining < 1e-6:
            break
        dt = min(float(step), remaining)
        initial = velocity(state, elapsed)
        middle = state + initial*dt/2
        state += velocity(middle, elapsed+dt/2)*dt
        elapsed += dt
    def distance(a, b):
        p, q = math.radians(a["latitude"]), math.radians(b["latitude"])
        dlon = math.radians(b["longitude"]-a["longitude"])
        h = math.sin((q-p)/2)**2 + math.cos(p)*math.cos(q)*math.sin(dlon/2)**2
        return 2*EARTH_RADIUS*math.asin(min(1, math.sqrt(h)))/1000
    return {"path": path, "hours": hours, "mode": mode, "value": value, "reference": reference,
            "drift_km": distance(path[0], path[-1]),
            "path_km": sum(distance(a, b) for a, b in zip(path, path[1:])),
            "source_files": sorted(used_files), "time_records": len(records),
            "description": "Horizontal advection on a fixed selected layer; linearly interpolated real ERA5 times; no ascent/descent or vertical wind."}
