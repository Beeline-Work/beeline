"""One-time reviewed bootstrap. Install pinned bytes, then the narrow polkit rule."""
import hashlib
import os
from pathlib import Path
import subprocess
import types

SOURCE = Path(__file__).resolve().parent
# Generated only after editing/testing payloads; freeze on approval request.
PINS = {'sync.py': '1d8badfc2b60a1379d1354add007799a9b6ac0689d79bb7370e331e726732339', 'sync': 'acd431149d07997e2cb9607ea922f0fae97f88769f1270f5131c5c4c9058158f', 'beeline-ci-sync.service': '1031a5d30077dbb4825c52b96f432d680293ea50dc58b71c003e142de743847a', '00-beeline-ci.rules': 'a7b6a510c10d0a68b8a4c940a1d3d52ec8fae33444e351cecfcf6950e9c1884b', 'runtime/broker.py': 'a416af17af98a1e79d8017f7fe03ddfc0dac2c97d0732ad2d47a4aedf6d1926e', 'runtime/entry.py': '9d0fe031953f837039b34b2414cc8322da232985f9853ce4c02af8e7d7a94822', 'runtime/prepare.py': '036637d8cbd6900f70a96ed567f8a3cc9b0489adea5d6249d91a8756cb3a8018', 'units/beeline-ci-registration.service': '530746526d6e6b519c8b6f806e2c6896d42af871623b1b19ddd6c6936f507d4f', 'units/beeline-ci-registration.socket': '7c8bbdc3a654ca076c637334b6fd0662e35b9e04239e48bffc7c38a897122394', 'units/beeline-ci-shard-1-docker.service': 'a7edf7045d557bae0a4fcece9daaa82ad55affceb5d30abbe74ad9e967de0300', 'units/beeline-ci-shard-1.service': 'ad7c461bd5398413aa47624f38986c9a69915e66e8516a31a1425d034f8592e4', 'units/beeline-ci-shard-2-docker.service': 'bcc94b426b8054f46a2f6f641dfd14b55e830a4b3c74d9eedece01884fc043d6', 'units/beeline-ci-shard-2.service': '971dd205513c3c691c4e32b1750a05c492ea4f7c19698a4c8e8959dbb5168a15', 'units/beeline-ci-shard-3-docker.service': 'eb5c506292c9450005a1eeb2ad1345b3b25958c44d8d775f9252a021a50c7494', 'units/beeline-ci-shard-3.service': 'b9a8e0895529ae526f85eb5d3cd34dc92aaea2d3ff488c0e2da31e49f2e0312a', 'units/beeline-ci-shard-4-docker.service': 'b4a10b8cf811ec0510e520926926c567370f0350dc503a83c9229d9fa077062b', 'units/beeline-ci-shard-4.service': '0388c7ad9218978242124a3567fad587c1e6c6f9138a664918a2b55fb1fbf3b7'}


def main():
    if os.geteuid() != 0 or os.getegid() != 0:
        raise SystemExit('Owner-approved root installer required')
    if Path('/opt/beeline-ci').exists() or Path('/opt/beeline-ci').is_symlink():
        raise SystemExit('Existing CI installation; use merged-main sync')
    payload = {}
    for name, digest in PINS.items():
        data = (SOURCE / name).read_bytes()
        if hashlib.sha256(data).hexdigest() != digest:
            raise SystemExit('Reviewed payload changed: ' + name)
        payload[name] = data
    if not payload:
        raise SystemExit('Missing reviewed payload manifest')
    # Execute exactly the hashed updater bytes, never a sibling import or pyc.
    updater = types.ModuleType('reviewed_ci_sync')
    updater.__file__ = '/opt/beeline-ci/sync.py'
    exec(compile(payload['sync.py'], updater.__file__, 'exec'), updater.__dict__)
    for parent in [Path('/opt'), Path('/etc/systemd/system'), Path('/etc/polkit-1/rules.d')]:
        updater.root_directory(parent)
    # The account is fixed; a runner user receives no new privilege.
    import pwd
    if pwd.getpwnam('lunchbox').pw_uid != 1000:
        raise SystemExit('Unexpected squire agent account')
    # This fixed root updater is the only new service, not a new CI unit grant.
    if Path('/etc/systemd/system/beeline-ci-sync.service').exists():
        raise SystemExit('Unexpected pre-existing updater unit')
    if Path('/etc/polkit-1/rules.d/00-beeline-ci.rules').exists():
        raise SystemExit('Existing CI privilege rule requires review')
    updater.install_payload({name: payload[name] for name in updater.FILES}, 'bootstrap')
    updater.write(Path('/opt/beeline-ci/sync.py'), payload['sync.py'])
    updater.write(Path('/opt/beeline-ci/sync'), payload['sync'], 0o755)
    updater.write(Path('/etc/systemd/system/beeline-ci-sync.service'), payload['beeline-ci-sync.service'])
    updater.run(['/usr/bin/systemctl', 'daemon-reload'])
    updater.write(Path('/etc/polkit-1/rules.d/00-beeline-ci.rules'), payload['00-beeline-ci.rules'])
    print('CI host access installed; exact units and merged-main sync only', flush=True)


if __name__ == '__main__':
    main()
