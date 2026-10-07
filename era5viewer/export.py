"""Single-layer NetCDF exports, in source units and horizontal grid order."""
from datetime import datetime, timezone
import io

import numpy as np

from . import __version__
from .data import ENGINE, DataError, attr, decode, open_nc


FILL = np.float32(9.969209968386869e36)


def layer_netcdf(archive, fid, index, variable="t", mode="height", value=5, reference="agl"):
    """Return a NetCDF3 64-bit-offset file without writing in the archive/project.

    Decoded float32 output avoids another lossy packing step. Only one time,
    one vertical coordinate, the selected field, lnsp and surface z are written.
    Missing auxiliaries are documented, never replaced with made-up values.
    """
    with archive.lock:
        meta = archive.meta(fid)
        record = archive.record(fid, index)
        field = archive.layer(fid, index, variable, mode, value, reference)
        timedim, _, latdim, londim = meta["dims"]
        with open_nc(meta["path"]) as source:
            def coordinate(dimension, names):
                name = next(n for n in names if n in source.variables and
                            source.variables[n].dimensions == (dimension,))
                return source.variables[name]

            latvar = coordinate(latdim, ("latitude", "lat"))
            lonvar = coordinate(londim, ("longitude", "lon"))
            timevar = coordinate(timedim, ("time", "valid_time"))
            lat, lon = decode(latvar), decode(lonvar)
            time = float(decode(timevar, slice(index, index + 1))[0])
            time_units = attr(timevar, "units")
            calendar = attr(timevar, "calendar", "gregorian")
            field_attrs = {"long_name": meta["fields"][variable]["name"],
                           "units": meta["fields"][variable]["units"]}
            if variable in source.variables:
                original = source.variables[variable]
                for name in ("standard_name", "long_name", "units"):
                    if attr(original, name) is not None:
                        field_attrs[name] = attr(original, name)
            elif variable == "wind_speed":
                field_attrs.update(standard_name="wind_speed", units="m s-1",
                                   comment="Magnitude of the U and V components on this selected layer.")

        # Reverse the reader's sorting and restore any duplicate cyclic endpoint.
        y = np.argsort(meta["yi"])
        x = np.full(len(lon), -1, dtype=int)
        x[meta["xi"]] = np.arange(len(meta["xi"]))
        for i in np.flatnonzero(x < 0):
            delta = (meta["lon"] - lon[i] + 180) % 360 - 180
            matches = np.flatnonzero(np.abs(delta) < 1e-5)
            if not len(matches):
                raise DataError("Could not restore the source longitude coordinates.")
            x[i] = matches[0]

        def original_order(array):
            return np.asarray(array, dtype="float32")[y][:, x]

        arrays = {variable: original_order(field)}
        missing = []
        if "lnsp" in meta["variables"]:
            lnsp = archive.read(fid, index, "lnsp")
            if lnsp.ndim == 3 and lnsp.shape[0] == 1:
                lnsp = lnsp[0]
            if lnsp.ndim != 2:
                raise DataError("lnsp must be a surface latitude/longitude field.")
            arrays["lnsp"] = original_order(lnsp)
        elif meta["pressure_available"]:
            sp = archive.surface_pressure(fid, index)
            with np.errstate(divide="ignore", invalid="ignore"):
                arrays["lnsp"] = original_order(np.where(sp > 0, np.log(sp), np.nan))
        else:
            missing.append("lnsp is unavailable")
        surface_name = "surface_geopotential" if variable == "z" else "z"
        if meta["surface_z"] is not None or meta["topo_indices"] is not None:
            arrays[surface_name] = original_order(archive.surface_geopotential(fid, index))
        else:
            missing.append("surface z is unavailable")

        stream = None
        if ENGINE == "netCDF4":
            from netCDF4 import Dataset
            nc = Dataset("era5-layer.nc", "w", format="NETCDF3_64BIT_OFFSET", memory=1024)
        else:
            from scipy.io import netcdf_file
            stream = io.BytesIO()
            nc = netcdf_file(stream, "w", version=2)

        try:
            vertical = {"model": "level", "pressure": "pressure", "height": "height"}[mode]
            for name, size in (("time", None), (vertical, 1), ("latitude", len(lat)), ("longitude", len(lon))):
                nc.createDimension(name, size)

            def create(name, code, dimensions, values, attributes, missing_values=False):
                options = {"fill_value": FILL} if missing_values and ENGINE == "netCDF4" else {}
                var = nc.createVariable(name, code, dimensions, **options)
                if missing_values:
                    if ENGINE != "netCDF4":
                        var._FillValue = FILL
                    var.missing_value = FILL
                    values = np.where(np.isfinite(values), values, FILL).astype("float32")
                for key, val in attributes.items():
                    setattr(var, key, val.encode("utf-8") if ENGINE != "netCDF4" and isinstance(val, str) else val)
                var[:] = values
                return var

            create("time", "d", ("time",), [time], {
                "units": time_units, "calendar": calendar, "standard_name": "time", "axis": "T"})
            create("latitude", "d", ("latitude",), lat, {
                "units": "degrees_north", "standard_name": "latitude", "axis": "Y"})
            create("longitude", "d", ("longitude",), lon, {
                "units": "degrees_east", "standard_name": "longitude", "axis": "X"})
            if mode == "model":
                vertical_attrs = {"long_name": "model_level_number", "units": "1", "positive": "down"}
                code, vertical_value = "i", int(value)
            elif mode == "pressure":
                vertical_attrs = {"standard_name": "air_pressure", "units": "hPa", "positive": "down"}
                code, vertical_value = "d", value
            else:
                vertical_attrs = {"long_name": "Geopotential height above " +
                                  ("sea level" if reference == "msl" else "ground"),
                                  "units": "m", "positive": "up", "height_reference": reference}
                if reference == "msl":
                    vertical_attrs["standard_name"] = "geopotential_height"
                code, vertical_value = "d", value * 1000
            vertical_attrs["axis"] = "Z"
            create(vertical, code, (vertical,), [vertical_value], vertical_attrs)
            create(variable, "f", ("time", vertical, "latitude", "longitude"),
                   arrays[variable][None, None], field_attrs, True)
            if "lnsp" in arrays and variable != "lnsp":
                create("lnsp", "f", ("time", "latitude", "longitude"), arrays["lnsp"][None],
                       {"units": "1", "long_name": "Logarithm of surface pressure",
                        "comment": "Natural logarithm of surface pressure expressed in Pa."}, True)
            if surface_name in arrays:
                create(surface_name, "f", ("time", "latitude", "longitude"), arrays[surface_name][None],
                       {"units": "m**2 s**-2", "long_name": "Surface geopotential",
                        "standard_name": "surface_geopotential"}, True)
            nc.Conventions = "CF-1.8"
            nc.title = "ERA5 · " + field_attrs["long_name"] + " · selected layer"
            nc.source = "ERA5"
            nc.source_file = record["filename"]
            nc.source_datetime = record["datetime"]
            nc.source_surface_geopotential = record["surface_z_source"] or "unavailable"
            nc.layer_mode = mode
            nc.layer_value = float(value)
            nc.height_reference = reference if mode == "height" else "not_applicable"
            nc.interpolation = {"model": "none; source model level", "pressure": "linear in log pressure",
                                "height": "linear in geopotential height"}[mode]
            nc.export_notes = ("One time and one layer; physical float32 values in source units. "
                               "Horizontal coordinates retain their source order. " + "; ".join(missing))
            if mode == "height":
                nc.height_calculation = "hydrostatic; " + ("virtual temperature" if "q" in meta["fields"]
                                                          else "dry air approximation (q absent)")
            nc.history = datetime.now(timezone.utc).isoformat(timespec="seconds") + " era5viewer " + __version__
            if stream is not None:
                for key, val in list(nc._attributes.items()):
                    if isinstance(val, str):
                        setattr(nc, key, val.encode("utf-8"))
                nc.flush()
                result = stream.getvalue()
            else:
                result = bytes(nc.close())
                nc = None
        finally:
            if nc is not None:
                nc.close()
        return result
