"""Unprivileged real-Git and installation-fixture proofs; no host root calls."""
import hashlib
import importlib.util
import os
import json
import ast
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('sync_fixture', ROOT / 'sync.py')
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)


class SyncTests(unittest.TestCase):
    def test_installer_pins_every_installed_file(self):
        manifest = json.loads((ROOT / 'INSTALL-SHA256.json').read_text())
        self.assertEqual(manifest['installer_sha256'], hashlib.sha256((ROOT / 'install.py').read_bytes()).hexdigest())
        launcher = ast.parse((ROOT / 'launch-install.py').read_text())
        expected = next(ast.literal_eval(n.value) for n in launcher.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'expected' for t in n.targets))
        self.assertEqual(expected, manifest['installer_sha256'])
        tree = ast.parse((ROOT / 'install.py').read_text())
        pins = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'PINS' for t in n.targets))
        self.assertEqual(set(pins), {f['source'] for f in manifest['files']})
        for row in manifest['files']:
            self.assertEqual(pins[row['source']], hashlib.sha256((ROOT / row['source']).read_bytes()).hexdigest())
            self.assertEqual(row['sha256'], pins[row['source']])
            self.assertEqual(row['owner'], 'root:root')
            self.assertEqual(int(row['mode'], 8) & 0o022, 0)

    def fixture(self, folder):
        repo = Path(folder) / 'repo'
        repo.mkdir()
        def git(*args):
            return subprocess.check_output(['/usr/bin/git', '-c', 'core.hooksPath=/dev/null',
                '-c', 'user.name=CI fixture', '-c', 'user.email=fixture@example.invalid',
                '-C', str(repo), *args], stderr=subprocess.DEVNULL).decode().strip()
        git('init', '-b', 'main')
        for name in s.FILES:
            target = repo / s.PREFIX / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((ROOT / name).read_bytes())
        git('add', '.')
        git('commit', '-m', 'merged fixture')
        merged = git('rev-parse', 'HEAD')
        git('update-ref', 'refs/remotes/origin/main', merged)
        return repo, git, merged

    def test_unmerged_commit_rejected_before_installation(self):
        with tempfile.TemporaryDirectory() as folder:
            repo, git, merged = self.fixture(folder)
            target = repo / s.PREFIX / 'runtime/broker.py'
            target.write_text('UNMERGED = True\n')
            git('add', '.')
            git('commit', '-m', 'unmerged fixture')
            unmerged = git('rev-parse', 'HEAD')
            with self.assertRaises(subprocess.CalledProcessError):
                s.merged_payload(repo / '.git', unmerged)
            self.assertEqual(s.merged_payload(repo / '.git', merged)['runtime/broker.py'], (ROOT / 'runtime/broker.py').read_bytes())
        print('CI-SYNC-1 PASS: unmerged commit refused using real Git ancestry')

    def test_corner_edits_and_symlinks_never_install(self):
        with tempfile.TemporaryDirectory() as folder:
            repo, git, merged = self.fixture(folder)
            target = repo / s.PREFIX / 'runtime/broker.py'
            target.write_text('EDITED = True\n')
            payload = s.merged_payload(repo / '.git', merged)
            self.assertNotIn(b'EDITED', payload['runtime/broker.py'])
            target.unlink()
            target.symlink_to('/etc/passwd')
            git('add', '.')
            git('commit', '-m', 'merged symlink fixture')
            bad = git('rev-parse', 'HEAD')
            git('update-ref', 'refs/remotes/origin/main', bad)
            with self.assertRaisesRegex(RuntimeError, 'non-regular'):
                s.merged_payload(repo / '.git', bad)
        print('CI-SYNC-2 PASS: edited corner bytes ignored; merged symlink refused')

    def test_fixture_install_is_readonly_and_uses_merged_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            repo, git, merged = self.fixture(folder)
            payload = s.merged_payload(repo / '.git', merged)
            base = Path(folder) / 'installed'
            units = Path(folder) / 'units'
            units.mkdir()
            # Redirect only fixed host destinations for this unprivileged proof.
            original_write = s.write
            def write(path, data, mode=0o644):
                if str(path).startswith('/etc/systemd/system/'):
                    path = units / path.name
                original_write(path, data, mode)
            real_lstat = Path.lstat
            def local_owner(path):
                info = real_lstat(path)
                return SimpleNamespace(st_mode=info.st_mode, st_uid=0, st_gid=0)
            with patch.object(Path, 'lstat', local_owner), patch.object(s, 'BASE', base), patch.object(s, 'mount_destinations'), patch.object(s, 'verify_units'), patch.object(s, 'run') as run, patch.object(s, 'write', side_effect=write):
                s.install_payload(payload, merged)
            self.assertEqual(run.call_args_list[0].args[0], ['/usr/bin/systemctl', 'stop', *s.UNITS])
            self.assertEqual((base / 'current/broker.py').read_bytes(), payload['runtime/broker.py'])
            for path in [base, base / 'releases', base / 'current/broker.py', *units.iterdir()]:
                self.assertEqual(path.stat().st_mode & 0o022, 0)
            for unit in units.iterdir():
                text = unit.read_text()
                self.assertNotIn('/corners/', text)
                self.assertNotIn('/usr/local/lib/beeline-ci', text)
                if '/usr/bin/python3' in text:
                    self.assertIn('/usr/bin/python3 -I -B /opt/beeline-ci/current/', text)
        print('CI-SYNC-3 PASS: immutable installation fixture; only merged bytes; no checkout or cache executable paths')

    def test_sync_rejects_caller_revision_and_ignores_environment(self):
        with patch.object(s.sys, 'argv', ['sync.py', 'deadbeef']), patch.object(s, 'git') as git:
            with self.assertRaisesRegex(SystemExit, 'no arguments'):
                s.main()
            git.assert_not_called()
        with patch.dict(os.environ, {'GIT_CONFIG_COUNT': '1', 'PYTHONPATH': '/evil', 'LD_PRELOAD': '/evil'}), patch.object(s.subprocess, 'run') as run:
            s.run(['/usr/bin/git', 'version'])
            self.assertEqual(run.call_args.kwargs['env'], s.ENV)
            self.assertNotIn('GIT_CONFIG_COUNT', run.call_args.kwargs['env'])
            self.assertNotIn('LD_PRELOAD', run.call_args.kwargs['env'])
        self.assertIn(b'/usr/bin/python3 -I -B /opt/beeline-ci/sync.py', (ROOT / 'beeline-ci-sync.service').read_bytes())

    def test_root_path_guards_reject_writable_directories_and_links(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'unsafe'
            path.mkdir(mode=0o777)
            path.chmod(0o777)
            with self.assertRaisesRegex(RuntimeError, 'root controlled'):
                s.root_directory(path)
            link = Path(folder) / 'link'
            link.symlink_to(path)
            with self.assertRaisesRegex(RuntimeError, 'symlink'):
                s.root_directory(link)


if __name__ == '__main__':
    unittest.main()
