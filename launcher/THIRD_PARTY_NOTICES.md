# ERA5Viewer Connect dependencies

The launcher is a companion to https://github.com/tbanyard/era5viewer and uses
the project's MIT licence. All launcher sources and build instructions are
included with each native download so the launcher can be rebuilt.

It uses Python and Tcl/Tk, Paramiko, cryptography, bcrypt, PyNaCl, CFFI, and
their dependencies. PyInstaller packages the executable. These components
retain their own licences; dependency licence files are copied into the native
download's `licenses` directory. Installed Python distribution metadata is
also retained where needed by the bundler.

- Python: https://docs.python.org/3/license.html
- Tcl/Tk: https://www.tcl-lang.org/software/tcltk/license.html
- Paramiko (LGPL): https://github.com/paramiko/paramiko
- cryptography: https://github.com/pyca/cryptography
- bcrypt: https://github.com/pyca/bcrypt
- PyNaCl: https://github.com/pyca/pynacl
- CFFI: https://cffi.readthedocs.io/
- PyInstaller, with its bootloader exception: https://pyinstaller.org/

Server host fingerprints are public identifiers, not private keys. No Bath
passwords, VPN profiles, university certificates or SSH private keys belong
in the source repository or release assets.
