import base64
from functools import partial
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import numpy as np

from era5viewer.data import Archive
from era5viewer.server import Handler
from scripts.make_test_data import make_file


class QuietHandler(Handler):
    def log_message(self,*args):
        pass


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory(dir=Path.cwd())
        make_file(Path(cls.temp.name)/"2016"/"era5_2016d269.nc",constant=True,
                  lat=[10,0,-10],lon=[0,90,180,270],times=(0,3,6),missing=True)
        cls.archive=Archive(cls.temp.name,16)
        cls.server=ThreadingHTTPServer(("127.0.0.1",0),partial(QuietHandler,archive=cls.archive))
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True)
        cls.thread.start()
        cls.base="http://127.0.0.1:"+str(cls.server.server_port)
        record=cls.archive.day("2016-09-25")["times"][1]
        cls.args={"file":record["file"],"index":record["index"],"mode":"height","value":5,"variable":"t"}

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown();cls.server.server_close();cls.thread.join();cls.temp.cleanup()

    def get(self,path,args=None,origin="null"):
        request=Request(self.base+path+("?" + urlencode(args) if args else ""),headers={"Origin":origin})
        try:
            with urlopen(request,timeout=10) as r:return r.status,r.headers,r.read()
        except HTTPError as e:return e.code,e.headers,e.read()

    def test_catalog_binary_slice_profile_and_file_origin_cors(self):
        status,headers,body=self.get("/api/catalog")
        self.assertEqual(status,200);self.assertEqual(headers["Access-Control-Allow-Origin"],"null")
        status,headers,body=self.get("/api/slice",self.args)
        data=json.loads(body);self.assertEqual(status,200)
        values=np.frombuffer(base64.b64decode(data["arrays"]["values"]),dtype="<f4")
        self.assertEqual(len(values),12);np.testing.assert_allclose(values,250,atol=.002)
        status,headers,body=self.get("/api/profile",dict(self.args,lat=0,lon=-45))
        self.assertEqual(status,200);self.assertEqual(len(json.loads(body)["levels"]),137)

    def test_cross_section_endpoint_returns_binary_samples_and_validates_waypoints(self):
        args = dict(self.args, axis="pressure", points=json.dumps([[0, 179], [0, -177], [6, -177]]))
        status, headers, body = self.get("/api/cross-section", args)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "null")
        result = json.loads(body)
        self.assertEqual(result["record"]["datetime"], "2016-09-25T03:00:00Z")
        self.assertEqual(result["encoding"], "base64-float32-le")
        values = np.frombuffer(base64.b64decode(result["values"]), dtype="<f4").reshape(result["shape"])
        self.assertEqual(len(result["waypoints"]), 3)
        self.assertGreater(np.isfinite(values).sum(), 0)
        np.testing.assert_allclose(values[np.isfinite(values)], 250, atol=.002)
        self.assertEqual(self.get("/api/cross-section", dict(args, points="invalid"))[0], 400)
        self.assertEqual(self.get("/api/cross-section", dict(args, points="[[0,0]]"))[0], 400)

    def test_missing_values_are_json_null_and_csv_blanks(self):
        args=dict(self.args,index=0,mode="model",value=100,lat=0,lon=180)
        status,headers,body=self.get("/api/profile",args)
        self.assertEqual(status,200)
        data=json.loads(body);self.assertIsNone(data["selected"]["t"])
        self.assertNotIn(b"NaN",body)
        status,headers,body=self.get("/api/export/profile",args)
        self.assertEqual(status,200);self.assertIn("attachment",headers["Content-Disposition"])
        self.assertEqual(len(body.decode().splitlines()),138)

    def test_bad_date_layer_and_untrusted_origin(self):
        self.assertEqual(self.get("/api/day",{"date":"2016-09-24"})[0],400)
        self.assertEqual(self.get("/api/slice",dict(self.args,value="nan"))[0],400)
        self.assertEqual(self.get("/api/slice",dict(self.args,file="../something.nc"))[0],400)
        self.assertEqual(self.get("/api/slice",dict(self.args,index=-1))[0],400)
        _,headers,_=self.get("/api/catalog",origin="https://example.com")
        self.assertNotIn("Access-Control-Allow-Origin",headers)

    def test_served_html_assets_only(self):
        self.assertEqual(self.get("/")[0],200)
        self.assertEqual(self.get("/web/app.js")[0],200)
        self.assertEqual(self.get("/server.py")[0],404)
        self.assertEqual(self.get("/web/../config.json")[0],404)
        self.assertEqual(self.get("/web/coastlines.js")[0],200)

    def test_layer_netcdf_is_downloaded_and_errors_are_json(self):
        status,headers,body=self.get("/api/export/layer.nc",dict(self.args,mode="model",value=137))
        self.assertEqual(status,200)
        self.assertEqual(headers["Content-Type"],"application/x-netcdf")
        self.assertTrue(headers["Content-Disposition"].endswith('.nc"'))
        self.assertEqual(body[:4],b"CDF\x02")
        self.assertEqual(self.get("/api/export/layer.nc",dict(self.args,index=-1))[0],400)
        self.assertEqual(self.get("/api/export/layer.nc",dict(self.args,variable="absent"))[0],400)

    def test_configuration_endpoint_exposes_effective_reader_settings_read_only(self):
        status,headers,body=self.get("/api/config")
        self.assertEqual(status,200)
        info=json.loads(body)
        self.assertEqual(info["version"],"1.3.0")
        self.assertEqual(info["settings"]["data_root"],str(self.archive.root))
        self.assertEqual(info["settings"]["port"],self.server.server_port)
        self.assertEqual(info["settings"]["cache_mb"],16)

    def test_drift_and_slice_csv(self):
        status,headers,body=self.get("/api/drift",dict(self.args,lat=0,lon=0,hours=1))
        self.assertEqual(status,200);self.assertEqual(len(json.loads(body)["path"]),31)
        status,headers,body=self.get("/api/export/slice",self.args)
        self.assertEqual(status,200);self.assertEqual(len(body.decode().splitlines()),13)
        self.assertIn(b"t [K]",body)


if __name__=="__main__":
    unittest.main()
