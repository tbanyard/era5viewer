# era5viewer v1.3

A local ERA5 viewer combining the map controls from
SkySightStyleAtmosphereViewer with point inspection, local map assets and the
wind-tracing workflow of balloon-predictor.

The interface is plain HTML, CSS and JavaScript. A small Python reader accesses
your NetCDF files. There is no database, Node build, CDS login or conversion step.

## Install in your chosen directory

Unzip era5viewer.zip **into /data1/tim**. The ZIP already contains the
era5viewer folder, so the resulting directory is **/data1/tim/era5viewer**.

Then run:

    cd /data1/tim/era5viewer
    bash start.sh

Without an active Python environment, the first run creates a **per-user**
environment at `~/.cache/era5viewer/venv` and installs NumPy and netCDF4 there. It needs
Python 3.10 or newer, Python's venv support and internet access for that initial
installation. Later runs use that environment. The project directory can be
read-only; each user owns their installation. Stop with Ctrl+C.

Open **http://127.0.0.1:8768/** in your browser.

If you already use an activated Conda environment, you can run directly:

    conda install numpy netcdf4
    python server.py

That installs into the active Conda environment. `start.sh` now uses an explicitly
activated Conda/venv environment when its dependencies are installed. It checks
for missing dependencies and prints an installation command; it never installs
into an activated environment silently. Without an activated environment, it
uses the per-user environment described above. Set `ERA5VIEWER_VENV` to choose
a different location on a local filesystem. Using an existing Conda environment
also bypasses venv creation on filesystems that do not support its symlinks.

On a shared server, a user-owned Conda environment is another option:

    conda create --prefix "$HOME/.conda/envs/era5viewer" python=3.12 numpy netcdf4
    conda activate "$HOME/.conda/envs/era5viewer"
    bash /data1/tim/era5viewer/start.sh --config "$HOME/my-era5.json"

You can also double-click index.html while the reader is running. Its connection
dialog defaults to http://127.0.0.1:8768. Browsers that restrict local-file
network requests can use the localhost URL above.

## Your data

config.json starts with:

    {
      "data_root": "/data3/ERA5",
      "host": "127.0.0.1",
      "port": 8768,
      "cache_mb": 256
    }

Your files are read directly from paths such as:

    /data3/ERA5/2016/era5_2016d269.nc
    /data3/ERA5/2016/era5_2016d270.nc

The daily filename gives the date for indexing; **the NetCDF time coordinate
determines available times**. Day 269 of 2016 is 25 September. Day arrows step
between available days. The year/day menus help browse a long archive. You can
also type a date; a missing date displays an explanation.

Other .nc filenames are indexed by inspecting their time coordinates.
`era5_topo.nc` at the root is treated as terrain, rather than a weather day.
The reader handles your regular 1-D longitude/latitude/model-level/time layout,
packed shorts, NetCDF3 and NetCDF4/HDF5, descending latitude, different dimension
order, reversed model levels and 0–360° longitude.

Files must contain ERA5 L137 model level numbers. Arbitrary forecast hybrids,
reduced Gaussian grids, GRIB and native pressure-level files are outside this
initial version. Your header describes the supported model-level format;
pressure views are derived from that format.

Leave the shared `config.json` as the administrator's default. Use a personal
file as described below, or override settings for your own reader:

    bash start.sh --data-root /other/ERA5 --port 8768 --cache-mb 512

After adding data files, click the rescan button in the header. Restart your
reader after changing your personal configuration or updating the viewer.

## Personal configurations on a shared server

Click **Local archive → Personal configuration** to edit the data directory,
reader port, cache size and bind address. **Download JSON** saves a personal
file, such as `my-era5.json`. **Load JSON** opens an existing file in the editor.
The panel also shows the configuration and effective settings of the connected
reader. Your shared `config.json` is never edited by this panel or the reader.

When using a remote server, download the JSON on your computer and copy it to
your own directory **on the server**. Choose that server path in the editor to
get the corresponding startup command, for example:

    bash /data1/tim/era5viewer/start.sh --config /home/alice/my-era5.json

