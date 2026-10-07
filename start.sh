#!/usr/bin/env bash
set -euo pipefail
viewer_project="$(cd -- "$(dirname -- "$0")" && pwd)"
export PYTHONDONTWRITEBYTECODE=1

# Use an explicitly activated environment without installing into it silently.
if [ -n "${CONDA_PREFIX:-}" ] || [ -n "${VIRTUAL_ENV:-}" ]; then
  if ! python -c 'import numpy, netCDF4' >/dev/null 2>&1; then
    echo 'The active Python environment needs numpy and netCDF4.' >&2
    printf 'Run: python -m pip install -r %q\n' "$viewer_project/requirements.txt" >&2
    exit 1
  fi
  exec python "$viewer_project/server.py" "$@"
fi

# A shared, read-only project must never need a project-local installation.
viewer_venv="${ERA5VIEWER_VENV:-${XDG_CACHE_HOME:-$HOME/.cache}/era5viewer/venv}"
if [ ! -x "$viewer_venv/bin/python" ]; then
  mkdir -p -- "$(dirname -- "$viewer_venv")"
  python3 -m venv --copies "$viewer_venv"
fi
if ! "$viewer_venv/bin/python" -c 'import numpy, netCDF4' >/dev/null 2>&1; then
  "$viewer_venv/bin/python" -m pip install -r "$viewer_project/requirements.txt"
fi
exec "$viewer_venv/bin/python" "$viewer_project/server.py" "$@"
