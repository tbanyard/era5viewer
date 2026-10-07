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

    def test_drift_and_slice_csv(self):
        status,headers,body=self.get("/api/drift",dict(self.args,lat=0,lon=0,hours=1))
        self.assertEqual(status,200);self.assertEqual(len(json.loads(body)["path"]),31)
        status,headers,body=self.get("/api/export/slice",self.args)
        self.assertEqual(status,200);self.assertEqual(len(body.decode().splitlines()),13)
        self.assertIn(b"t [K]",body)


if __name__=="__main__":
    unittest.main()
