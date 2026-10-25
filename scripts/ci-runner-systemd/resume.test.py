import importlib.util
import hashlib
import marshal
import struct
import os
import errno
from itertools import product
from unittest.mock import MagicMock
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('resume', Path(__file__).with_name('resume.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class ResumeTests(unittest.TestCase):
    def test_existing_broker_retry_and_failed_start_cleanup(self):
        rollout = MagicMock()
        rollout.Failure = RuntimeError
        rollout.ORG = 'Beeline-Work'
        rollout.REPO = 'Beeline-Work/beeline'
        rollout.PINS = {}
        rollout.group_setup.return_value = 7
        def api(path, *args):
            if path == 'app':
                return {'permissions': {}, 'id': 5, 'slug': r.EXPECTED_SLUG,
                        'owner': {'login': 'Beeline-Work'}}
            if path.endswith('/access_tokens'):
                return {'token': 'fixture'}
            if path.startswith('app/installations/'):
                return {'permissions': {}, 'repository_selection': 'selected',
                        'account': {'login': 'Beeline-Work'}}
            if path.startswith('installation/repositories'):
                return {'total_count': 1, 'repositories': [{'full_name': rollout.REPO, 'id': 8}]}
            if path.endswith('fork-pr-contributor-approval'):
                return {'approval_policy': 'all_external_contributors'}
            if path.endswith('/runners?per_page=100'):
                return {'runners': [{'name': f'beeline-ci-shard-{i}', 'status': 'online'} for i in [1, 2]]}
            raise AssertionError(path)
        rollout.api.side_effect = api
        broker = MagicMock()
        env = {'GITHUB_INSTALLATION_ID': str(r.EXPECTED_INSTALLATION),
               'GITHUB_APP_ID': '5', 'GITHUB_RUNNER_GROUP_ID': '7',
               'CREDENTIALS_DIRECTORY': '/fixture'}
        def run(argv, **kwargs):
            # inactive runner, active permanent socket
            return SimpleNamespace(returncode=socket_status if 'beeline-ci-registration.socket' in argv else 3)
        info = SimpleNamespace(st_mode=0o100600, st_uid=0)
        for fail, socket_status in product([False, True], [0, 3]):
            rollout.reset_mock()
            relay = MagicMock()
            relay.__enter__.return_value.connect.side_effect = ConnectionRefusedError(errno.ECONNREFUSED, "fixture stopped socket")
            def command(argv, **kwargs):
                if fail and argv[1] == 'start':
                    raise RuntimeError('injected systemctl start failure')
            rollout.run.side_effect = command
            with patch.object(r, 'load', side_effect=[rollout, broker]), patch.dict(os.environ, env), patch.object(r.os, 'geteuid', return_value=0), patch.object(Path, 'stat', return_value=info), patch.object(Path, 'lstat', return_value=SimpleNamespace(st_mode=0o040700)), patch.object(Path, 'chmod'), patch.object(r.os, 'chown'), patch.object(r.subprocess, 'run', side_effect=run), patch.object(r, 'stop_verified_listener') as old, patch.object(r.socket, 'socket', return_value=relay):
                if fail:
                    with self.assertRaises(SystemExit):
                        r.main()
                    rollout.stop_ci.assert_called_once()
                else:
                    r.main()
                    rollout.stop_ci.assert_not_called()
                old.assert_not_called()
                rollout.ensure_mount_targets.assert_called_once()
                commands = [call.args[0] for call in rollout.run.call_args_list]
                self.assertIn(['/usr/bin/systemctl', 'stop', 'beeline-ci-shard-3-docker.service', 'beeline-ci-shard-4-docker.service'], commands)
        print('CI-RETRY-2: permanent broker reused, no old PID signal; failed start cleanup PASS')

    def test_planted_timestamp_cache_is_ignored(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'fixture.py'
            data = b"VALUE = 'source'\n"
            source.write_bytes(data)
            cache = Path(importlib.util.cache_from_source(str(source)))
            cache.parent.mkdir()
            # A valid timestamp cache with the exact trusted source mtime/size.
            header = importlib.util.MAGIC_NUMBER + struct.pack('<III', 0, int(source.stat().st_mtime), len(data))
            cache.write_bytes(header + marshal.dumps(compile("VALUE = 'poison'\n", str(source), 'exec')))
            # Establish that the old loader really would accept the planted cache.
            spec = importlib.util.spec_from_file_location('old_loader', source)
            poisoned = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(poisoned)
            self.assertEqual(poisoned.VALUE, 'poison')
            original_read = Path.read_bytes
            reads = []
            def read_once(path):
                reads.append(path)
                return original_read(path)
            with patch.object(r, 'ROOT', Path(folder)), patch.object(r, 'PINS', {'fixture.py': hashlib.sha256(data).hexdigest()}), patch.object(Path, 'read_bytes', read_once):
                module = r.load('fixture.py')
            self.assertEqual(module.VALUE, 'source')
            self.assertEqual(module.__file__, str(source))
            self.assertEqual(reads, [source])

    def test_socket_inode_requires_unique_listener(self):
        line = 'header\n000: 2 0 00010000 0001 01 123 /run/beeline-ci-registration/relay.sock\n'
        with patch.object(Path, 'read_text', return_value=line):
            self.assertEqual(r.socket_inode(), '123')
        with patch.object(Path, 'read_text', return_value=line + line.splitlines()[1]):
            with self.assertRaisesRegex(RuntimeError, 'exactly one'):
                r.socket_inode()
        with patch.object(Path, 'read_text', return_value=line.replace('00010000', '00000000')):
            with self.assertRaisesRegex(RuntimeError, 'listener state'):
                r.socket_inode()

    def test_changed_identity_never_signaled(self):
        with patch.object(r.os, 'pidfd_open', return_value=9), patch.object(r.os, 'close'), patch.object(r, 'verify_old_listener', side_effect=RuntimeError('different process')), patch.object(r.signal, 'pidfd_send_signal') as signal:
            with self.assertRaisesRegex(RuntimeError, 'different process'):
                r.stop_verified_listener()
            signal.assert_not_called()

    def test_socket_ownership_change_never_signaled(self):
        with patch.object(r.os, 'pidfd_open', return_value=9), patch.object(r.os, 'close'), patch.object(r, 'verify_old_listener', side_effect=['socket:[1]', 'socket:[2]']), patch.object(r.signal, 'pidfd_send_signal') as signal:
            with self.assertRaisesRegex(RuntimeError, 'ownership changed'):
                r.stop_verified_listener()
            signal.assert_not_called()

    def test_wrong_command_rejected_before_fd_scan(self):
        with patch.object(Path, 'stat', return_value=SimpleNamespace(st_uid=0)), patch.object(Path, 'read_bytes', return_value=b'/usr/bin/python3\0unrelated.py\0'), patch.object(r.os, 'readlink') as readlink:
            with self.assertRaisesRegex(RuntimeError, 'command differs'):
                r.verify_old_listener(r.EXPECTED_PID)
            readlink.assert_not_called()

    def test_another_holder_rejected(self):
        class Process:
            def __init__(self, name): self.name = name
            def __truediv__(self, name): return self
            def iterdir(self): return [self]
        def iterdir(path):
            if str(path) == '/proc': return [Process(str(r.EXPECTED_PID)), Process('99')]
            return []
        with patch.object(Path, 'stat', return_value=SimpleNamespace(st_uid=0)), patch.object(Path, 'read_bytes', return_value=b'\0'.join(r.OLD_ARGV) + b'\0'), patch.object(r.os.path, 'samefile', return_value=True), patch.object(r, 'socket_inode', return_value='123'), patch.object(Path, 'iterdir', iterdir), patch.object(r.os, 'readlink', return_value='socket:[123]'):
            with self.assertRaisesRegex(RuntimeError, 'solely'):
                r.verify_old_listener(r.EXPECTED_PID)


if __name__ == '__main__':
    unittest.main()
