"""Guard the native-linkage check against the actual macOS failure mode."""
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from build import verify_macos_crypto


class MacCryptoLinkageTests(unittest.TestCase):
    def check_output(self,dependencies):
        return patch("build.subprocess.check_output",return_value="/fixture/_rust.abi3.so:\n"+dependencies)

    @patch("build.find_spec",return_value=SimpleNamespace(origin="/fixture/_rust.abi3.so"))
    def test_static_binding_accepts_system_runtime_only(self,spec):
        with self.check_output("\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n"):
            verify_macos_crypto()

    @patch("build.find_spec",return_value=SimpleNamespace(origin="/fixture/_rust.abi3.so"))
    def test_rpath_ssl_rejects_original_collision(self,spec):
        with self.check_output("\t@rpath/libssl.3.dylib (compatibility version 3.0.0)\n"):
            with self.assertRaisesRegex(RuntimeError,"OPENSSL_STATIC=1"):
                verify_macos_crypto()

    @patch("build.find_spec",return_value=SimpleNamespace(origin="/fixture/_rust.abi3.so"))
    def test_absolute_crypto_library_also_rejected(self,spec):
        with self.check_output("\t/usr/local/opt/openssl@3/lib/libcrypto.3.dylib (compatibility version 3.0.0)\n"):
            with self.assertRaisesRegex(RuntimeError,"shared OpenSSL"):
                verify_macos_crypto()
