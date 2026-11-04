"""Validated per-reader settings. Configuration files are only ever read."""
import argparse
import json
import os
from pathlib import Path


DEFAULTS = {"data_root": "/data3/ERA5", "host": "127.0.0.1", "port": 8768, "cache_mb": 256}


def read_config(path):
    path = Path(path).expanduser().resolve()
    try:
        if path.stat().st_size > 65536:
            raise ValueError("Configuration is too large (maximum 64 KiB).")
        values = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"Cannot read configuration {path}: {exc}") from exc
    if not isinstance(values, dict):
        raise ValueError("Configuration must be a JSON object.")
    unknown = set(values) - set(DEFAULTS)
    if unknown:
        raise ValueError("Unknown configuration setting(s): " + ", ".join(sorted(unknown)))
    for name in ("data_root", "host"):
        if name in values and (not isinstance(values[name], str) or not values[name].strip()):
            raise ValueError(f"{name} must be a nonempty string.")
    for name, low, high in (("port", 0, 65535), ("cache_mb", 16, 1048576)):
        if name in values and (type(values[name]) is not int or not low <= values[name] <= high):
            raise ValueError(f"{name} must be an integer between {low} and {high}.")
    return values


def parse_settings(project, argv=None):
    selector = argparse.ArgumentParser(add_help=False)
    selector.add_argument("--config", default=os.environ.get("ERA5VIEWER_CONFIG"))
    selection, _ = selector.parse_known_args(argv)
    explicit = selection.config is not None
    path = Path(selection.config).expanduser().resolve() if explicit else project / "config.json"
    settings = dict(DEFAULTS)
    if explicit or path.exists():
        try:
            settings.update(read_config(path))
        except ValueError as exc:
            selector.error(str(exc))
    parser = argparse.ArgumentParser(description="Local browser viewer for ERA5 L137 NetCDF files.")
    parser.add_argument("--config", default=str(path), help="Read your personal JSON file; it is never modified.")
    parser.add_argument("--data-root", default=settings["data_root"])
    parser.add_argument("--host", default=settings["host"])
    parser.add_argument("--port", type=int, default=settings["port"])
    parser.add_argument("--cache-mb", type=int, default=settings["cache_mb"])
    args = parser.parse_args(argv)
    args.config = str(path)
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535.")
    if not 16 <= args.cache_mb <= 1048576:
        parser.error("--cache-mb must be between 16 and 1048576.")
    return args
