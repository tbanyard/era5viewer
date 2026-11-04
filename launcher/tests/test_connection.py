"""Real local SSH and HTTP fixtures; no university connection or account used."""
from dataclasses import replace
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import logging
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import paramiko
from core import Cancelled, ConfigurationError, Connection, ConnectionError, Settings, fingerprint, valid_fingerprint


class Reader(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if getattr(self.server,"redirect",False):
            self.send_response(302)
            self.send_header("Location","http://example.invalid/unexpected")
            self.end_headers()
            return
        body = json.dumps({"version": "1.4.0", "settings": {"port": self.server.server_port}}).encode()
        body=getattr(self.server,"override",body)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class Auth(paramiko.ServerInterface):
    def __init__(self, owner):
        self.owner = owner
        self.destinations = {}

    def get_allowed_auths(self, username):
        return "keyboard-interactive" if self.owner.interactive else "password"

    def check_auth_password(self, username, password):
        self.owner.auth_attempts += 1
        if self.owner.interactive:
            return paramiko.AUTH_FAILED
        return paramiko.AUTH_SUCCESSFUL if (username, password) == ("fixture-user", "fixture-password") else paramiko.AUTH_FAILED

    def check_auth_interactive(self, username, submethods):
        return paramiko.InteractiveQuery("Fixture sign-in", "Enter the synthetic test credentials.", ("Password", False), ("One-time code", False))

    def check_auth_interactive_response(self, responses):
        return paramiko.AUTH_SUCCESSFUL if responses == ["fixture-password", "123456"] else paramiko.AUTH_FAILED

    def check_channel_direct_tcpip_request(self, chanid, origin, destination):
        if destination != ("127.0.0.1", self.owner.reader.server_port):
            return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED
        self.destinations[chanid] = destination
        return paramiko.OPEN_SUCCEEDED


class SSHFixture:
    def __init__(self, host_key, *, interactive=False):
        self.host_key = host_key
        self.interactive = interactive
        self.auth_attempts = 0
        self.reader = ThreadingHTTPServer(("127.0.0.1", 0), Reader)
        threading.Thread(target=lambda: self.reader.serve_forever(poll_interval=.05), daemon=True).start()
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(5)
        self.listener.settimeout(.2)
        self.port = self.listener.getsockname()[1]
        self.stopped = threading.Event()
        self.transports = []
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self):
        while not self.stopped.is_set():
            try:
                sock, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            threading.Thread(target=self.session, args=(sock,), daemon=True).start()

    def session(self, sock):
        transport = paramiko.Transport(sock)
        self.transports.append(transport)
        transport.add_server_key(self.host_key)
        auth = Auth(self)
        try:
            transport.start_server(server=auth)
            while transport.is_active() and not self.stopped.is_set():
                channel = transport.accept(.2)
                if channel:
                    threading.Thread(target=self.bridge, args=(channel, auth.destinations[channel.chanid]), daemon=True).start()
        except (OSError, EOFError, paramiko.SSHException):
            pass
        finally:
            transport.close()

    @staticmethod
    def bridge(channel, destination):
        remote = socket.create_connection(destination, timeout=3)
        def copy(src, dst):
            try:
                while True:
                    data = src.recv(65536)
                    if not data:
                        if isinstance(dst, socket.socket):
                            dst.shutdown(socket.SHUT_WR)
                        else:
                            dst.shutdown_write()
                        return
                    dst.sendall(data)
            except (OSError, EOFError, paramiko.SSHException):
                pass
        outgoing = threading.Thread(target=copy, args=(channel, remote), daemon=True)
        outgoing.start()
        copy(remote, channel)
        outgoing.join(2)
        remote.close()
        try:
            channel.close()
        except (OSError,EOFError,paramiko.SSHException):
            pass

    def close(self):
        self.stopped.set()
        self.listener.close()
        for transport in self.transports:
            transport.close()
        self.thread.join(1)
        self.reader.shutdown()
        self.reader.server_close()


class ConnectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key = paramiko.RSAKey.generate(2048)
        cls.logger=logging.getLogger("paramiko")
        cls.previous_level=cls.logger.level
        cls.logger.setLevel(logging.CRITICAL)

    @classmethod
    def tearDownClass(cls):
        cls.logger.setLevel(cls.previous_level)

    def setUp(self):
        self.fixture = SSHFixture(self.key)
        with socket.socket() as spare:
            spare.bind(("127.0.0.1", 0))
            local_port = spare.getsockname()[1]
        self.settings = Settings("127.0.0.1", self.fixture.port, self.fixture.reader.server_port, local_port, (fingerprint(self.key),))
        self.connection = Connection(self.settings)

    def tearDown(self):
        self.connection.close()
        self.fixture.close()

    def connect(self):
        return self.connection.connect("fixture-user", "fixture-password")

    def test_real_encrypted_forwarding_and_reader_check(self):
        self.connect()
        self.assertTrue(self.connection.is_active)
        self.assertEqual(self.connection.reader_info["version"], "1.4.0")
        self.assertEqual(self.connection.server.server_address[0], "127.0.0.1")
        self.assertEqual(self.connection.server.server_address[1], self.settings.local_port)
        self.assertIsNone(getattr(self.connection.transport.auth_handler,"password",None))

    def test_large_binary_request_and_response(self):
        self.connect()
        payload = bytes(range(256)) * 8192
        request = urllib.request.Request(self.connection.url, data=payload, method="POST")
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=10) as response:
            self.assertEqual(response.read(), payload)

    def test_parallel_reader_requests_use_independent_channels(self):
        self.connect()
        def fetch(index):
            opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(self.connection.url+"api/config",timeout=8) as response:
                return json.load(response)["version"]
        with ThreadPoolExecutor(max_workers=6) as pool:
            self.assertEqual(list(pool.map(fetch,range(12))),["1.4.0"]*12)

    def test_local_half_close_keeps_reader_response(self):
        self.connect()
        with socket.create_connection(self.connection.server.server_address, timeout=5) as sock:
            sock.sendall(b"GET /api/config HTTP/1.0\r\nHost: localhost\r\n\r\n")
            sock.shutdown(socket.SHUT_WR)
            chunks = []
            while True:
                data = sock.recv(4096)
                if not data:
                    break
                chunks.append(data)
        self.assertIn(b'"version": "1.4.0"', b"".join(chunks))

    def test_wrong_host_key_rejects_before_password(self):
        self.connection = Connection(replace(self.settings, ssh_host_fingerprints=("SHA256:" + "A" * 43,)))
        with self.assertRaisesRegex(ConnectionError, "identity does not match"):
            self.connect()
        self.assertEqual(self.fixture.auth_attempts, 0)
        self.assertIsNone(self.connection.server)

    def test_no_pin_never_connects_or_authenticates(self):
        self.connection = Connection(replace(self.settings, ssh_host_fingerprints=()))
        with self.assertRaises(ConfigurationError):
            self.connect()
        self.assertEqual(self.fixture.auth_attempts, 0)

    def test_bad_password_never_opens_listener(self):
        with self.assertRaisesRegex(ConnectionError, "Sign-in was not accepted"):
            self.connection.connect("fixture-user", "wrong-fixture-password")
        self.assertIsNone(self.connection.server)
        self.assertEqual(self.fixture.auth_attempts, 1)

    def test_port_conflict_uses_owned_free_port(self):
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", self.settings.local_port))
            occupied.listen()
            self.connect()
            self.assertNotEqual(self.connection.server.server_address[1], self.settings.local_port)
            self.assertIn(str(self.connection.server.server_address[1]), self.connection.url)

    def test_disconnect_releases_listener(self):
        self.connect()
        address = self.connection.server.server_address
        self.connection.close()
        self.assertFalse(self.connection.is_active)
        with self.assertRaises(OSError):
            socket.create_connection(address, timeout=1)
        self.connection.close()

    def test_pre_cancelled_connection_never_authenticates(self):
        self.connection.close()
        with self.assertRaises(Cancelled):
            self.connect()
        self.assertEqual(self.fixture.auth_attempts, 0)
        self.assertEqual(self.fixture.transports, [])

    def test_wrong_remote_service_is_not_opened_in_browser(self):
        self.fixture.reader.override=b"<html>A different service</html>"
        with self.assertRaisesRegex(ConnectionError,"ERA5 Viewer is not responding"):
            self.connect()
        self.assertIsNone(self.connection.server)

    def test_reader_redirect_is_not_followed(self):
        self.fixture.reader.redirect=True
        with self.assertRaisesRegex(ConnectionError,"ERA5 Viewer is not responding"):
            self.connect()

    def test_invalid_username_is_rejected_before_network(self):
        with self.assertRaisesRegex(ConnectionError,"without @bath.ac.uk"):
            self.connection.connect("user@bath.ac.uk","fixture-password")
        self.assertEqual(self.fixture.transports,[])

    def test_interactive_password_and_otp(self):
        self.fixture.interactive = True
        questions = []
        def challenge(title, instructions, prompts):
            questions.extend(prompts)
            return ["fixture-password", "123456"]
        self.connection = Connection(self.settings, challenge=challenge)
        self.connect()
        self.assertTrue(self.connection.is_active)
        self.assertEqual([p[0] for p in questions], ["Password", "One-time code"])

    def test_interactive_cancel(self):
        self.fixture.interactive = True
        self.connection = Connection(self.settings, challenge=lambda *args: None)
        with self.assertRaises(Cancelled):
            self.connect()
        self.assertIsNone(self.connection.server)


class ConfigurationTests(unittest.TestCase):
    def test_unconfigured_source_is_rejected_for_distribution(self):
        source = Path(__file__).resolve().parents[1] / "launcher_config.json"
        settings = Settings.load(source, require_pin=False)
        self.assertEqual(settings.ssh_host, "eepc-0184.bath.ac.uk")
        self.assertEqual(settings.local_port, 8769)

    def test_fingerprint_format(self):
        self.assertTrue(valid_fingerprint("SHA256:" + "A" * 43))
        for value in ("", "MD5:AA:BB", "SHA256:" + "A" * 42, None, "SHA256:" + "A" * 43 + "=", "SHA256:fake"):
            self.assertFalse(valid_fingerprint(value))

    def test_strict_settings(self):
        values = {"ssh_host": "example.invalid", "ssh_port": 22, "reader_port": 8769, "local_port": 8769, "ssh_host_fingerprints": ["SHA256:" + "A" * 43]}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text(json.dumps(values), encoding="utf-8")
            self.assertEqual(Settings.load(path).reader_port, 8769)
            for key, value in (("ssh_host", "host; command"), ("ssh_port", 0), ("local_port", 80), ("reader_port", True), ("ssh_host_fingerprints", [])):
                path.write_text(json.dumps({**values, key: value}), encoding="utf-8")
                with self.subTest(key=key), self.assertRaises(ConfigurationError):
                    Settings.load(path)


if __name__ == "__main__":
    unittest.main()
