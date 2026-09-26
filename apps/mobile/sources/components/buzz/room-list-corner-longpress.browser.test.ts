import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

/**
 * The Room-list corner glyph's long press, driven as a real pointer gesture in
 * a browser against the shipped `ConversationRow` and `openRoomListCorner`:
 * a tap stays the corner-list toggle, a held press creates a named human
 * corner and opens it, and neither a missing transport nor a refused create
 * silently does nothing.
 */
describe.skipIf(!existsSync(CHROME))('Room-list corner long press in a browser', () => {
  it('opens a corner on a held press and keeps a tap as the toggle', async () => {
    const mobile = process.cwd();
    const { result, status, stderr } = await runBrowserProof({
      entry: path.join(mobile, 'scripts/room-list-corner-longpress-proof.tsx'),
      mobile,
      shims: {
        ...webProofShims(mobile),
        'expo-haptics': `export const notificationAsync = async () => undefined;
          export const selectionAsync = async () => undefined;
          export const impactAsync = async () => undefined;
          export const NotificationFeedbackType = { Success: 'success', Error: 'error' };
          export const ImpactFeedbackStyle = { Light: 'light' };`,
        '@/modal': `export const Modal = {
          alert: (title, message) => { (window.__alerts ||= []).push([title, message]); },
        };`,
        '@/sync/transport/monolith-operation': `export const phoneOperationFailureReason = (error) =>
          error instanceof Error ? error.message : String(error);`,
      },
      width: 900,
    });
    expect(status, stderr).toBe(0);
    expect(result).toContain('RESULT PASS');
    expect(result).not.toContain('FAIL');
  }, 90_000);
});