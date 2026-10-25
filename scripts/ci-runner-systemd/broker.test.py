import contextlib
import importlib.util
import io
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location('broker', Path(__file__).with_name('broker.py'))
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)


class BrokerTests(unittest.TestCase):
    def test_live_socket_is_never_removed(self):
        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / 'relay.sock')
            with socket.socket(socket.AF_UNIX) as listener:
                listener.bind(path)
                listener.listen(1)
                with patch.object(broker, 'SOCKET', path):
                    with self.assertRaisesRegex(RuntimeError, 'listener is alive'):
                        broker.cleanup()
                self.assertTrue(Path(path).exists())

    def test_refused_socket_removed_and_parent_restricted(self):
        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / 'relay.sock')
            with socket.socket(socket.AF_UNIX) as stale:
                stale.bind(path)
            with patch.object(broker, 'SOCKET', path), patch.object(broker.os, 'chown'):
                broker.cleanup()
            self.assertFalse(Path(path).exists())
            self.assertEqual(Path(folder).stat().st_mode & 0o777, 0o700)

    def test_non_socket_is_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'relay.sock'
            path.write_text('preserve')
            with patch.object(broker, 'SOCKET', str(path)):
                with self.assertRaisesRegex(RuntimeError, 'not a socket'):
                    broker.cleanup()
            self.assertEqual(path.read_text(), 'preserve')

    def invoke_registration(self, policy='all_external_contributors', repo='Beeline-Work/beeline'):
        calls = []
        def api(path, token, body=None):
            calls.append(path)
            if path.startswith('app/installations/'):
                return {'token': 'installation-secret'}
            if 'fork-pr-contributor' in path:
                return {'approval_policy': policy}
            if path.endswith('/repositories'):
                return {'total_count': 1, 'repositories': [{'full_name': repo}]}
            if 'runner-groups/' in path:
                return {'visibility': 'selected', 'allows_public_repositories': True, 'name': 'beeline-server-ci'}
            return {'token': 'registration-secret'}
        output = io.StringIO()
        with patch.object(broker, 'api', side_effect=api), patch.object(broker, 'jwt', return_value='jwt-secret'), patch.dict(broker.os.environ, {'GITHUB_INSTALLATION_ID': '12', 'GITHUB_RUNNER_GROUP_ID': '34'}), contextlib.redirect_stdout(output):
            try:
                return broker.registration(), calls, output.getvalue()
            finally:
                self.assertNotIn('secret', output.getvalue())
                self.assertIn('policy_seconds=', output.getvalue())

    def test_policy_precedes_group_and_token(self):
        token, calls, output = self.invoke_registration()
        self.assertEqual(token, 'registration-secret')
        self.assertIn('fork-pr-contributor', calls[1])
        self.assertTrue(calls[-1].endswith('/runners/registration-token'))

    def test_unsafe_policy_and_wrong_group_fail_closed(self):
        with self.assertRaisesRegex(RuntimeError, 'approval policy'):
            self.invoke_registration(policy='first_time_contributors')
        with self.assertRaisesRegex(RuntimeError, 'repository restriction'):
            self.invoke_registration(repo='Beeline-Work/other')

    def test_request_failure_logs_no_token_or_body(self):
        class Connection:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def settimeout(self, value): pass
            def sendall(self, value): raise AssertionError("No token should be sent")
            def getsockopt(self, *args): return broker.struct.pack('3i', 1, 0, 0)
        class Server:
            count = 0
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def accept(self):
                self.count += 1
                if self.count > 1: raise KeyboardInterrupt
                return Connection(), None
        error = urllib.error.HTTPError('secret-url', 403, 'secret-body', {}, None)
        out = io.StringIO()
        with patch.dict(broker.os.environ, {'LISTEN_PID': str(broker.os.getpid()), 'LISTEN_FDS': '1'}), patch.object(broker.os, 'geteuid', return_value=0), patch.object(broker.socket, 'socket', return_value=Server()), patch.object(broker, 'registration', side_effect=error), contextlib.redirect_stdout(out):
            with self.assertRaises(KeyboardInterrupt): broker.serve()
        self.assertIn('status=403', out.getvalue())
        self.assertNotIn('secret', out.getvalue())


if __name__ == '__main__':
    unittest.main()
