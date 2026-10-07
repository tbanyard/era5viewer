from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest

import numpy as np

from era5viewer.data import Archive, ByteCache, DataError
from era5viewer.physics import A, B, G, R_D, full_pressure, hydrostatic_height, interpolate_columns, sample_grid
from era5viewer.trajectory import trace
from scripts.make_test_data import HAS_NETCDF4, make_file, PACKING


class PhysicsTests(unittest.TestCase):
    def test_official_l137_pressure_at_standard_surface(self):
        self.assertEqual(len(A),138)
        self.assertEqual(B[-1],1)
        p=full_pressure(np.array([[101325.]]),np.arange(1,138))[:,0,0]/100
        np.testing.assert_allclose(p[[0,49,99,136]],[.0100,56.2567,589.6797,1012.0494],atol=.0001)

    def test_ecmwf_isothermal_hydrostatic_integration(self):
        # Independent analytic half-level integration; ECMWF alpha places the
        # full-level geopotential between the surrounding half levels.
        t=250.;sp=100000.;levels=np.arange(1,138)
        h=hydrostatic_height(np.full((137,1,1),t),np.array([[sp]]),levels)[:,0,0]
        ph=A+B*sp
        for level in (1,30,100,137):
            upper,lower=ph[level-1:level+1]
            alpha=np.log(2) if level==1 else 1-upper/(lower-upper)*np.log(lower/upper)
            expected=R_D*t/G*(np.log(sp/lower)+alpha)
            self.assertAlmostEqual(h[level-1],expected,delta=.01)
        self.assertTrue(np.all(np.diff(h)<0))
        moist=hydrostatic_height(np.full((137,1,1),t),np.array([[sp]]),levels,np.full((137,1,1),.01))
        np.testing.assert_allclose(moist[:,0,0],h*(1+.609133*.01),rtol=1e-6)

    def test_log_pressure_interpolation_and_missing_brackets(self):
        p=np.array([100,300,900.])[:,None,None]
        v=np.log(p)*10
        result=interpolate_columns(p,v,500,True)
        self.assertAlmostEqual(result[0,0],np.log(500)*10,places=5)
        self.assertTrue(np.isnan(interpolate_columns(p,v,1000,True)).all())
        v[1]=np.nan
        self.assertTrue(np.isnan(interpolate_columns(p,v,500,True)).all())
        self.assertTrue(np.isfinite(interpolate_columns(p,v,900,True)).all())

    def test_missing_lower_layer_does_not_create_heights_above_it(self):
        levels=np.array([100,136,137])
        h=hydrostatic_height(np.full((3,1,1),250),np.array([[100000.]]),levels)
        self.assertTrue(np.isnan(h[0]).all())
        self.assertTrue(np.isfinite(h[1:]).all())

    def test_longitude_wrap_seam_and_missing_exact_corner(self):
        lat=np.array([-10,10]);lon=np.array([0,90,180,270])
        a=np.array([[0,10,20,30],[0,10,20,30.]])
        self.assertAlmostEqual(float(sample_grid(a,lat,lon,0,-45,True)),15)
        a[0,1]=np.nan
        self.assertEqual(float(sample_grid(a,lat,lon,-10,0,True)),0)
        self.assertTrue(np.isnan(sample_grid(a,lat,lon,-10,45,True)))


