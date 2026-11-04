"""Build on the target operating system. Never supplies a sign-in password."""
import argparse
import hashlib
from importlib import metadata
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tarfile

from core import Settings, valid_fingerprint

ROOT = Path(__file__).resolve().parent
NAME = "ERA5ViewerConnect"


def collect_licenses(destination):
    for name in ("paramiko", "cryptography", "bcrypt", "PyNaCl", "cffi", "pycparser", "pyinstaller", "altgraph", "packaging", "invoke"):
        try:
            dist = metadata.distribution(name)
        except metadata.PackageNotFoundError:
            continue
        for entry in dist.files or []:
            if not any(word in str(entry).lower() for word in ("license", "copying", "notice")):
                continue
            source = Path(dist.locate_file(entry))
            if source.is_file():
                target = destination / name / str(entry).replace("/", "_").replace("\\", "_")
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
    if not (destination / "paramiko").is_dir():
        raise RuntimeError("The Paramiko licence was not collected; refusing to package an incomplete download.")
    for name in ("LICENSE", "LICENSE.txt"):
        candidate = Path(sys.base_prefix) / name
        if candidate.is_file():
            destination.mkdir(parents=True, exist_ok=True)
            shutil.copy2(candidate, destination / ("Python-" + name))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fingerprint", help="Verified public SHA256 SSH host fingerprint")
    parser.add_argument("--fingerprint-from-env", action="store_true")
    args = parser.parse_args()
    pin = os.environ.get("SSH_HOST_FINGERPRINT", "") if args.fingerprint_from_env else args.fingerprint
    if args.fingerprint_from_env or args.fingerprint is not None:
        pin = (pin or "").strip()
        pins=[part for part in re.split(r"[\s,]+",pin) if part]
        if not pins or not all(valid_fingerprint(part) for part in pins):
            parser.error("Supply the verified SHA256:... fingerprint(s), separated by spaces or commas.")
        config = ROOT / "launcher_config.json"
        Settings.load(config, require_pin=False)
        values = json.loads(config.read_text(encoding="utf-8"))
        values["ssh_host_fingerprints"] = list(dict.fromkeys(pins))
        config.write_text(json.dumps(values, indent=2) + "\n", encoding="utf-8")
    Settings.load()
    # Importing Tk fails early if the build Python lacks the GUI toolkit.
    import tkinter
    import _tkinter
    build, dist, release = (ROOT / name for name in ("build", "dist", "release"))
    build.mkdir(exist_ok=True)
    release.mkdir(exist_ok=True)
    command = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir", "--windowed",
        "--name", NAME, "--distpath", str(dist), "--workpath", str(build / "work"),
        "--specpath", str(build), "--paths", str(ROOT), "--copy-metadata", "paramiko",
        "--add-data", str(ROOT / "launcher_config.json") + os.pathsep + "."]
    if sys.platform == "darwin":
        command.extend(["--osx-bundle-identifier", "io.github.tbanyard.era5viewerconnect"])
    command.append(str(ROOT / "app.py"))
    subprocess.run(command, check=True)
    bundle = dist / (NAME + ".app" if sys.platform == "darwin" else NAME)
    documents = bundle / "Contents" / "Resources" if sys.platform == "darwin" else bundle
    documents.mkdir(parents=True, exist_ok=True)
    for name in ("USER_GUIDE.txt", "THIRD_PARTY_NOTICES.md"):
        shutil.copy2(ROOT / name, documents / name)
    project_license = ROOT.parent / "LICENSE"
    if not project_license.exists():
        project_license=ROOT / "LICENSE"
    if project_license.exists():
        shutil.copy2(project_license, documents / "LICENSE")
    source = documents / "launcher-source"
    source.mkdir(exist_ok=True)
    for file in ROOT.iterdir():
        if file.is_file() and (file.suffix in (".py", ".json", ".txt", ".md") or file.name=="LICENSE"):
            shutil.copy2(file, source / file.name)
    collect_licenses(documents / "licenses")
    if sys.platform == "darwin":
        # Additional resources change the bundle seal. This development signature
        # is not a Developer ID signature or notarization for public rollout.
        subprocess.run(["codesign", "--force", "--deep", "--sign", "-", str(bundle)], check=True)
    architecture = "arm64" if platform.machine().lower() in ("arm64", "aarch64") else "x64"
    os_name = {"win32": "Windows", "darwin": "macOS"}.get(sys.platform, "Linux")
    stem = NAME + "-" + os_name + "-" + architecture
    if sys.platform == "darwin":
        archive = release / (stem + ".zip")
        subprocess.run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(bundle), str(archive)], check=True)
    elif sys.platform == "win32":
        archive = Path(shutil.make_archive(str(release / stem), "zip", root_dir=dist, base_dir=NAME))
    else:
        archive = release / (stem + ".tar.gz")
        with tarfile.open(archive, "w:gz") as tar:
            tar.add(bundle, arcname=NAME)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_name(archive.name + ".sha256").write_text(digest + "  " + archive.name + "\n", encoding="utf-8")
    print("Built", archive)


if __name__ == "__main__":
    main()
