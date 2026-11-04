import tempfile
import unittest
from pathlib import Path

import numpy as np

from era5viewer.data import Archive, DataError
from era5viewer.physics import EARTH_RADIUS
from era5viewer.section import MAX_SAMPLES, cross_section, route_samples
from scripts.make_test_data import HAS_NETCDF4, make_file, make_topography


class SectionTests(unittest.TestCase):
    def test_unequal_legs_across_dateline_keep_exact_waypoints(self):
        points = [[0, 179], [0, -177], [9, -177]]
        path, distance, indices = route_samples(points, 50)
        np.testing.assert_array_equal(path[indices], points)
        np.testing.assert_allclose(distance[indices], np.deg2rad([0, 4, 13]) * EARTH_RADIUS / 1000)
        self.assertGreater(np.abs(path[:, 1]).min(), 175)
        self.assertTrue(np.all(np.diff(distance) > 0))

    def test_reject_degenerate_routes_and_cap_samples(self):
        for points in ([], [[0, 0], [0, 0]], [[0, 0], [0, 180]], [[91, 0], [0, 1]]):
            with self.subTest(points=points), self.assertRaises(DataError):
                route_samples(points, 5)
        path, _, indices = route_samples([[0, 0], [0, 179]] * 13, 2)
        self.assertLessEqual(len(path), MAX_SAMPLES)
        self.assertEqual(len(indices), 26)

    def test_height_and_pressure_match_native_profiles_and_mask_terrain(self):
        lat, lon = [20, 10, 0, -10, -20], [160, 170, 180, 190, 200]
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
            root = Path(directory)
            make_file(root / "era5_2016d269.nc", lat=lat, lon=lon, times=(0, 3), humidity=True,
                      reverse_levels=True, reorder_dims=True,
                      fmt="NETCDF4" if HAS_NETCDF4 else "NETCDF3_64BIT_OFFSET")
            heights = np.tile([0, 400, 1000, 1900, 3000], (len(lat), 1))
            make_topography(root / "era5_topo.nc", lat=lat, lon=lon, heights=heights)
            archive = Archive(root)
            fid = archive.day("2016-09-25")["times"][1]["file"]
            points = [[0, 180], [0, -170], [10, -165]]
            profile = archive.profile(fid, 1, *points[0], "model", 100)["profiles"]
            for axis, field in (("height_msl", "height_msl_m"), ("height_agl", "height_agl_m"),
                                ("pressure", "pressure_hpa")):
                with self.subTest(axis=axis):
                    data, values = cross_section(archive, fid, 1, "t", axis, points)
                    target = np.asarray(data["vertical"])
                    levels = np.asarray(profile[field])
                    if axis == "pressure":
                        self.assertTrue(np.isnan(values[target > data["surface"][0], 0]).all())
                        target, levels = np.log(target), np.log(levels)
                    else:
                        self.assertTrue(np.isnan(values[target < data["surface"][0], 0]).all())
                        levels /= 1000
                    order = np.argsort(levels)
                    expected = np.interp(target, levels[order], np.asarray(profile["t"])[order],
                                         left=np.nan, right=np.nan)
                    np.testing.assert_allclose(values[:, 0], expected, atol=.001)
                    if axis == "height_msl":
                        np.testing.assert_allclose(np.asarray(data["surface"])[data["waypoints"]],
                                                   [1, 1.9, 2.45], atol=.001)
                    if axis == "height_agl":
                        self.assertTrue(np.all(np.asarray(data["surface"]) == 0))

    def test_regional_edges_and_missing_levels_remain_blank(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
            root = Path(directory)
            make_file(root / "era5_2016d269.nc", lat=[10, 0, -10], lon=[0, 5, 10], times=(0,),
                      levels=[80, 100, 101, 102, 103, 104, 137], constant=True)
            archive = Archive(root)
            fid = archive.day("2016-09-25")["times"][0]["file"]
            points = [[0, -5], [0, 5], [0, 15]]
            data, values = cross_section(archive, fid, 0, "wind_speed", "pressure", points)
            self.assertTrue(np.isnan(values[:, [0, -1]]).all())
            j = data["waypoints"][1]
            valid = values[:, j][np.isfinite(values[:, j])]
            self.assertGreater(len(valid), 0)
            np.testing.assert_allclose(valid, 10, atol=.002)
            pressure = np.asarray(data["vertical"])
            p80, p100 = archive.profile(fid, 0, 0, 5, "model", 100)["profiles"]["pressure_hpa"][:2]
            self.assertTrue(np.isnan(values[(p80 < pressure) & (pressure < p100), j]).all())
            with self.assertRaisesRegex(DataError, "unavailable"):
                cross_section(archive, fid, 0, "t", "height_msl", points)