The filename and directory are your choice. `~` in a configuration path is
expanded for the account running the reader. A relative configuration path is
resolved from the directory where you invoked `start.sh`, even when the project
is elsewhere. Use absolute paths for `data_root` to keep its meaning clear.
You can alternatively set `ERA5VIEWER_CONFIG` to your personal JSON path.
Command-line settings such as `--port` override values from the chosen file.

Each user should run a reader **under their own server account** on a different
free server port. For example, Alice can choose 8769 and Bob 8770. Their data
roots, caches and configurations are independent, even though they use the same
read-only project and may read the same ERA5 archive.

For Alice's reader, run this on her computer and leave it open:

    ssh -N -L 8769:127.0.0.1:8769 alice@data-machine

Then open `http://127.0.0.1:8769/`, or set that address in the HTML viewer. The
personal-configuration panel generates startup and tunnel commands for the
chosen port. Change `data-machine` to your server's actual hostname. If that
local port is busy, use another local forwarding port, for example
`ssh -N -L 9000:127.0.0.1:8769 alice@data-machine`, and open
`http://127.0.0.1:9000/`.

The configuration editor prepares files and commands; it does not change a
running reader. Start or restart your personal reader with the selected file,
then connect to it. No project-directory write permission is needed to run it.

## Use the viewer

- **Field:** T, U, V and derived wind speed. Temperature displays °C or K.
  Additional numeric variables on the same model-level grid are discovered
  automatically; names and units come from NetCDF metadata.
- **Time.** Play loops through the available records for the selected day.
  The map, selected point profile and active cross-section advance together.
  The last displayed frame stays visible while the next loads. Plot zoom and
  axes, and the cross-section colour scale, hold steady during playback.
  The animation interval is selectable.
- **Model:** select a model level. In L137, 1 is at the top and 137 near the
  surface; each level's pressure varies across the map.
- **Pressure:** choose hPa using presets or an arbitrary number. Pressure comes
  from exp(lnsp) and the bundled L137 coefficients. Variables interpolate in
  log-pressure.
- **Height:** choose a height such as 5 km. With T/U/V/lnsp alone, this means
  **approximate dry-air geopotential height above ground**. Adding q improves
  the calculation. Surface z, including a matching `era5_topo.nc`, enables
  sea-level heights. The viewer defaults to sea level when available, with
  above ground as the fallback. An explicitly selected reference is remembered
  in the browser and applies to both the map and profiles.
- **Point:** click for T, U, V, wind speed, wind direction and a vertical profile.
  The **NSEW** button beside the coordinates switches signed values to compass
  directions, for example `3.383°N, 64.674°W`. This preference is remembered
  and also applies to hover readouts and the profile PNG's coordinates.
  Height and pressure share the profile's two y-axes. Choose the primary axis;
  only it draws horizontal grid lines. Height ticks normally use 10 km over
  the full column; zoomed views and field axes use rounded 1/2/2.5/5 intervals.
  Pressure labels use conventional hPa values on a logarithmic pressure axis.
  Drag a rectangle or scroll over the chart to zoom. Choose both axes, just
  the y-axis, or just the x-axis, and use Reset zoom (or Escape) to reset.
- **Cross-section.** Turn on **Cross-section** beside the map export controls,
  then click two or more waypoints. Ctrl-click (or ⌘-click) adds a waypoint
  with the tool off. Add up to 26 waypoints and use **Undo point** or
  **Clear route** to revise the route. Turn the tool off for ordinary point
  selection. Matching letters on the map and chart mark the waypoints along
  the cumulative-distance axis, in kilometres. Choose log-pressure, height
  above sea level (MSL) or height above ground (AGL), depending on your data.
  The brown line marks the surface. The field follows the map's variable,
  and the chart supports drag and scroll zoom. On small screens, use the
  **Cross-section** and **Selected point** buttons to switch panels.
