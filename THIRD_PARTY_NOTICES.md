# Third-party notices

Leaflet 1.9.4 is redistributed from the uploaded balloon-predictor project under
its BSD 2-Clause license, included in web/vendor/leaflet/LICENSE.

The atmosphere-map interaction is developed from the uploaded
SkySightStyleAtmosphereViewer prototype. It describes its interface as
independently inspired by modern weather-map applications. No proprietary
SkySight source or API is included.

The midpoint wind-tracing workflow and local-asset approach are adapted from
balloon-predictor. Its MIT license is retained as this project's LICENSE.

ERA5 L137 coefficient values come from ECMWF's published model-level table.
Sources and assumptions are recorded in SCIENCE.md. No ERA5 weather data are
included. Retain relevant Copernicus/ECMWF attribution when sharing analyses.

The optional online basemap uses OpenStreetMap and displays its attribution.
Consult the [OpenStreetMap tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
before running a public or heavily used deployment.

Natural Earth 1:50m coastline geometry is bundled in `web/coastlines.js`, rounded
to four decimal places and split at the longitude seam. Natural Earth raster
and vector data are in the public domain. Source:
[1:50m physical vectors](https://www.naturalearthdata.com/downloads/50m-physical-vectors/).
[Terms of use](https://www.naturalearthdata.com/about/terms-of-use/).
`scripts/build_coastlines.py` reproduces the asset from the official coastline ZIP.
The map shows attribution when enabled, and Map PNG includes the source label.

Python and optional testing dependencies retain their own licenses.
