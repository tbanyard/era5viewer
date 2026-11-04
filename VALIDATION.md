# Verification

## v1.4 checks

- 43 Python tests and 7 subtests passed against synthetic NetCDF fixtures.
  The reader/API reports 1.4.0, and a live reader was started on default port
  8769. No real ERA5 archive was available for this release check.
- 18,237 forward/inverse projection samples passed for the two polar views
  and orthographic globe, including arbitrary globe rotations. Pole, horizon
  and rotated east/north wind-basis checks passed.
- DOM and native canvas integration checks exercised independent point and
  section windows; manual 300–100 and 1000–850 hPa ranges; invalid bounds;
  pointer drag; vertical edge resize; minimise/reopen with position, size,
  scroll and zoom retained; unique control IDs; and close/removal.
- Open and minimised plots were checked across time changes and synchronized
  playback. A delayed cross-section response retained the current frame,
  and pausing prevented a late response from advancing the display.
- North/south/globe field pixels and PNG exports rendered using the running
  reader. Generated renders were visually inspected. Globe rotation and
  geographic click selection passed; pixels outside its limb stayed blank.
- Animated wind moved independently of Wind arrows and time playback,
  generated visible trails, and generated no particles when U was missing.
  Turning it off cancelled its animation loop.
- The existing CSV/NetCDF/PNG exports, coordinate preferences, configuration
  editor, drift tracks, contours, plot zoom and cache checks passed.
- A full Chromium session could not start in this execution environment
  (the process exited with SIGTRAP). The expanded Playwright runner is
  included, but real-browser desktop/mobile CSS, pointer interaction and
  performance checks remain pending. DOM tests do not validate CSS layout.

## Earlier release verification

## v1.3 checks

- 43 Python tests passed against synthetic NetCDF files, including both the
  NetCDF3 and NetCDF4 readers, the cross-section endpoint, longitude-seam
  crossings, unequal legs, partial columns, terrain, and regional coverage.
- Cross-section waypoint values matched independently interpolated native
  profiles in pressure, height MSL and height AGL. Terrain and missing model
  layers were checked for gaps in the plotted data.
- DOM and native canvas checks passed against a running reader. Tested the
  Cross-section button, Ctrl-click, waypoint labels, undo/clear, vertical axes,
  and zoom. A deliberately delayed response verified that playback retained the
  current map and both plots, paused on the displayed time, and then resumed
  in sync with the same plot zoom and cross-section colour scale.
- The default reader started on port 8768 and reported version 1.3.0.
  Personal configurations and command-line overrides passed their regression tests.
- A synthetic 121 × 240 grid with eight L137 timestamps was used to check
  wind-speed transects in pressure and height. Reader-side median times were
  0.18 s for pressure and 0.23 s for MSL on a four-waypoint, 156-column route.
- The full-browser runner could not start Chromium in this environment.
  Desktop and mobile browser checks remain pending, as does testing against the
  real shared archive.

## Earlier verification

Validated using explicitly synthetic NetCDF fixtures and the two project
archives supplied in this conversation. No access to the user's actual
/data3/ERA5 archive or /data1/tim machine was available.

## Passed

- 38 Python tests covering science, NetCDF readers, exports, configurations and
  the HTTP API.
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

## v1.2 checks

- Layer downloads are readable NetCDF3 64-bit-offset files with one unlimited
  time record. Model, pressure and height coordinates carry the appropriate
  values and units; pressure/height interpolation and AGL/MSL are recorded.
- Exported model values compared directly against the independently unpacked
  source file, including its missing-value mask, reversed model-level ordering,
  reordered field dimensions and descending/wrapped horizontal coordinates.
- Original time units and latitude/longitude order retained, including a
  repeated cyclic longitude endpoint. Temperature remains in kelvin.
- Static, packed, spatially varying terrain correctly exported as surface z.
  Missing auxiliaries omitted with an explanation; lnsp derived from sp when
  needed. Derived wind speed does not add unwanted U/V variables to the file.
- Both the netCDF4 in-memory writer and optional SciPy NetCDF3 writer verified.
- Two reader processes launched simultaneously with different personal JSON
  files, archives, cache sizes and ports. Relative config paths resolved from
  the caller's directory. Shared config bytes remained unchanged.
- Read-only personal files, environment-selected configuration, command-line
  overrides, invalid settings, and effective configuration API checked.
- Frontend NetCDF endpoint exercised and its binary download checked.
- Bundled coastlines evaluated without external requests; actual overlay pixels
  changed when enabled. Coastlines and the ERA5 title were visually inspected
  in generated Map PNG. Map and profile title text verified during rendering.
- Compass formatting, signs, longitude wrapping, accessible toggle state and
  persisted preference checked.
- Personal JSON import and download exercised; actual downloaded JSON content
  and MIME type checked. Startup/tunnel commands, port validation and isolation
  from the active reader configuration checked.
- Version v1.2 and Wind speed quick-field label verified.

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
operation could not be executed here: a browser binary was unavailable and its
download did not complete successfully in this environment.
The optional scripts/browser-check.cjs covers those cases for a normal
browser-capable environment. DOM tests and the HTTP CORS checks passed.

The actual ERA5 archive should be opened on the user's machine to verify its
coordinates, data coverage and any file-specific differences. Height uses a dry-air approximation while q is absent. Its reference is above
ground without surface z, or sea level when matching surface z is available,
as described in SCIENCE.md.