- **Map:** pan/zoom, fit the data, toggle wind arrows/graticules, change opacity
  and toggle labelled contours of the displayed field. The grid badge reports
  measured longitude/latitude spacing rather than assuming 0.25 degrees.
  Choose Auto · full layer, Auto · visible window, or Fixed limits. Both auto
  scales use the 2–98% range with rounded bounds. The visible-window scale
  follows pan/zoom without reading a new NetCDF slice. Fixed limits are best
  when comparing different times. Missing/out-of-column regions remain blank.
  **Coastlines** adds a thin outline above the field, using bundled Natural
  Earth 1:50m geometry. It works without street tiles or an internet connection,
  appears in Map PNG, and remembers your preference. These are generalised map
  outlines, not the ERA5 model's land-sea mask.
- **PNG:** Map PNG exports the current viewport with field, contours, arrows,
  tracks, labels, date/layer and colourbar, excluding the profile and controls.
  Profile PNG exports the current profile axes and zoom. Both work offline;
  loaded basemap tiles are included in the map when available.
  Both PNG titles start with **ERA5 ·**.
- **Layer netCDF:** next to Map PNG, download one variable at the displayed time
  and model/pressure/height layer, plus `lnsp` and available **surface** `z`.
  This exports the **full source horizontal grid**, not a viewport crop. The
  original latitude/longitude values and order, time units and field units are
  preserved. Temperature is in kelvin. Physical float32 values are written
  without another packing/quantisation step, in NetCDF3 64-bit-offset format.
  Missing data use an explicit fill value. Wind speed can be exported as a
  derived field without also including U and V.

  Model slices have a single `level`; interpolated pressure slices have a
  single `pressure` in hPa; height slices have a single `height` in metres with
  the AGL/MSL reference recorded. All have one unlimited `time` record. Surface
  auxiliaries use `(time, latitude, longitude)`. Terrain is read from matching
  `era5_topo.nc` when it is not in the weather file. If `lnsp` or surface `z` is
  unavailable, it is omitted and explained in `export_notes`; zeros are never
  substituted. When only `sp` exists, `lnsp` is calculated from it. If the chosen
  atmospheric variable itself is named `z`, terrain is named
  `surface_geopotential` to distinguish the two.

  These files contain one slice, not a full atmospheric column, and are intended
  for downstream analysis. The current viewer still expects model-level archives
  for its complete profile and height calculations.
- **CSV:** export a displayed grid or a point profile. Temperature stays in
  original kelvin in CSV; missing values are blank and units are included.
- **Trace the wind:** from a selected point, trace horizontal advection on the
  chosen layer for up to **240 hours (10 days)**. Daily files are followed
  automatically, including the next day's first record when a finish before
  midnight needs it for interpolation. Winds interpolate bilinearly in space
  and linearly between actual timestamps. Missing days, large time gaps or
  missing layer/wind coverage stop the track; future winds are never invented.
  Tracks persist across point, time and layer changes. Each track keeps its
  original date/layer in the track list; select one to export CSV or clear it,
  or use Clear all tracks. Existing tracks can refer to a different time/layer
  than the current map.
- **Messages:** the × on a notice dismisses that message for the current page
  session. The dry-air notice reads “Height uses dry air approximation (q absent)”.

The drift tool includes horizontal motion only. Balloon ascent, burst, descent
and landing physics remain in the original balloon-predictor project.

Transparent regions mean missing or unrepresented data, including pressure
surfaces outside the represented column. The reader does not extrapolate past
the first/last full model level or bridge omitted/missing layers. Wind arrows
point towards travel; the point's numerical direction is the meteorological
**from** direction.

## Surface topography and sea-level heights

Place an ERA5 **surface geopotential** file at:

    /data3/ERA5/era5_topo.nc

For a different `data_root`, place it directly in that directory. Surface
geopotential is an invariant ERA5 field, so one matching file can be reused
for all dates. Use ERA5's own model surface geopotential on the same grid and
area as your weather files, rather than an unrelated high-resolution DEM.

The file must contain:

- 1-D `latitude` and `longitude` coordinates (or `lat` and `lon`).
- `z(latitude, longitude)`, in **m² s⁻²**, such as units `m**2 s**-2`.
- An optional time/level dimension is accepted if it has size one. Dimension
  order, packed scale/offsets, reversed latitude and equivalent −180–180 or
  0–360 longitude conventions are handled automatically.

