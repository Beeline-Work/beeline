import test from 'node:test';
import assert from 'node:assert/strict';
import { requireRoomList } from './capture-ui.mjs';
const list = '<node content-desc="all conversations" bounds="[0,10][100,30]"/><node text="#Rig room 001" bounds="[20,50][180,80]"/>';
test('a signed-out screen or a covering Workspace overlay cannot become a timing sample', () => {
  assert.throws(() => requireRoomList('<node text="Continue with GitHub" bounds="[0,0][100,100]"/>'), /sign in/);
  assert.throws(() => requireRoomList(list + '<node content-desc="Close Workspace switcher" bounds="[10,0][200,800]"/>'), /overlay/);
  assert.deepEqual(requireRoomList(list), [100, 65]);
});
