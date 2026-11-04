# Release notes

## v1.4 (1.4.0)

- North/south polar stereographic views and a rotatable orthographic globe,
  with projection-aware fields, contours, wind, coastlines, routes and exports.
- Animated wind streamlets from the displayed layer, with missing-data and
  horizon clipping, independent of time playback.
- Multiple independent draggable/resizable point and cross-section windows;
  minimise/reopen menus preserve layout, scroll and plot zoom.
- Manual vertical bounds in hPa, km or model levels; all retained plots follow
  synchronized time playback.
- A top map toolbar, square SVG target icon, rounded graticule labels, a
  rounded distance scale, and inset green scrollbars.
- Default reader port 8769; application and API version 1.4.0.

## v1.3 (1.3.0)

- Map waypoints via the Cross-section tool or Ctrl-click. Follow multiple
  great-circle legs on a cumulative-distance axis with matching map labels.
- Cross-sections for the displayed field in log-pressure or geopotential
  height, with the surface marked and missing data left blank.
- Synchronized playback for the map, point profile and cross-section. The
  next frame is prefetched and the current plots stay visible while waiting.
- The default reader port is 8768. Personal configurations and command-line
  port overrides are supported.

## v1.2 (1.2.0)

- Layer NetCDF downloads for the displayed variable, time and vertical slice,
  with lnsp and available surface geopotential. Original horizontal coordinate
  order and physical units are retained; derived coordinates are labelled.
- Offline, thin Natural Earth coastlines, including Map PNG export.
- Remembered signed/compass coordinate toggle beside Selected Location.
- ERA5 prefix in map and profile PNG titles; Wind speed in the quick-field button.
- Personal JSON configuration editor, import/download, startup/tunnel commands
  and `--config`/`ERA5VIEWER_CONFIG` support.
- Per-user launcher environments and independent reader ports for shared servers.
  Existing activated Python environments are used without automatic installation.
- Visible v1.2 branding and reader/API version 1.2.0.

## v1.1 (1.1.0)

Cross-day wind tracks up to 10 days, persistent multiple tracks, PNG exports,
measured grid spacing, profile axes and zoom, labelled contours, visible-window
colour ranges, dismissible notices, cached animation, port 8766 and static terrain.
