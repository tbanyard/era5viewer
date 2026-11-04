# Vertical coordinates and sampling

Primary references:

- [ERA5 documentation: invariant surface geopotential](https://confluence.ecmwf.int/spaces/CKB/pages/76414402/ERA5+data+documentation)
- [ECMWF L137 model level definitions](https://confluence.ecmwf.int/display/UDOC/L137+model+level+definitions)
- [ECMWF ERA5 pressure, geopotential and height calculation](https://confluence.ecmwf.int/spaces/CKB/pages/158636068/ERA5+compute+pressure+and+geopotential+on+model+levels+geopotential+height+and+geometric+height)

## Pressure

era5viewer/l137.csv contains the 138 half-level coefficients from ECMWF's L137
table. The coefficient a is in Pa, b dimensionless. The table's standard-
atmosphere altitudes are not used to locate the actual levels.

At each time and horizontal grid node:

    surface pressure = exp(lnsp)                   [Pa]
    p_half[k] = a[k] + b[k] * surface pressure      [Pa]
    p_full[k] = (p_half[k-1] + p_half[k]) / 2        [Pa]

sp can substitute for lnsp if added later. Full-level pressure uses the actual
model level numbers, not array positions.

Pressure selection interpolates variables between adjacent full model levels
in log(p). Wind speed is calculated after interpolating U/V. Missing and omitted
levels are not bridged; above/below represented full levels are NaN.

## Height

Integration follows ECMWF's full/half-level algorithm, starting at ground and
working from model level 137 upwards:

    R_d = 287.06 J kg-1 K-1
    g_0 = 9.80665 m s-2
    T_virtual = T * (1 + 0.609133 * q)
    p_upper = p_half[k-1]
    p_lower = p_half[k]
    dlog_p = log(p_lower / p_upper)
    alpha = 1 - p_upper/(p_lower-p_upper) * dlog_p
    z_full = z_lower_half + R_d*T_virtual*alpha
    z_upper_half = z_lower_half + R_d*T_virtual*dlog_p

For the top layer, alpha=log(2) and dlog_p=log(p_lower/0.1), following ECMWF.
Divide geopotential by g_0 to obtain geopotential metres.

With the current T/U/V/lnsp files, q is unavailable. The reader uses q=0 and labels
the result as **approximate dry-air height above ground**. This assumption is
not a measurement of zero humidity. A model-level q variable in ERA5's kg/kg
units is used automatically when present.

Ground-relative integration starts with zero surface geopotential. If a
static/time-varying surface z is supplied, z/g_0 is added for the optional height
above the sea-level geoid. A model-level z is not mistaken for surface z. The
sea-level option is disabled when surface geopotential is absent.

The root-level `era5_topo.nc` supplies invariant ERA5 surface z when it is not
inside a weather file. Coordinates must match after ordering and longitude
normalisation; no terrain interpolation is guessed. The reader adds z/g_0 to
the ground-relative column for both maps and profiles. Embedded surface z
has precedence. The browser defaults to MSL when available and retains an
explicit user preference. MSL here denotes geopotential height relative to
the ERA5 sea-level geoid.

Height is **geopotential** height, rather than geometric altitude. An exact
geometric altitude would require the corresponding conversion and ground
reference. This distinction grows at high altitude.

Every lower layer's temperature/humidity is needed. Integration stops at an
omitted layer; missing values propagate upwards. A partial column missing
level 137 cannot support ground-relative height.

Height selection interpolates linearly in the calculated geopotential height.
It does not extrapolate from the lowest full model level down to the surface.
Pressure/height coordinates are cached by file revision and actual timestamp.

## Spatial and temporal sampling

Packed missing values are masked before scale_factor/add_offset. Arrays sort
to increasing latitude and unwrapped longitude. Global grids interpolate across
the longitude seam; regional dateline-crossing grids retain a continuous axis.

The map interpolates horizontally after evaluating each grid column on the
selected vertical surface. Point values use the same order. Profiles contain
the bilinearly sampled complete columns. This can differ slightly from
vertically interpolating a horizontally averaged coordinate column; the
selected point values follow the displayed map.

A missing corner with nonzero interpolation weight makes the sample missing.
Weights are not renormalised to hide missing/below-ground cells. Leaflet's Web
Mercator projection is used consistently for the field and graticule.

Maps display actual timestamps. Wind drift linearly interpolates U/V between
neighbouring real times. Midpoint horizontal integration uses a step of at most
120 seconds on a fixed chosen model/pressure/height surface. Time gaps over six
hours, missing wind, lost spatial coverage or latitudes beyond 85° stop the
calculation. Endpoint coverage is also checked, including the first available record after
the finish needed for interpolation. Daily files are followed on demand for up
to 10 days. Integration uses the same selected layer/reference across dates;
it does not follow a parcel vertically or preserve its starting altitude when
the selected coordinate is pressure or model level.

No vertical wind or balloon thermodynamics is inferred from T/U/V. The drift
line is a horizontal diagnostic.

## Plotting

Height is linear and pressure logarithmic in the point profile. The second
axis maps actual sampled height/pressure pairs, with interpolation in log(p);
it is not a standard-atmosphere conversion. Only the primary axis supplies
horizontal grid lines. A missing/omitted vertical layer is not bridged.

Labelled contours use marching squares over screen samples of the same
bilinearly interpolated field as the colour layer. Saddle cells use the cell
centre to select connectivity. Missing samples do not generate segments.
Contours are a visual aid at display resolution, rather than a new data product.

Automatic colour bounds use the 2nd and 98th percentiles, rounded to readable
limits. Full-layer mode uses represented grid nodes; visible-window mode uses
represented screen samples. Values beyond the bounds are colour-clipped, not
removed or altered. Fixed limits retain comparisons between times. PNG exports
use the displayed units and zoom; CSV keeps original data units and all profile
levels independently of plot zoom.

## Cross-sections

Each leg follows the shorter great-circle arc on a sphere of radius 6,371 km.
The horizontal axis is cumulative distance across those legs, and every
waypoint is sampled exactly. Each transect uses up to 512 columns. Regional
grid gaps remain blank, including where a route leaves and re-enters the data.

The reader bilinearly samples the native model columns along the route, then
interpolates vertically between adjacent model levels. Pressure interpolation
uses log-pressure, and height uses geopotential height. Wind speed is computed
from the interpolated wind components. The brown line shows surface pressure,
surface geopotential height (MSL), or zero height above ground (AGL). Samples
below the surface, outside represented levels, or across missing levels are
left blank. Sea-level height requires matching surface geopotential.


## Display projections and animated wind (v1.4)

Polar and globe views use spherical display geometry, not ellipsoidal EPSG
3413/3031 coordinates. They sample the same geographic ERA5 grid by inverse
projection at screen pixels, using the existing missing-aware bilinear
interpolator. The spherical radius is 6371 km for the approximate scale ruler.
The two polar maps use stereographic geometry centred on ±90°; a central
meridian of 0° and a dimensionless projected radius of
`2 tan(pi/4 − sign*latitude/2)`. Globe mode uses orthographic geometry about
the current rotation and omits the far hemisphere. These are display
projections, not exported coordinate reference systems; Layer netCDF retains
the original geographic grid.

Wind vectors are projected from an east/north tangent basis on the sphere,
including the changing orientation around a pole. Small projected
displacements retain subpixel precision. The animated particles are
screen-space streamlets that resample current U/V at each step. Their speed
is accelerated and capped for visual clarity, and is not a physical elapsed
time or forecast. Particles are reseeded at missing data, the screen edge,
and the globe horizon. They never create a wind value across a missing
interpolation corner. Time-dependent trajectories still use the reader's
separate drift integration.

Projection references: [PROJ stereographic](https://proj.org/en/stable/operations/projections/stere.html)
and [PROJ orthographic](https://proj.org/en/stable/operations/projections/ortho.html).
The implementation is bundled, with no projection network service.
