"""Pinned SSH connection and loopback-only forwarding for ERA5Viewer Connect.

No subprocess receives a password. No credentials are persisted or logged.
The remote destination is always the SSH server's loopback interface.
"""
from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
import errno
import hashlib
import hmac
import json
from pathlib import Path
import re
import select
import socket
import socketserver
import threading
import urllib.error
import urllib.request

import paramiko

VPN_HELP = "https://www.bath.ac.uk/guides/setting-up-vpn-on-your-device/"
APP_VERSION = "0.1.1"


class ConnectionError(Exception):
    """An error safe to show in the connection window."""


class ConfigurationError(ConnectionError):
    pass


class Cancelled(ConnectionError):
    pass


def valid_fingerprint(value):
    if not isinstance(value, str) or not re.fullmatch(r"SHA256:[A-Za-z0-9+/]{43}", value):
        return False
    try:
        return len(base64.b64decode(value[7:] + "=", validate=True)) == 32
    except (ValueError, binascii.Error):
        return False


def fingerprint(key):
    return "SHA256:" + base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip("=")


def _quiet_close(resource):
    if resource is not None:
        try:
            resource.close()
        except (OSError, EOFError, paramiko.SSHException):
            pass


@dataclass(frozen=True)
class Settings:
    ssh_host: str
    ssh_port: int
    reader_port: int
    local_port: int
    ssh_host_fingerprints: tuple[str, ...]

    @classmethod
    def load(cls, path=None, *, require_pin=True):
        path = Path(path) if path else Path(__file__).with_name("launcher_config.json")
        try:
            if path.stat().st_size > 16384:
                raise ValueError("Configuration is too large.")
            values = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise ConfigurationError("The launcher's connection settings could not be read.") from exc
        if not isinstance(values, dict) or set(values) != set(cls.__dataclass_fields__):
            raise ConfigurationError("The launcher has invalid connection settings.")
        host = values["ssh_host"]
        if not isinstance(host, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]{0,252}", host):
            raise ConfigurationError("The configured SSH hostname is invalid.")
        for name in ("ssh_port", "reader_port", "local_port"):
            value = values[name]
            low = 1024 if name == "local_port" else 1
            if type(value) is not int or not low <= value <= 65535:
                raise ConfigurationError("The configured ports are invalid.")
        pins = values["ssh_host_fingerprints"]
        if not isinstance(pins, list) or len(pins) > 16 or not all(valid_fingerprint(p) for p in pins):
            raise ConfigurationError("The configured SSH server fingerprints are invalid.")
        if require_pin and not pins:
            raise ConfigurationError("This launcher needs its server identity configured by the maintainer before distribution.")
        return cls(host, values["ssh_port"], values["reader_port"], values["local_port"], tuple(pins))


class _ForwardServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = False
    request_queue_size = 32

    def handle_error(self, request, client_address):
        # A failed request must never print network/authentication internals.
        pass


class _ForwardHandler(socketserver.BaseRequestHandler):
    def handle(self):
        owner = self.server.owner
        channel = None
        if owner.cancelled.is_set():
            return
        transport=owner.transport
        if transport is None:
            return
        try:
            channel = transport.open_channel(
                "direct-tcpip", ("127.0.0.1", owner.settings.reader_port),
                self.client_address, timeout=8,
            )
            with owner._lock:
                if owner.cancelled.is_set():
                    _quiet_close(channel)
                    return
                owner._streams.add(self.request)
                owner._streams.add(channel)
            self.request.settimeout(2)
            channel.settimeout(2)
            reading_local = reading_remote = True
            while not owner.cancelled.is_set() and (reading_local or reading_remote):
                readers = ([self.request] if reading_local else []) + ([channel] if reading_remote else [])
                ready, _, _ = select.select(readers, [], [], .3)
                if self.request in ready:
                    data = self.request.recv(65536)
                    if data:
                        channel.sendall(data)
                    else:
                        reading_local = False
                        channel.shutdown_write()
                if channel in ready:
                    data = channel.recv(65536)
                    if data:
                        self.request.sendall(data)
                    else:
                        reading_remote = False
                        try:
                            self.request.shutdown(socket.SHUT_WR)
                        except OSError:
                            pass
        except (OSError, EOFError, ValueError, paramiko.SSHException):
            pass
        finally:
            with owner._lock:
                owner._streams.discard(self.request)
                owner._streams.discard(channel)
            if channel is not None:
                _quiet_close(channel)


