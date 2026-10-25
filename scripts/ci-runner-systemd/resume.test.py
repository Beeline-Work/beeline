import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('resume', Path(__file__).with_name('resume.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class ResumeTests(unittest.TestCase):
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
