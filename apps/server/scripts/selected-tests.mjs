import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The selection test-selection.mjs wrote for this PR, named by
// SERVER_TEST_SELECTION. Without one, every server test runs.
export function readSelection(path = process.env.SERVER_TEST_SELECTION) {
  if (!path) return { mode: 'full' };
  const selection = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(selection.mode === 'full' || (selection.mode === 'subset' && Array.isArray(selection.files)),
    `unreadable server test selection in ${path}`);
  return selection;
}

// Whether a server-relative test file (src/x.test.ts) runs under a selection.
export function selected(selection, file) {
  return selection.mode === 'full' || selection.files.includes(`apps/server/${file}`);
}
