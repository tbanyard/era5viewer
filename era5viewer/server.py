"""A read-only local HTTP service; no database, Node build, or hosted service."""
import base64
import csv
import getpass
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import math
import mimetypes
from pathlib import Path
import sys
import traceback
from urllib.parse import parse_qs, unquote, urlparse

import numpy as np

from .data import Archive, DataError
from .configuration import parse_settings
from .export import layer_netcdf
from .trajectory import trace
from .section import cross_section
from . import __version__

PROJECT = Path(__file__).resolve().parent.parent


def clean(value):
    if isinstance(value, dict):
        return {str(k): clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(v) for v in value]
    if isinstance(value, (float, np.floating)):
        return float(value) if math.isfinite(value) else None
    if isinstance(value, np.integer):
        return int(value)
    return value


def encode_array(array):
    return base64.b64encode(np.ascontiguousarray(array, dtype="<f4").tobytes()).decode("ascii")


def parameters(query):
    try:
        return {"fid": query["file"][0], "index": int(query["index"][0]),
                "variable": query.get("variable", ["t"])[0], "mode": query.get("mode", ["height"])[0],
                "value": float(query.get("value", ["5"])[0]),
                "reference": query.get("reference", ["agl"])[0]}
    except (KeyError, ValueError, IndexError) as exc:
        raise DataError("Supply a file, integer time index, and a numeric layer value.") from exc


