#!/usr/bin/env python3
"""Create explicitly synthetic packed ERA5-shaped NetCDF for tests or UI checks.

This is never selected automatically by the viewer. Do not confuse it with ERA5.
Run: python scripts/make_test_data.py /path/to/test-data
"""
import argparse
from datetime import datetime, timezone
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from era5viewer.physics import G, full_pressure

try:
    from netCDF4 import Dataset
    HAS_NETCDF4 = True
except ImportError:
    from scipy.io import netcdf_file as Dataset
    HAS_NETCDF4 = False


PACKING = {
    "t": (0.00216985228711703, 244.619779942021, "K", "Temperature"),
    "u": (0.00269285168875587, 27.7277528478373, "m s**-1", "U component of wind"),
    "v": (0.0029012968107507, -1.30281554708702, "m s**-1", "V component of wind"),
    "lnsp": (1.13295484287332e-05, 11.2111888504541, "~", "Logarithm of surface pressure"),
}


def make_file(path, date="2016-09-25", times=(0,3,6,9,12,15,18,21), lat=None, lon=None,
              constant=False, missing=False, humidity=False, surface_z=False, levels=None,
              reverse_levels=False, reorder_dims=False, fmt="NETCDF3_64BIT_OFFSET"):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    lat = np.asarray(lat if lat is not None else np.linspace(90,-90,25), dtype="float32")
    lon = np.asarray(lon if lon is not None else np.arange(0,360,7.5), dtype="float32")
    levels = np.asarray(levels if levels is not None else np.arange(1,138), dtype=int)
    if reverse_levels:
        levels = levels[::-1]
    ll, yy = np.meshgrid(lon, lat)
    sp = np.full(ll.shape,100000.0) if constant else 97500+4500*np.cos(np.deg2rad(yy))*np.cos(np.deg2rad(ll))
    with Dataset(str(path), "w", **({"format":fmt} if HAS_NETCDF4 else {"version":2})) as nc:
        for name, size in [("time",None),("level",len(levels)),("latitude",len(lat)),("longitude",len(lon))]:
            nc.createDimension(name,size)
        for name, values, code, unit in [("latitude",lat,"f","degrees_north"),("longitude",lon,"f","degrees_east"),("level",levels,"i","")]:
            var=nc.createVariable(name,code,(name,));var[:]=values
            if unit:var.units=unit
        nc.variables["level"].long_name="model_level_number"
        time=nc.createVariable("time","i",("time",))
        origin=datetime(1900,1,1,tzinfo=timezone.utc)
        start=datetime.fromisoformat(date).replace(tzinfo=timezone.utc)
        time[:]=int((start-origin).total_seconds()/3600)+np.asarray(times)
        time.units="hours since 1900-01-01 00:00:0.0";time.calendar="gregorian"
        for name,(scale,offset,unit,label) in PACKING.items():
            dims=("time","latitude","longitude") if name=="lnsp" else (
                ("time","longitude","level","latitude") if reorder_dims else ("time","level","latitude","longitude"))
            options={"fill_value":np.int16(-32767)} if HAS_NETCDF4 else {}
            var=nc.createVariable(name,"h",dims,**options)
            if not HAS_NETCDF4:var._FillValue=np.int16(-32767)
            var.missing_value=np.int16(-32767);var.scale_factor=scale;var.add_offset=offset
            var.units=unit;var.long_name=label
            if HAS_NETCDF4:var.set_auto_maskandscale(False)
            for ti,hour in enumerate(times):
                ph=full_pressure(sp,levels)
                if name=="lnsp":values=np.log(sp)
                elif constant:values=np.full(ph.shape,250 if name=="t" else (10+ti*2 if name=="u" else 0))
                elif name=="t":values=215+70*(ph/100000)**.6 +3*np.cos(np.deg2rad(yy))[None]+2*np.sin(hour/24*2*np.pi)
                elif name=="u":values=8+40*np.exp(-((np.log(ph)-np.log(26000))/.85)**2)+12*np.sin(np.deg2rad(ll))[None]*np.cos(np.deg2rad(yy))[None]+hour*.3
                else:values=15*np.sin(np.deg2rad(ll+hour*3))[None]*np.sin(np.deg2rad(yy))[None]+np.zeros(ph.shape)
                raw=np.rint((values-offset)/scale)
                if np.any((raw < -32766)|(raw > 32766)):
                    raise ValueError("Synthetic values exceed the packed range.")
                raw=raw.astype("int16")
                if missing and name in ("t","u","v") and ti==0:
                    # One missing level in one column, not a fabricated zero.
                    where=np.flatnonzero(levels==100)
                    if len(where):raw[where[0],len(lat)//2,len(lon)//2]=-32767
                if reorder_dims and name!="lnsp":raw=raw.transpose(2,0,1)
                var[ti]=raw
        if humidity:
            q=nc.createVariable("q","f",("time","level","latitude","longitude"))
            q.units="kg kg**-1";q.long_name="Specific humidity"
            q[:]=np.full((len(times),len(levels),len(lat),len(lon)),.01,dtype="float32")
        if surface_z:
            z=nc.createVariable("z","f",("latitude","longitude"))
            z.units="m**2 s**-2";z.long_name="Surface geopotential"
            z[:]=np.full((len(lat),len(lon)),1000*G,dtype="float32")
        nc.Conventions="CF-1.6"
        nc.title="SYNTHETIC ERA5VIEWER TEST FIXTURE - not ERA5 data"
    return path


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory",type=Path)
    parser.add_argument("--full-grid",action="store_true",help="Use the user's 121×240 horizontal grid.")
    parser.add_argument("--topography",action="store_true",help="Also create explicitly synthetic static surface geopotential.")
    args=parser.parse_args()
    grid={"lat":np.linspace(90,-90,121),"lon":np.arange(0,360,1.5)} if args.full_grid else {}
    make_file(args.directory/"2016"/"era5_2016d269.nc",missing=True,**grid)
    make_file(args.directory/"2016"/"era5_2016d270.nc",date="2016-09-26",**grid)
    if args.topography:
        make_topography(args.directory/"era5_topo.nc",**grid)
    print(f"Explicitly synthetic test files written to {args.directory}")


def make_topography(path, lat=None, lon=None, heights=1000, singleton=True, packed=True, units="m**2 s**-2"):
    """Explicitly synthetic terrain, with optional packed data and singleton time."""
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    lat=np.asarray(lat if lat is not None else np.linspace(90,-90,25),dtype="float32")
    lon=np.asarray(lon if lon is not None else np.arange(0,360,7.5),dtype="float32")
    with Dataset(str(path),"w",**({"format":"NETCDF3_64BIT_OFFSET"} if HAS_NETCDF4 else {"version":2})) as nc:
        nc.createDimension("lat",len(lat));nc.createDimension("lon",len(lon))
        for name,values in (("lat",lat),("lon",lon)):
            nc.createVariable(name,"f",(name,))[:]=values
        dims=("lon","lat")
        if singleton:
            nc.createDimension("time",1);dims=("time",*dims)
        var=nc.createVariable("z","i" if packed else "f",dims)
        var.units=units
        values=np.broadcast_to(np.asarray(heights)*G,(len(lat),len(lon))).T
        if packed:
            var.scale_factor=.01;var.add_offset=5.
            if HAS_NETCDF4:var.set_auto_maskandscale(False)
            values=np.rint((values-5)/.01).astype("int32")
        var[:]=values[None] if singleton else values
        nc.title="SYNTHETIC ERA5VIEWER TEST TOPOGRAPHY - not ERA5 data"
    return path


if __name__=="__main__":
    main()
