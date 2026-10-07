from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from netCDF4 import Dataset

from era5viewer.data import Archive
from era5viewer.export import layer_netcdf
from era5viewer.physics import G
from scripts.make_test_data import make_file, make_topography


class LayerExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path.cwd())
        self.root = Path(self.temp.name)
        self.lat = [10, 0, -10]
        self.lon = [180, 270, 0, 90]
        self.path = make_file(self.root / "2016" / "era5_2016d269.nc",
                             lat=self.lat, lon=self.lon, missing=True,
                             reorder_dims=True, reverse_levels=True, times=(0, 3))
        self.terrain = np.array([[100, 200, 300, 400], [500, 600, 700, 800],
                                 [900, 1000, 1100, 1200]])
        make_topography(self.root / "era5_topo.nc", lat=self.lat,
                        lon=[-180, -90, 0, 90], heights=self.terrain)
        self.archive = Archive(self.root)
        self.fid = self.archive.day("2016-09-25")["times"][0]["file"]

    def tearDown(self):
        self.temp.cleanup()

    def export(self, **options):
        body = layer_netcdf(self.archive, self.fid, options.pop("index", 0), **options)
        self.assertEqual(body[:4], b"CDF\x02")
        return Dataset("layer.nc", memory=body)

    def test_model_layer_matches_original_packed_values_and_coordinate_order(self):
        with self.export(variable="t", mode="model", value=100) as nc, Dataset(self.path) as source:
            self.assertEqual(set(nc.variables), {"time", "level", "latitude", "longitude", "t", "lnsp", "z"})
            self.assertTrue(nc.dimensions["time"].isunlimited())
            self.assertEqual(len(nc.dimensions["time"]), 1)
            self.assertEqual(len(nc.dimensions["level"]), 1)
            self.assertEqual(nc["t"].dimensions, ("time", "level", "latitude", "longitude"))
            np.testing.assert_array_equal(nc["latitude"][:], source["latitude"][:])
            np.testing.assert_array_equal(nc["longitude"][:], source["longitude"][:])
            level = int(np.flatnonzero(source["level"][:] == 100)[0])
            expected = source["t"][0, :, level, :].T
            np.testing.assert_array_equal(np.ma.getmaskarray(nc["t"][0, 0]), np.ma.getmaskarray(expected))
            np.testing.assert_allclose(nc["t"][0, 0].compressed(), expected.compressed(), atol=0.00002)
            self.assertEqual(nc["t"].units, "K")
            self.assertNotIn("scale_factor", nc["t"].ncattrs())
            np.testing.assert_allclose(nc["lnsp"][0], source["lnsp"][0], atol=0.000001)
            np.testing.assert_allclose(nc["z"][0] / G, self.terrain, atol=0.002)
            self.assertEqual(nc["time"].units, source["time"].units)
            self.assertEqual(nc["time"][0], source["time"][0])
            self.assertEqual(nc.interpolation, "none; source model level")
            self.assertTrue(nc.title.startswith("ERA5 ·"))

    def test_pressure_and_height_use_honest_vertical_coordinates(self):
        with self.export(variable="u", mode="pressure", value=500, index=1) as nc:
            self.assertNotIn("level", nc.dimensions)
            self.assertEqual(nc["u"].shape, (1, 1, 3, 4))
            self.assertEqual(nc["pressure"][0], 500)
            self.assertEqual(nc["pressure"].units, "hPa")
            self.assertEqual(nc["u"].units, "m s**-1")
            self.assertEqual(nc.interpolation, "linear in log pressure")
            self.assertTrue(np.isfinite(nc["u"][:]).all())
        with self.export(variable="t", mode="height", value=5, reference="msl") as nc:
            self.assertEqual(nc["height"][0], 5000)
            self.assertEqual(nc["height"].units, "m")
            self.assertEqual(nc["height"].height_reference, "msl")
            self.assertIn("dry air approximation", nc.height_calculation)
            self.assertEqual(nc.source_surface_geopotential, "era5_topo.nc")
            self.assertTrue(np.isfinite(nc["t"][:]).all())

    def test_derived_speed_contains_only_the_requested_field_and_auxiliaries(self):
        with self.export(variable="wind_speed", mode="model", value=137) as nc, Dataset(self.path) as source:
            k = int(np.flatnonzero(source["level"][:] == 137)[0])
            expected = np.hypot(source["u"][0, :, k, :], source["v"][0, :, k, :]).T
            np.testing.assert_allclose(nc["wind_speed"][0, 0], expected, atol=0.00001)
            self.assertNotIn("u", nc.variables)
            self.assertNotIn("v", nc.variables)
            self.assertEqual(nc["wind_speed"].units, "m s-1")

    def test_unavailable_auxiliaries_are_omitted_with_an_explanation(self):
        (self.root / "era5_topo.nc").unlink()
        with Dataset(self.path, "a") as nc:
            nc.renameVariable("lnsp", "unused_lnsp")
        self.archive.scan()
        with self.export(variable="t", mode="model", value=137) as nc:
            self.assertNotIn("lnsp", nc.variables)
            self.assertNotIn("z", nc.variables)
            self.assertIn("lnsp is unavailable", nc.export_notes)
            self.assertIn("surface z is unavailable", nc.export_notes)

    def test_lnsp_can_be_derived_from_surface_pressure(self):
        with Dataset(self.path, "a") as nc:
            nc.renameVariable("lnsp", "unused_lnsp")
            sp = nc.createVariable("sp", "f4", ("time", "latitude", "longitude"))
            sp.units = "Pa"
            sp[:] = 100000
        self.archive.scan()
        with self.export(variable="t", mode="model", value=137) as nc:
            np.testing.assert_allclose(nc["lnsp"][:], np.log(100000), atol=0.000001)

    def test_duplicate_cyclic_endpoint_is_restored(self):
        other = self.root / "duplicate"
        make_file(other / "era5_2016d269.nc", lat=self.lat, lon=[0, 90, 180, 270, 360], times=(0,))
        archive = Archive(other)
        fid = archive.day("2016-09-25")["times"][0]["file"]
        with Dataset("duplicate.nc", memory=layer_netcdf(archive, fid, 0, "t", "model", 137)) as nc:
            self.assertEqual(nc["t"].shape[-1], 5)
            np.testing.assert_array_equal(nc["longitude"][:], [0, 90, 180, 270, 360])
            np.testing.assert_allclose(nc["t"][0, 0, :, 0], nc["t"][0, 0, :, -1])

    def test_scipy_writer_fallback_is_a_readable_classic_netcdf(self):
        try:
            import scipy.io
        except ImportError:
            self.skipTest("SciPy is optional when netCDF4 is installed.")
        with patch("era5viewer.export.ENGINE", "scipy (NetCDF3 only)"):
            with self.export(variable="t", mode="model", value=137) as nc:
                self.assertEqual(nc["t"].shape, (1, 1, 3, 4))
                self.assertTrue(nc.title.startswith("ERA5 ·"))


if __name__ == "__main__":
    unittest.main()