class Handler(BaseHTTPRequestHandler):
    server_version = "era5viewer/" + __version__

    def __init__(self, *args, archive, configuration=None, **kwargs):
        self.archive = archive
        self.configuration = configuration
        super().__init__(*args, **kwargs)

    def cors(self):
        origin = self.headers.get("Origin", "")
        if origin == "null" or urlparse(origin).hostname in ("127.0.0.1", "localhost", "::1"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def respond(self, body, content_type="application/json; charset=utf-8", status=200, filename=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(clean(body), allow_nan=False, separators=(",", ":")).encode()
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store" if self.path.startswith("/api/") else "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.cors()
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.end_headers()

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        parsed = urlparse(self.path)
        route, query = parsed.path, parse_qs(parsed.query)
        try:
            if route == "/api/status":
                return self.respond({"version": __version__, **self.archive.catalog()})
            if route == "/api/config":
                active = self.configuration or {}
                return self.respond({"version": __version__, "user": getpass.getuser(),
                    "project": str(PROJECT), "config_file": active.get("config_file"),
                    "personal": active.get("personal", False),
                    "settings": {"data_root": str(self.archive.root),
                        "host": active.get("host", self.server.server_address[0]),
                        "port": self.server.server_port,
                        "cache_mb": self.archive.cache.limit // 1024**2}})
            if route == "/api/catalog":
                if query.get("refresh") == ["1"]:
                    self.archive.scan()
                return self.respond(self.archive.catalog())
            if route == "/api/day":
                return self.respond(self.archive.day(query.get("date", [""])[0]))
            if route == "/api/cross-section":
                args = parameters(query)
                points = json.loads(query.get("points", ["[]"])[0])
                result, values = cross_section(self.archive, args["fid"], args["index"], args["variable"],
                                               query.get("axis", ["height_msl"])[0], points)
                result["encoding"] = "base64-float32-le"
                result["values"] = encode_array(values)
                return self.respond(result)
            if route in ("/api/slice", "/api/profile", "/api/export/slice", "/api/export/layer.nc", "/api/export/profile", "/api/drift"):
                args = parameters(query)
                if route == "/api/export/layer.nc":
                    body = layer_netcdf(self.archive, **args)
                    timestamp = self.archive.record(args["fid"], args["index"])["datetime"].replace("-", "").replace(":", "")
                    variable = "".join(c for c in args["variable"] if c.isalnum() or c == "_") or "field"
                    layer = f'{args["value"]:g}'.replace(".", "p")
                    reference = "-" + args["reference"] if args["mode"] == "height" else ""
                    filename = f'era5-{variable}-{timestamp}-{args["mode"]}-{layer}{reference}.nc'
                    return self.respond(body, "application/x-netcdf", filename=filename)
                if route in ("/api/profile", "/api/export/profile", "/api/drift"):
                    try:
                        lat, lon = float(query["lat"][0]), float(query["lon"][0])
                    except (KeyError, ValueError) as exc:
                        raise DataError("Supply numeric lat and lon.") from exc
                if route == "/api/drift":
                    args.pop("variable")
                    result = trace(self.archive, **args, lat=lat, lon=lon,
                                   hours=float(query.get("hours", ["1"])[0]))
                    return self.respond(result)
                if route.endswith("profile"):
                    result = self.archive.profile(**args, lat=lat, lon=lon)
                    if route.startswith("/api/export/"):
                        stream = io.StringIO()
                        writer = csv.writer(stream)
                        fields = list(result["profiles"])
                        field_units = {f["id"]: f["units"] for f in result["record"]["fields"]}
                        field_units.update({"pressure_hpa": "hPa", "height_agl_m": "m", "height_msl_m": "m"})
                        labels = [field + (" [" + field_units[field] + "]" if field_units.get(field) else "") for field in fields]
                        writer.writerow(["datetime_utc", "latitude", "longitude", "model_level", *labels])
                        for i, level in enumerate(result["levels"]):
                            values = [result["profiles"][field][i] for field in fields]
                            writer.writerow([result["record"]["datetime"], result["latitude"], result["longitude"], level,
                                             *["" if not np.isfinite(v) else v for v in values]])
                        return self.respond(stream.getvalue(), "text/csv; charset=utf-8", filename="era5-profile.csv")
                    return self.respond(result)
                result, arrays = self.archive.slice(**args, winds=query.get("winds", ["1"])[0] != "0")
                if route == "/api/export/slice":
                    stream = io.StringIO()
                    writer = csv.writer(stream)
                    names = list(arrays)
                    field = result["variable"]
                    writer.writerow(["datetime_utc", "latitude", "longitude", "mode", "level_value", "height_reference",
                                     f'{field["id"]} [{field["units"]}]', *[n+" [m s-1]" for n in names[1:]]])
                    for yi, latitude in enumerate(result["latitudes"]):
                        for xi, longitude in enumerate(result["longitudes"]):
                            writer.writerow([result["record"]["datetime"], latitude, (longitude+180) % 360-180,
                                             args["mode"], args["value"], args["reference"] if args["mode"] == "height" else "",
                                             *["" if not np.isfinite(arrays[n][yi, xi]) else float(arrays[n][yi, xi]) for n in names]])
                    return self.respond(stream.getvalue(), "text/csv; charset=utf-8", filename="era5-slice.csv")
                result["encoding"] = "base64-float32-le"
                result["arrays"] = {name: encode_array(arr) for name, arr in arrays.items()}
                return self.respond(result)
            if route.startswith("/api/"):
                return self.respond({"error": "Unknown API endpoint."}, status=404)
            requested = unquote(route).lstrip("/") or "index.html"
            if requested != "index.html" and not requested.startswith("web/"):
                return self.respond({"error": "Not found."}, status=404)
            path = (PROJECT/requested).resolve()
            allowed = path == PROJECT/"index.html" or path.is_relative_to(PROJECT/"web")
            if not allowed or not path.is_file():
                return self.respond({"error": "Not found."}, status=404)
            kind = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            return self.respond(path.read_bytes(), kind)
        except (DataError, ValueError, IndexError) as exc:
            self.respond({"error": str(exc)}, status=400)
        except (OSError, RuntimeError) as exc:
            self.respond({"error": f"Could not read ERA5 data: {exc}"}, status=422)
        except Exception:
            traceback.print_exc()
            self.respond({"error": "Unexpected server error; see the terminal running era5viewer."}, status=500)

    def log_message(self, fmt, *args):
        if "/api/status" not in str(args[0] if args else ""):
            super().log_message(fmt, *args)


def main(argv=None):
    args = parse_settings(PROJECT, argv)
    archive = Archive(args.data_root, args.cache_mb)
    configuration = {"config_file": args.config, "host": args.host,
                     "personal": Path(args.config).resolve() != (PROJECT / "config.json").resolve()}
    handler = partial(Handler, archive=archive, configuration=configuration)
    try:
        server = ThreadingHTTPServer((args.host, args.port), handler)
    except OSError as exc:
        print(f"Cannot start era5viewer: {exc}. Try --port with a free port, for example 8769.", file=sys.stderr)
        return 1
    server.daemon_threads = True
    print(f"\nera5viewer {__version__}  •  {archive.catalog()['engine']}", flush=True)
    print(f"Data: {archive.root}  •  {len(archive.dates)} indexed days", flush=True)
    print(f"Config: {args.config}  •  reader user: {getpass.getuser()}", flush=True)
    print(f"Open http://{args.host}:{server.server_port}/ or open index.html directly.\nCtrl+C to stop.\n", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
    return 0
