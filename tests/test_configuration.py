import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.request import urlopen

from era5viewer.configuration import parse_settings, read_config
from era5viewer.server import PROJECT
from scripts.make_test_data import make_file


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path.cwd())
        self.directory = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_personal_filename_cli_precedence_and_read_only_file(self):
        path = self.directory / "my custom archive.json"
        contents = json.dumps({"data_root": "/own/archive", "port": 8787, "cache_mb": 128})
        path.write_text(contents)
        path.chmod(0o444)
        args = parse_settings(PROJECT, ["--config", str(path), "--port", "8788"])
        self.assertEqual(args.data_root, "/own/archive")
        self.assertEqual(args.port, 8788)
        self.assertEqual(args.cache_mb, 128)
        self.assertEqual(args.host, "127.0.0.1")
        self.assertEqual(args.config, str(path))
        self.assertEqual(path.read_text(), contents)

    def test_environment_selects_the_personal_file(self):
        path = self.directory / "chosen.json"
        path.write_text('{"data_root":"/chosen","port":8899}')
        with patch.dict(os.environ, {"ERA5VIEWER_CONFIG": str(path)}):
            args = parse_settings(PROJECT, [])
        self.assertEqual(args.data_root, "/chosen")
        self.assertEqual(args.port, 8899)

    def test_invalid_configuration_is_rejected_before_starting(self):
        path = self.directory / "bad.json"
        for values in ([], {"port": True}, {"port": "8766"}, {"port": 70000},
                       {"cache_mb": 2}, {"data_root": ""}, {"unexpected": 3}):
            path.write_text(json.dumps(values))
            with self.assertRaises(ValueError):
                read_config(path)
        path.write_text("{broken")
        with self.assertRaises(ValueError):
            read_config(path)

    def test_two_readers_use_independent_configs_and_caller_relative_paths(self):
        readers, ports, logs = [], [], []
        shared_before = (PROJECT / "config.json").read_bytes()
        try:
            for number, date in enumerate(("2016-09-25", "2016-09-26")):
                root = self.directory / f"archive-{number}"
                make_file(root / f"era5_2016d{269 + number}.nc", date=date, constant=True,
                          lat=[10, 0, -10], lon=[0, 90, 180, 270], times=(0,))
                name = f"personal-{number}.json"
                (self.directory / name).write_text(json.dumps({"data_root": str(root), "port": 0,
                                                             "cache_mb": 32 * (number + 1)}))
                env = dict(os.environ, VIRTUAL_ENV=str(self.directory / "active-environment"))
                env["PYTHONPATH"] = os.pathsep.join(str(Path(p).resolve())
                    for p in os.environ.get("PYTHONPATH", "").split(os.pathsep) if p)
                proc = subprocess.Popen(["bash", str(PROJECT / "start.sh"), "--config", name],
                    cwd=self.directory, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                readers.append(proc)
                lines = []
                logs.append(lines)
                def collect(process=proc, output=lines):
                    for line in process.stdout:
                        output.append(line)
                threading.Thread(target=collect, daemon=True).start()
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    matches = [line for line in lines if line.startswith("Open http://")]
                    if matches:
                        ports.append(matches[0].split("/")[2])
                        break
                    if proc.poll() is not None:
                        self.fail("Reader exited: " + "".join(lines))
                    time.sleep(0.03)
                else:
                    self.fail("Reader did not start: " + "".join(lines))
            self.assertNotEqual(ports[0], ports[1])
            for number, address in enumerate(ports):
                with urlopen(f"http://{address}/api/config", timeout=5) as response:
                    config = json.load(response)
                self.assertTrue(config["personal"])
                self.assertEqual(config["version"], "1.2.0")
                self.assertEqual(config["settings"]["data_root"], str(self.directory / f"archive-{number}"))
                self.assertEqual(config["settings"]["cache_mb"], 32 * (number + 1))
                self.assertEqual(config["config_file"], str(self.directory / f"personal-{number}.json"))
                with urlopen(f"http://{address}/api/catalog", timeout=5) as response:
                    catalog = json.load(response)
                self.assertEqual(catalog["dates"], [f"2016-09-{25 + number}"])
            self.assertEqual((PROJECT / "config.json").read_bytes(), shared_before)
        finally:
            for proc in readers:
                proc.terminate()
            for proc in readers:
                proc.wait(timeout=5)
                proc.stdout.close()


if __name__ == "__main__":
    unittest.main()
