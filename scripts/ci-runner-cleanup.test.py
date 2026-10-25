"""Exercise the real cleanup loop against hostile leftover file types."""
import ast
import os
import io
from pathlib import Path
import shutil
import subprocess
import tarfile
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import Mock


class CleanupTest(unittest.TestCase):
    def entry_functions(self, scope):
        source = Path(__file__).with_name('isolated-ci-entry.py')
        functions = [node for node in ast.parse(source.read_text()).body if isinstance(node, ast.FunctionDef)]
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), 'exec'), scope)
        return scope

    def test_listener_drops_caps_before_executing_runner(self):
        command = self.entry_functions({})['listener_command'](123)
        self.assertEqual(command[command.index('--') + 1], '/usr/bin/setpriv')
        for option in ['--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all',
                       '--no-new-privs', '--securebits=+noroot,+noroot_locked,+no_setuid_fixup,+no_setuid_fixup_locked']:
            self.assertIn(option, command)
            self.assertLess(command.index(option), command.index('/ci/runner/bin/Runner.Listener'))

    def test_waits_for_verified_child_and_rejects_wrong_executable(self):
        clock = SimpleNamespace(monotonic=Mock(side_effect=[0, 0, 0]), sleep=Mock())
        path = Mock()
        path.return_value.read_text.side_effect = [FileNotFoundError(), '123']
        samefile = Mock(side_effect=[True, False, False])
        scope = self.entry_functions({'time': clock, 'Path': path, 'os': SimpleNamespace(path=SimpleNamespace(samefile=samefile))})
        self.assertEqual(scope['wait_for_child'](), 123)
        clock.sleep.assert_called_once_with(0.1)
        clock.monotonic.side_effect = [0, 0, 31]
        path.return_value.read_text.side_effect = None
        path.return_value.read_text.return_value = '123'
        samefile.side_effect = None
        samefile.return_value = False
        with self.assertRaises(SystemExit):
            scope['wait_for_child']()

    def test_extracted_runner_is_enterable_executable_and_writable(self):
        source = Path(__file__).with_name('prepare-ephemeral-ci-runner.py')
        function = next(node for node in ast.parse(source.read_text()).body
                        if isinstance(node, ast.FunctionDef) and node.name == 'restore_runner_ownership')
        scope = {'os': os, 'Path': Path}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), scope)
        with tempfile.TemporaryDirectory() as temporary:
            runner = Path(temporary) / 'runner'
            runner.mkdir(mode=0o700)
            archive = io.BytesIO()
            with tarfile.open(fileobj=archive, mode='w') as files:
                files.add('/usr/bin/true', arcname='bin/Runner.Listener')
            archive.seek(0)
            with tarfile.open(fileobj=archive) as files:
                files.extractall(runner, filter='data')
            scope['restore_runner_ownership'](runner, SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid()))
            self.assertEqual(runner.stat().st_uid, os.getuid())
            self.assertEqual(runner.stat().st_mode & 0o777, 0o700)
            (runner / '_diag').mkdir()
            (runner / '_diag/log').write_text('writable')
            subprocess.run([str(runner / 'bin/Runner.Listener')], cwd=runner, check=True)

    def test_removes_all_state_without_following_links(self):
        source = Path(__file__).with_name('prepare-ephemeral-ci-runner.py')
        tree = ast.parse(source.read_text())
        loop = next(node for node in tree.body if isinstance(node, ast.For)
                    and ast.unparse(node.iter) == 'state.iterdir()')
        cleanup = compile(ast.Module(body=[loop], type_ignores=[]), str(source), 'exec')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state = root / 'state'
            state.mkdir()
            outside = root / 'outside'
            outside.mkdir()
            (outside / 'keep').write_text('preserve')
            (state / 'regular').write_text('untrusted')
            (state / 'directory').mkdir()
            (state / 'directory/nested').write_text('untrusted')
            (state / 'link').symlink_to(outside, target_is_directory=True)
            (state / 'broken').symlink_to(root / 'missing')
            os.mkfifo(state / 'fifo')
            exec(cleanup, {'state': state, 'shutil': shutil})
            self.assertEqual(list(state.iterdir()), [])
            self.assertEqual((outside / 'keep').read_text(), 'preserve')


if __name__ == '__main__':
    unittest.main()
