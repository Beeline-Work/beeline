"""Exercise the real cleanup loop against hostile leftover file types."""
import ast
import os
from pathlib import Path
import shutil
import tempfile
import unittest


class CleanupTest(unittest.TestCase):
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