class Connection:
    """One SSH transport and one ephemeral local listener; safe to cancel."""

    def __init__(self, settings, status=lambda text: None, challenge=None):
        self.settings = settings
        self.status = status
        self.challenge = challenge
        self.cancelled = threading.Event()
        self._lock = threading.Lock()
        self._streams = set()
        self.sock = self.transport = self.server = self._thread = None
        self.url = None
        self.reader_info = None

    def _check_cancelled(self):
        if self.cancelled.is_set():
            raise Cancelled("Connection cancelled.")

    def _install(self, name, resource):
        with self._lock:
            if self.cancelled.is_set():
                _quiet_close(resource)
                raise Cancelled("Connection cancelled.")
            setattr(self, name, resource)

    def connect(self, username, password):
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", username or ""):
            raise ConnectionError("Enter your Bath username, without @bath.ac.uk.")
        if not self.settings.ssh_host_fingerprints:
            raise ConfigurationError("The server identity has not been configured.")
        transport=None
        try:
            self._check_cancelled()
            self.status("Checking the connection to Bath…")
            self._install("sock", socket.create_connection((self.settings.ssh_host, self.settings.ssh_port), timeout=8))
            self._check_cancelled()
            self.status("Verifying the server…")
            transport = paramiko.Transport(self.sock)
            transport.banner_timeout = 10
            transport.auth_timeout = 60
            self._install("transport", transport)
            transport.start_client(timeout=12)
            self._check_cancelled()
            actual = fingerprint(transport.get_remote_server_key())
            if not any(hmac.compare_digest(actual, pin) for pin in self.settings.ssh_host_fingerprints):
                raise ConnectionError("The server identity does not match this launcher. Your password was not sent. Ask the maintainer to check the SSH host key.")
            self.status("Signing in securely…")
            try:
                remaining = transport.auth_password(username, password, fallback=False)
            except paramiko.BadAuthenticationType as exc:
                remaining = exc.allowed_types
            self._check_cancelled()
            if not transport.is_authenticated() and "keyboard-interactive" in (remaining or []):
                if self.challenge is None:
                    raise ConnectionError("This server needs an additional sign-in step. Use the desktop launcher to answer it.")
                transport.auth_interactive(username, self._interactive)
            if not transport.is_authenticated():
                raise ConnectionError("The server could not complete sign-in with this account. Check that password or interactive SSH login is enabled.")
            password = None
            transport.set_keepalive(20)
            self._check_cancelled()
            self.status("Opening the local connection…")
            self._start_forwarder()
            self._check_cancelled()
            self.status("Checking that ERA5 Viewer is running…")
            self.reader_info = self.check_reader()
            self._check_cancelled()
            self.status("Connected")
            return self
        except Cancelled:
            self.close()
            raise
        except paramiko.AuthenticationException as exc:
            self.close()
            raise ConnectionError("Sign-in was not accepted. Check your Bath username and password, and that your account can SSH to this computer.") from exc
        except ConnectionError:
            self.close()
            raise
        except (OSError, EOFError, paramiko.SSHException) as exc:
            self.close()
            raise ConnectionError("Could not connect to the Bath computer. Connect to the Bath VPN and try again. If you are already connected, check that the computer and SSH service are available.") from exc
        finally:
            # Paramiko's authentication helper can otherwise retain the password
            # for the life of an authenticated transport. Drop that reference.
            helper=getattr(transport,"auth_handler",None)
            if helper is not None and hasattr(helper,"password"):
                helper.password=None
            password = None

    def _interactive(self, title, instructions, prompts):
        self._check_cancelled()
        if len(prompts) > 8:
            raise ConnectionError("The server requested too many sign-in fields.")
        # The GUI callback runs the dialog on its own main thread.
        answers = self.challenge(title[:120], instructions[:1000], [(p[:300], echo) for p, echo in prompts])
        self._check_cancelled()
        if answers is None or len(answers) != len(prompts):
            raise Cancelled("Sign-in cancelled.")
        return answers

    def _start_forwarder(self):
        address = ("127.0.0.1", self.settings.local_port)
        try:
            server = _ForwardServer(address, _ForwardHandler)
        except OSError as exc:
            if exc.errno not in (errno.EADDRINUSE, 10048):
                raise
            server = _ForwardServer(("127.0.0.1", 0), _ForwardHandler)
        server.owner = self
        with self._lock:
            if self.cancelled.is_set():
                server.server_close()
                raise Cancelled("Connection cancelled.")
            self.server = server
            self.url = "http://127.0.0.1:" + str(server.server_address[1]) + "/"
            self._thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=.1), daemon=True)
            self._thread.start()

    def check_reader(self):
        # Do not route localhost through a system HTTP proxy or follow redirects.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        try:
            with opener.open(self.url + "api/config", timeout=8) as response:
                body = response.read(65537)
            if len(body) > 65536:
                raise ValueError("Large reader response")
            info = json.loads(body)
            if not isinstance(info, dict) or not isinstance(info.get("version"), str) or not isinstance(info.get("settings"), dict):
                raise ValueError("Not an ERA5 reader")
            return info
        except (OSError, ValueError, urllib.error.URLError) as exc:
            raise ConnectionError("SSH sign-in worked, but ERA5 Viewer is not responding on the remote computer's port " + str(self.settings.reader_port) + ". Ask the maintainer to start the reader. Closing and reconnecting here will not start it remotely.") from exc

    @property
    def is_active(self):
        transport=self.transport
        return not self.cancelled.is_set() and transport is not None and transport.is_active() and transport.is_authenticated()

    def close(self):
        self.cancelled.set()
        with self._lock:
            server, self.server = self.server, None
            transport, self.transport = self.transport, None
            sock, self.sock = self.sock, None
            streams, self._streams = tuple(self._streams), set()
        for stream in streams:
            _quiet_close(stream)
        _quiet_close(transport)
        _quiet_close(sock)
        if server is not None:
            server.shutdown()
            server.server_close()
