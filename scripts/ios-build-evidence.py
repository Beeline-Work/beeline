"""Record the identity embedded in the IPA, before accepting any upload receipt."""
import hashlib
import json
import plistlib
import re
import sys
import zipfile
from pathlib import Path


def record(ipa_path, output_path):
    root = Path(__file__).resolve().parent.parent
    version = json.loads((root / "apps/mobile/package.json").read_text())["version"]
    runtime = json.loads((root / "apps/mobile/native-fingerprint.json").read_text())["ios"]["runtimeVersion"]
    with zipfile.ZipFile(ipa_path) as archive:
        plists = [name for name in archive.namelist() if re.fullmatch(r"Payload/[^/]+\.app/Info\.plist", name)]
        if len(plists) != 1:
            raise ValueError("IPA must contain exactly one main app Info.plist")
        info = plistlib.loads(archive.read(plists[0]))
        expo = plistlib.loads(archive.read(plists[0].replace("Info.plist", "Expo.plist")))
    if info.get("CFBundleIdentifier") != "app.usebeeline.mobile":
        raise ValueError("IPA has the wrong iOS bundle identifier")
    if info.get("CFBundleShortVersionString") != version:
        raise ValueError("IPA version does not match apps/mobile/package.json")
    build_number = info.get("CFBundleVersion", "")
    if not re.fullmatch(r"\d+(\.\d+){0,2}", build_number):
        raise ValueError("IPA has no valid build number")
    if expo.get("EXUpdatesRuntimeVersion") != runtime:
        raise ValueError("IPA runtime does not match the committed iOS native pin")
    if not isinstance(info.get("NSPhotoLibraryUsageDescription"), str) or not info["NSPhotoLibraryUsageDescription"].strip():
        raise ValueError("IPA lacks NSPhotoLibraryUsageDescription; Apple rejects it with 90683")
    sha256 = hashlib.sha256(Path(ipa_path).read_bytes()).hexdigest()
    evidence = {
        "source": "local", "status": "FINISHED", "id": f"local-{sha256}",
        "artifacts": {"path": ipa_path}, "sha256": sha256,
        "bundleId": info["CFBundleIdentifier"], "appVersion": version,
        "buildNumber": build_number, "runtimeVersion": runtime,
    }
    Path(output_path).write_text(json.dumps(evidence) + "\n")
    print(f"IPA verified: {evidence['bundleId']} {version} ({build_number}), iOS runtime {runtime}")


if __name__ == "__main__":
    record(*sys.argv[1:])
