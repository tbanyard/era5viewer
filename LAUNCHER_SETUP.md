# ERA5Viewer Connect: maintainer setup

This is a **source add-on and native build workflow**, not an email-ready
application binary. Add it to the existing era5viewer repository. It creates
a separate companion application and does not replace the v1.4 viewer.

## What users will do

1. Connect to the normal Bath VPN, including its MFA, when off campus. Users
   already on the relevant university network can go straight to the launcher.
2. Download and extract their Windows, Mac or Linux application.
3. Open it, enter their Bath SSH username/password, and choose **Connect and
   open viewer**. The default browser opens `http://127.0.0.1:8769/`.
4. Keep the launcher running while viewing. Close it or choose Disconnect to
   close the SSH tunnel. The browser tab can be closed separately.

VPN access and permission to SSH into `eepc-0184.bath.ac.uk` are separate
requirements. The launcher does not bypass either. It uses a free local port
if 8769 is already occupied, and opens the corresponding URL automatically.

## One-time server prerequisites

An ERA5 reader must already be running on **eepc-0184.bath.ac.uk**, listening
on **127.0.0.1:8769**. Its data files stay on that machine. The launcher does
not copy the archive or start a remote reader. Ask the machine administrator
to keep the reader running as an approved service if it is shared by a group.
Each user needs an account permitted to SSH into this machine and create
local forwards to its reader (`AllowTcpForwarding`/`PermitOpen` policy).

Obtain the machine's **public SSH host fingerprint** over a trusted channel.
For example, inside an already trusted SSH session on that machine, run:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

Copy just `SHA256:...` from the output. It is public and safe to distribute;
it is not a password or a private key. The launcher checks it before
authenticating. Do not use an unverified key scan as the trust source.
If Ed25519 is not enabled, ask the machine administrator which host keys are
offered. Multiple verified fingerprints can be supplied, separated by spaces
or commas. The config/build never automatically trusts an unknown key.

## Add the source and workflow to GitHub

The zip contains `launcher/`, `.github/workflows/build-era5-launcher.yml`,
and this file. From your existing `era5viewer-git` clone, with the source zip
one directory above it:

```bash
unzip -o ../era5viewer_launcher_source.zip -d .
git add launcher LAUNCHER_SETUP.md .github/workflows/build-era5-launcher.yml
git diff --cached --stat
git commit -m "Add ERA5Viewer Connect desktop launcher"
git push origin main
```

These are new source files; the zip does not overwrite the viewer or the
root `.gitignore`. If GitHub asks for permission to update workflows, use
`gh auth refresh -s workflow` and retry the push with the appropriate account.

## Build the downloads

Create a separate launcher tag so its build can be reproduced without
changing the existing v1.4 tag:

```bash
git tag -a launcher-v0.1.0 -m "ERA5Viewer Connect 0.1.0"
git push origin launcher-v0.1.0
gh workflow run build-era5-launcher.yml --ref launcher-v0.1.0 \
  -f 'server_fingerprint=SHA256:REPLACE_WITH_VERIFIED_PUBLIC_FINGERPRINT'
```

Replace the placeholder. Supply fingerprints only, never a Bath password.
Alternatively, open the repository's Actions tab, select **Build ERA5Viewer
Connect**, choose the launcher tag, and fill in **Run workflow**.

The workflow builds on Windows, macOS and Linux themselves, runs local
encrypted-SSH/HTTP tests, and checks the packaged GUI and configuration.
It has read-only repository permissions and uploads build artifacts; it does
not publish a release or change the repository. No Bath VPN connection or
university credentials are needed on GitHub's runners. The fingerprint is
embedded in the application built in that run, not committed by the workflow.

Downloads are built for:

| System | Download |
| --- | --- |
| Windows, Intel/AMD 64-bit | `ERA5ViewerConnect-Windows-x64.zip` |
| Mac, Intel | `ERA5ViewerConnect-macOS-x64.zip` |
| Mac, Apple Silicon | `ERA5ViewerConnect-macOS-arm64.zip` |
| Linux, Intel/AMD 64-bit | `ERA5ViewerConnect-Linux-x64.tar.gz` |
| Linux, ARM64 | `ERA5ViewerConnect-Linux-arm64.tar.gz` |

