# Verification

Validated using explicitly synthetic NetCDF fixtures and the two project
archives supplied in this conversation. No access to the user's actual
/data3/ERA5 archive or /data1/tim machine was available.

## Passed

- 25 Python tests covering science, NetCDF readers and the HTTP API.
- Packed int16 T/U/V/lnsp with the exact scale factors, offsets, fill values,
  Gregorian calendar and time-units string in the provided header.
- NetCDF3 and NetCDF4/HDF5.
- Known L137 pressures against ECMWF's published standard-pressure table.
- Hydrostatic heights against an independent analytic isothermal calculation,
  including the top-layer formula and optional virtual-temperature correction.
- Optional humidity and surface geopotential; missing and omitted layers.
- Longitude seam, descending latitude, reordered dimensions and model levels.
- Bounded cache reuse, completed-layer reuse, model frames that do not retain
  evicted 3-D cubes, and time-interpolated midpoint drift.
- A 21:00 start finishing at 23:00 correctly brackets against next day's 00:00
  winds, checked against an independent analytic displacement.
- A full 240-hour drift spanning 11 daily files, the 10-day limit, and rejection
  of a missing-day gap.
- Static packed topography with transposed dimensions, singleton time,
  reversed latitude and −180–180 longitudes, mapped to the weather grid.
  Spatially varying terrain checks correct alignment; mismatched grids and
  incorrect z units are rejected. Below-terrain MSL layers remain blank.
- Actual grid spacing in metadata and dry-air notice wording.
- Actual timestamp discovery, binary slice encoding, point/profile API, CORS
  for local HTML, missing-value JSON/CSV handling and static-path restrictions.
- Frontend DOM integration using jsdom and native canvas rendering, against a
  running Python reader: fields, pressure/model/height, rapid slider updates,
  point/profile, temperature units, drift, CSV, date/time and animation.
- Default MSL when topography is present, measured-resolution badge, dismissible
  notices, primary/secondary profile axes, rounded ticks, drag/wheel zoom/reset.
- Labelled field contours checked with an analytic planar field; zoomed-window
  colour scaling narrows the range, while fixed limits remain unchanged on pan.
- Multiple tracks persist after a new point and time selection; clearing one
  retains the other; clearing all removes all. A 30-hour frontend track uses
  both daily files.
- Map and profile PNG renderers generated actual PNGs and both download controls
  were exercised. Images and colourbar/axis/track labels were visually inspected.
- Browser frame-cache budget and repeat time changes: no new slice requests
  for frames already cached. Playback buffers the day's eight real timestamps.
- Field canvas output was generated and visually inspected.
- JavaScript syntax, Python compilation and shell launcher syntax.

## Full-size fixture

A packed NetCDF3 file was generated with **8 times × 137 levels × 121 latitudes
× 240 longitudes**, matching the provided dimensions. File size: 191,435,260
bytes. The field data were synthetic, with the provided packing parameters.

Measured slice generation in the test environment, including T and U/V:

| View | Reader time |
| --- | ---: |
| 5 km MSL, first height calculation (v1.1) | 0.294 s |
| Same completed 5 km MSL layer, cached (v1.1) | 0.0024 s |
| Eight T/U/V MSL slices with binary encoding (v1.1) | 2.097 s |

The eight display frames contain **2.659 MiB** of float32 arrays, independent
of the daily file's 191 MB size. The reader held 245.0 MiB after buffering the
day, within its bounded 256 MiB cache. One separate static terrain grid was
also used. The browser cache is separately bounded to 64 MiB of frame arrays. These timings concern the reader, not browser rendering
or transfers, and will depend on the user's storage and machine.

## Remaining verification on the user's machine

Full Chromium interaction, mobile visual layout and direct file:// browser
operation could not be executed here: the remote browser service timed out
and the local browser binary could not start in this environment.
The optional scripts/browser-check.cjs covers those cases for a normal
browser-capable environment. DOM tests and the HTTP CORS checks passed.

The actual ERA5 archive should be opened on the user's machine to verify its
coordinates, data coverage and any file-specific differences. Height uses a dry-air approximation while q is absent. Its reference is above
ground without surface z, or sea level when matching surface z is available,
as described in SCIENCE.md.