class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir=Path.cwd())
        self.root=Path(self.temp.name)
        self.path=make_file(self.root/"2016"/"era5_2016d269.nc",constant=True,
                            times=(0,3,6),lat=[10,0,-10],lon=[0,90,180,270],missing=True)
        self.archive=Archive(self.root,16)
        self.record=self.archive.day("2016-09-25")["times"][0]
        self.fid=self.record["file"]

    def tearDown(self):
        self.temp.cleanup()

    def test_packing_mask_actual_times_and_descending_latitudes(self):
        self.assertEqual(self.archive.catalog()["dates"],["2016-09-25"])
        self.assertEqual(self.record["datetime"],"2016-09-25T00:00:00Z")
        self.assertEqual([t["datetime"][11:16] for t in self.archive.day("2016-09-25")["times"]],["00:00","03:00","06:00"])
        t=self.archive.read(self.fid,0,"t")
        self.assertTrue(np.isnan(t[99,1,2]))
        self.assertAlmostEqual(t[50,0,0],250,delta=PACKING["t"][0]/2+.00001)
        self.assertEqual(self.archive.meta(self.fid)["lat"].tolist(),[-10,0,10])
        self.assertAlmostEqual(self.archive.surface_pressure(self.fid,0)[0,0],100000,delta=1)

    def test_pressure_height_profiles_and_no_extrapolation(self):
        result,arrays=self.archive.slice(self.fid,1,"t","height",5)
        self.assertEqual(result["stats"]["valid"],12)
        np.testing.assert_allclose(arrays["values"],250,atol=.002)
        # Pressure levels beyond the lowest full model level are left empty.
        result,arrays=self.archive.slice(self.fid,1,"t","pressure",1100)
        self.assertEqual(result["stats"]["valid"],0)
        point=self.archive.profile(self.fid,1,0,-45,"height",5)
        self.assertEqual(len(point["profiles"]["t"]),137)
        self.assertAlmostEqual(point["selected"]["u"],12,delta=.002)
        self.assertFalse(self.record["msl_available"])
        with self.assertRaises(DataError):
            self.archive.layer(self.fid,1,"t","height",5,"msl")

    def test_speed_uses_interpolated_components(self):
        _,a=self.archive.slice(self.fid,1,"wind_speed","pressure",500)
        np.testing.assert_allclose(a["values"],np.hypot(a["u"],a["v"]),atol=1e-6)

    def test_optional_humidity_surface_z_and_extra_field(self):
        p=make_file(self.root/"2016"/"era5_2016d270.nc",date="2016-09-26",times=(0,),
                    constant=True,lat=[10,0,-10],lon=[0,90,180,270],humidity=True,surface_z=True)
        self.archive.scan()
        r=self.archive.day("2016-09-26")["times"][0]
        self.assertTrue(r["msl_available"])
        self.assertIn("q",{f["id"] for f in r["fields"]})
        h=self.archive.height(r["file"],0)
        h0=self.archive.height(self.fid,1)
        np.testing.assert_allclose(h,h0*(1+.609133*.01),rtol=1e-6)
        profile=self.archive.profile(r["file"],0,0,0,"height",5,"msl")
        np.testing.assert_allclose(np.array(profile["profiles"]["height_msl_m"])-profile["profiles"]["height_agl_m"],1000,atol=.001)

    def test_reordered_dimensions_and_model_levels(self):
        make_file(self.root/"custom.nc",date="2016-09-27",times=(9,),constant=True,
                  lat=[10,0,-10],lon=[0,90,180,270],reverse_levels=True,reorder_dims=True)
        self.archive.scan()
        r=self.archive.day("2016-09-27")["times"][0]
        t=self.archive.read(r["file"],0,"t")
        self.assertEqual(t.shape,(137,3,4))
        np.testing.assert_allclose(t,250,atol=.002)
        plane=self.archive.layer(r["file"],0,"t","model",100)
        np.testing.assert_allclose(plane,t[99])

    def test_cache_reuses_coordinates_and_stays_bounded(self):
        h=self.archive.height(self.fid,1)
        self.assertIs(h,self.archive.height(self.fid,1))
        cache=ByteCache(16)
        cache.put("a",np.zeros(12*1024**2,dtype="uint8"))
        cache.put("b",np.zeros(12*1024**2,dtype="uint8"))
        self.assertIsNone(cache.get("a"))
        self.assertLessEqual(cache.bytes,cache.limit)

    def test_no_pressure_interpolation_across_missing_model_layers(self):
        make_file(self.root/"partial.nc",date="2016-09-28",times=(0,),constant=True,
                  lat=[10,0,-10],lon=[0,90,180,270],levels=[100,120,137])
        self.archive.scan()
        r=self.archive.day("2016-09-28")["times"][0]
        p=self.archive.pressure(r["file"],0)
        target=float((p[0,0,0]+p[1,0,0])/2/100)
        a=self.archive.layer(r["file"],0,"t","pressure",target)
        self.assertTrue(np.isnan(a).all())

    def test_time_interpolated_drift_matches_analytic_winds(self):
        # U is 10 m/s at 00 UTC and 12 m/s at 03 UTC. For one hour the
        # analytic displacement is integral(10 + 2*t/10800) dt.
        result=trace(self.archive,self.fid,0,0,0,"height",5,"agl",hours=1)
        expected_metres=10*3600+(2/10800)*3600**2/2
        actual_metres=np.deg2rad(result["path"][-1]["longitude"])*(6371000+5000)
        self.assertAlmostEqual(actual_metres,expected_metres,delta=7)
        with self.assertRaises(DataError):
            trace(self.archive,self.fid,2,0,0,"height",5,"agl",hours=1)

    @unittest.skipUnless(HAS_NETCDF4,"netCDF4 is not installed in this test runtime")
    def test_hdf5_netcdf4_packing(self):
        make_file(self.root/"hdf.nc",date="2016-09-29",times=(0,),constant=True,
                  lat=[10,0,-10],lon=[0,90,180,270],fmt="NETCDF4")
        self.archive.scan()
        r=self.archive.day("2016-09-29")["times"][0]
        np.testing.assert_allclose(self.archive.read(r["file"],0,"t"),250,atol=.002)


if __name__=="__main__":
    unittest.main()