Linux builds use Ubuntu 22.04 as their baseline and require a graphical
desktop and its usual X11/XWayland libraries. This is not a claim to support
every Linux distribution or older libc. Windows ARM is not a native build
target. The Mac build runners use macOS 15; older macOS versions require
their own compatibility testing. Test on your users' actual OS versions.

Wait for all five jobs to succeed. Then find the run ID and download its
artifacts:

```bash
gh run list --workflow build-era5-launcher.yml --limit 5
gh run watch RUN_ID
gh run download RUN_ID --dir launcher-artifacts
```

Replace `RUN_ID` with the run you started. The folders contain the native
archives and SHA256 checksums. These are the files for users, rather than
this source zip.

## Sign, test and distribute

These builds are **unsigned development downloads** (macOS has a development
ad-hoc signature). A no-warning, managed-device rollout needs Bath IT approval
and appropriate Windows signing and Apple Developer ID signing/notarization.
Those require the maintainer's/organisation's accounts and certificates and
are not configured here. Do not ask users to disable security protections.
Perform signing/notarization before distributing the native archives, and
regenerate their `.sha256` files if the signed archives change.

Test a completed native build with a real SSH-enabled Bath account on each
target OS: normal VPN/MFA, bad password, normal login, browser opening, more
than one user, closing/disconnecting, a busy local port, and VPN dropping.
This workspace can test the forwarding engine but cannot connect to Bath's
private server or validate all native desktop builds.

For a small initial trial, after testing and any required signing, attach
the native downloads to a separate release:

```bash
gh release create launcher-v0.1.0 \
  launcher-artifacts/*/*.zip \
  launcher-artifacts/*/*.tar.gz \
  launcher-artifacts/*/*.sha256 \
  --verify-tag --title "ERA5Viewer Connect 0.1.0" \
  --notes-file launcher/RELEASE_NOTES.md --latest=false
```

This uses `--notes-file`, so it does not have the earlier `--notes-from-tag`
and `--repo` compatibility issue. The viewer's v1.4 release stays Latest.
Use the GitHub Releases download links in email; executable attachments can
be blocked by recipients' email or managed-device policies. Send users the
appropriate OS link and the short `launcher/USER_GUIDE.txt` instructions.

## Local development and rebuilding

Use Python 3.10+ with Tk support for source development, or Python 3.12 to
match the provided workflow:

```bash
python -m pip install -r launcher/requirements-build.txt
python -m unittest discover -s launcher/tests -v
python launcher/build.py --fingerprint 'SHA256:VERIFIED_PUBLIC_FINGERPRINT'
```

This builds on your current OS only. Linux may need its distribution's
`python3-tk`/Tcl/Tk development packages. The Python installation used for the
build must be able to `import tkinter`; installing a toolkit for a different
Python installation is insufficient. Output is under `launcher/release/`.
The original pinned configuration is intentionally empty until a verified
fingerprint is supplied. No placeholder host key is trusted.

If the server key legitimately changes, verify the replacement with the
administrator and rebuild/reissue the launcher. Never automatically accept
a changed key. Passwords and OTP answers are held only during authentication;
no credential cache, command-line password, telemetry, or password log is used.

## Validation in this workspace

18 integration and configuration tests passed in this workspace. The
integration suite uses a real local Paramiko SSH server and a local HTTP
reader fixture. It exercises authentication, fingerprint rejection before
credentials, large binary transfers, simultaneous channels, half-close,
port conflicts, disconnect cleanup, cancellation and interactive password/OTP.
All test credentials are synthetic. The bundled GUI/native build checks are
part of the GitHub workflow and remain to be run on those platforms. This
workspace's Python cannot load its Tk shared library, so GUI QA was not run
here. No university login, VPN integration or code signing has been tested.

Reference guidance:

- [Bath VPN setup](https://www.bath.ac.uk/guides/setting-up-vpn-on-your-device/)
- [Bath MFA](https://www.bath.ac.uk/guides/multi-factor-authentication-mfa-at-the-university/)
- [PyInstaller platform builds](https://pyinstaller.org/en/stable/)
- [Paramiko transport authentication](https://docs.paramiko.org/en/stable/api/transport.html)
