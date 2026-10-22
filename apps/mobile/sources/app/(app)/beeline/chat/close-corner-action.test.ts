import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/auth/monolith-session', () => ({ monolithSession: network }));
vi.mock('@/buzz/runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://server.example' }) }));

import { monolithPhoneOperation, phoneOperationFailureReason } from '@/sync/transport/monolith-operation';

// Exercise the shipped confirmation callback without mounting the entire chat
// screen. The request and response parsing use the real phone operation client.
const source = readFileSync(new URL('./_chat-surface.tsx', import.meta.url), 'utf8');
const callback = source.slice(source.indexOf('  const [closingCorner, setClosingCorner]'), source.indexOf('  const handleCommunitySelect'));

function closeAction() {
  const alert = vi.fn();
  const back = vi.fn();
  const setClosing = vi.fn();
  const action = new Function('useState', 'useCallback', 'Haptics', 'Modal', 'CORNER_LABEL', 'transport', 'decodedId', 'handleBack', 'phoneOperationFailureReason',
    `${callback}\nreturn handleCloseCorner;`)(
    () => [false, setClosing], (fn: unknown) => fn,
    { notificationAsync: vi.fn(), NotificationFeedbackType: { Error: 'error', Warning: 'warning' } },
    { alert }, 'corner',
    { closeCorner: (roomId: string) => monolithPhoneOperation('requestCornerClose', { roomId }) },
    '500f6c94-376b-4eed-a9b6-1f05059e558f', back, phoneOperationFailureReason,
  );
  return { action, alert, back, setClosing };
}

describe('R1: confirmed Close corner response on the phone', () => {
  it('shows a plain reason and next step for the production open-PR refusal', async () => {
    network.fetch.mockResolvedValue(new Response(JSON.stringify({
      error: 'close the corner pull request with close_corner_pr before closing the corner',
    }), { status: 409 }));
    const { action, alert, back, setClosing } = closeAction();
    await action();
    expect(network.fetch).toHaveBeenLastCalledWith('https://server.example/v1/phone/operations/requestCornerClose',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ roomId: '500f6c94-376b-4eed-a9b6-1f05059e558f' }) }));
    expect(alert).toHaveBeenCalledWith('Could not close corner',
      'This corner still has an open pull request. Ask an agent to close the pull request, then try closing the corner again.');
    expect(back).not.toHaveBeenCalled();
    expect(setClosing.mock.calls).toEqual([[true], [false]]);
    console.info('R1 Demonstrated: confirmed Close corner → HTTP 409 open-PR refusal → plain reason and next step; screen stays open.');
  });

  it('keeps another refusal reason visible', async () => {
    network.fetch.mockResolvedValue(new Response(JSON.stringify({ error: 'room access denied' }), { status: 403 }));
    const { action, alert, back } = closeAction();
    await action();
    expect(alert).toHaveBeenCalledWith('Could not close corner', 'room access denied');
    expect(back).not.toHaveBeenCalled();
  });

  it('returns to the room after an accepted close', async () => {
    network.fetch.mockResolvedValue(new Response(null, { status: 204 }));
    const { action, alert, back } = closeAction();
    await action();
    expect(back).toHaveBeenCalledOnce();
    expect(alert).not.toHaveBeenCalled();
  });
});
