import contextlib
import hashlib
import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('rollout', Path(__file__).with_name('rollout.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class RolloutTests(unittest.TestCase):
    def test_manifest_has_exact_scope_and_no_webhook(self):
        value = r.manifest('fixture')
        self.assertEqual(value['default_permissions'], {'organization_self_hosted_runners': 'write', 'administration': 'read'})
        self.assertFalse(value['public'])
        self.assertFalse(value['hook_attributes']['active'])
        self.assertEqual(value['default_events'], [])
        self.assertEqual(value['redirect_url'], 'http://127.0.0.1:18765/callback')

    def test_callback_rejects_state_then_consumes_once_and_encrypts(self):
        replies, saved, requests = [], [], []
        secret = 'PRIVATE-FIXTURE-NOT-A-REAL-KEY'
        class Server:
            def __init__(self, address, handler):
                self.handler = handler
                self.paths = iter(['/', '/callback?code=fixturecode123&state=wrong', '/callback?code=fixturecode123&state=fixturestate'])
                self.address = address
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def handle_request(self):
                obj = self.handler.__new__(self.handler)
                obj.headers = {'Host': '127.0.0.1:18765'}
                obj.path = next(self.paths)
                obj.reply = lambda code, text: replies.append((code, text))
                obj.do_GET()
        def api(path, **kwargs):
            requests.append(path)
            return {'pem': secret, 'id': 123, 'slug': 'fixture-app', 'client_secret': 'also-secret'}
        def run(argv, data=None, **kwargs):
            self.assertEqual(data, secret.encode())
            self.assertNotIn(secret, ' '.join(argv))
            return b'encrypted-fixture'
        output = io.StringIO()
        with patch.object(r, 'HTTPServer', Server), patch.object(r.secrets, 'token_urlsafe', return_value='fixturestate'), patch.object(r, 'api', side_effect=api), patch.object(r, 'run', side_effect=run), patch.object(r, 'private_write', side_effect=lambda path, content: saved.append(content)), contextlib.redirect_stdout(output):
            pem, app_id, slug = r.capture_manifest()
        self.assertEqual(pem, secret.encode())
        self.assertEqual(app_id, 123)
        self.assertEqual([code for code, _ in replies], [200, 403, 200])
        self.assertEqual(len(requests), 1)
        self.assertEqual(saved, [b'encrypted-fixture', b'GITHUB_APP_ID=123\n'])
        self.assertNotIn(secret, output.getvalue() + str(replies))

    def test_all_repositories_installation_rejected(self):
        app = {'permissions': r.PERMISSIONS, 'owner': {'login': r.ORG}}
        row = {'account': {'login': r.ORG}, 'repository_selection': 'all'}
        with patch.object(r, 'jwt', return_value='jwt'), patch.object(r, 'api', side_effect=[app, [row]]), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(r.Failure, 'not all repositories'):
                r.wait_installation(b'fixture', 12, 'fixture-app')

    def test_selected_extra_repository_rejected(self):
        app = {'permissions': r.PERMISSIONS, 'owner': {'login': r.ORG}}
        row = {'id': 5, 'account': {'login': r.ORG}, 'repository_selection': 'selected', 'permissions': r.PERMISSIONS}
        repos = {'total_count': 2, 'repositories': [{'full_name': r.REPO}, {'full_name': 'Beeline-Work/other'}]}
        with patch.object(r, 'jwt', return_value='jwt'), patch.object(r, 'api', side_effect=[app, [row], {'token': 'fixture'}, repos]), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(r.Failure, 'not exactly'):
                r.wait_installation(b'fixture', 12, 'fixture-app')

    def test_existing_wrong_group_is_not_modified(self):
        with patch.object(r, 'api', side_effect=[{'total_count': 1, 'runner_groups': [{'id': 9, 'name': r.GROUP}]}, {'name': r.GROUP, 'visibility': 'all'}, {'total_count': 0, 'repositories': []}]) as api:
            with self.assertRaisesRegex(r.Failure, 'not modified'):
                r.group_setup('fixture', 123)
            self.assertTrue(all(len(call.args) == 2 for call in api.call_args_list))

    def test_create_group_pins_repository(self):
        settings = {'id': 9, 'name': r.GROUP, 'visibility': 'selected', 'allows_public_repositories': True}
        with patch.object(r, 'api', side_effect=[{'total_count': 0, 'runner_groups': []}, settings, settings, {'total_count': 1, 'repositories': [{'id': 123}]}]) as api:
            self.assertEqual(r.group_setup('fixture', 123), 9)
            self.assertEqual(api.call_args_list[1].args[2]['selected_repository_ids'], [123])

    def test_token_fingerprint_detects_raw_token_without_printing(self):
        token = 'EXAMPLE_REGISTRATION_SECRET_123456'
        journal = 'policy_seconds=0.5\nregistration_sha256=' + hashlib.sha256(token.encode()).hexdigest()
        class Log:
            def read_text(self, **kwargs): return 'token="' + token + '"'
        with patch.object(r, 'run', return_value=journal.encode()), patch.object(Path, 'glob', side_effect=lambda *args: iter([Log()])):
            with self.assertRaisesRegex(r.Failure, 'Registration token found'):
                r.verify_logs('fixture')

    def test_extra_permission_rejected(self):
        with self.assertRaisesRegex(r.Failure, 'permissions differ'):
            r.check_permissions({**r.PERMISSIONS, 'contents': 'read'})


if __name__ == '__main__':
    unittest.main()