A variable measured in metres is elevation, not geopotential, and is rejected.
The reader checks coordinates and does not silently interpolate mismatched
terrain. Surface z already inside a daily weather file takes precedence.
After adding/replacing the terrain file, press Rescan or restart the reader.
Sea level then becomes the default unless you have explicitly remembered an
above-ground preference. Clear the chosen height preference by selecting
Above sea level. Profiles and layer heights use the same reference.

Humidity `q` is still needed to remove the dry-air assumption. Adding terrain
changes the height reference; it does not supply humidity.

## Performance and offline use

The reader requests one timestamp and the needed variables. Direct model-level
views can read single 2-D planes. Pressure/height views load the contributing
vertical columns. Pressure, height, decoded variables and completed 2-D layers are cached in RAM;
moving the slider reuses those coordinates.

The default 256 MiB cache is bounded and evicts the least recently used arrays.
Transient calculation buffers, the one static 2-D terrain grid and NetCDF's
own I/O buffers are additional to that budget. Increase cache_mb to retain
more timestamps. A drift retains at most four U/V layer pairs locally as it
progresses, so a 10-day track does not retain every 3-D weather cube.

The browser receives 2-D slices, point profiles and sampled cross-sections.
It keeps a **64 MiB map frame cache** and a separate **24 MiB plot frame cache**.
For
240×121 points, one T/U/V display frame is approximately 0.33 MiB; all eight
times total approximately 2.7 MiB. The original 194 MB files are not transferred
to the browser. During playback, the viewer prefetches the next timestamp.
Cached frames do not request the reader again. The caches evict the least
recently used frames when full.
Changing the variable/layer creates different display frames; rescanning clears
this cache. Caching does not invent intermediate ERA5 timestamps. The ERA5 archive is
read-only: no preprocessing or derived files are required there.

All JavaScript, Leaflet and coastline assets are included. After installing the Python
dependencies, the reader and data viewer work offline. Street tiles use
OpenStreetMap when available; switch that overlay off when offline. Fields,
graticules, coastlines, wind arrows, profiles and exports continue to work.

## If the data machine is remote

Run the reader on the data machine. From your desktop:

    ssh -N -L 8768:127.0.0.1:8768 user@data-machine

Open http://127.0.0.1:8768/ on your desktop. The SSH tunnel reaches the remote
reader while keeping its default loopback binding. Run the SSH command in
a terminal on your desktop and leave it open; the reader address stays
http://127.0.0.1:8768. The SSH command is not a reader address.

## Troubleshooting

**No files:** check data_root, read permissions and the reader terminal, then
rescan. Year directories are scanned recursively.

**Reader offline:** run bash start.sh and check the connection address. A browser
needs the reader to access NetCDF on /data3/ERA5.

**Port busy:** run bash start.sh --port 8769, then use that URL or change the
connection dialog.

**Missing Python package:** install from `requirements.txt` in your chosen
environment, or rerun `start.sh` for the per-user environment.
If python3 -m venv is unavailable, install your distribution's Python venv support.

**Blank layer:** try another level. The chosen surface may lie outside the full
model-level column or contain missing data. A 0 km height is below the first full
model level and intentionally displays no field.

**Duplicate times:** keep one complete file per timestamp. Separate T/U/V/lnsp
files are not merged implicitly; your example already has them together.

**Drift stops:** its complete path must have wind/layer/time coverage. Gaps over
six hours or latitudes beyond 85°N/S stop drift. Future drift at the archive's
last time needs another file.

## Validation

Run from the project directory:

    python -m unittest discover -s tests -v

Optional browser checks need Node only for testing:

    npm install
    npx playwright install chromium
    npm run test:browser

The DOM/canvas integration check can also run without a browser binary:

    npm run test:frontend

scripts/make_test_data.py generates explicitly **synthetic** packed test data,
using the packing parameters from your header. The viewer never selects those
data automatically. The --full-grid option uses the 121×240 horizontal grid.

[SCIENCE.md](SCIENCE.md) records assumptions and primary references.
[VALIDATION.md](VALIDATION.md) records verification. The actual files on
/data3/ERA5 must be checked on your machine: this package was built from your
header and uploaded project sources.
