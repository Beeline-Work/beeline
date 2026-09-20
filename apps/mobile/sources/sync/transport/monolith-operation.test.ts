import { beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://server.example' }),
}));
vi.mock('@/auth/monolith-session', () => ({
  monolithSession: { fetch: controls.fetch },
}));

import { monolithPhoneOperation, phoneOperationFailureReason } from './monolith-operation';

describe('monolith phone operation', () => {
  beforeEach(() => controls.fetch.mockReset());

  it('treats a successful no-content response as a void operation result', async () => {
    controls.fetch.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(monolithPhoneOperation('sendPushTest', {})).resolves.toBeUndefined();
    expect(controls.fetch).toHaveBeenCalledWith(
      'https://server.example/v1/phone/operations/sendPushTest',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
  });

  it("carries a refusal's own reason out to the caller that has to show it", async () => {
    controls.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'host MCP is only for an agent that answers its owner' }),
        {
          status: 403,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    const failure = await monolithPhoneOperation('decideAgentGrant', {
      grantId: 'grant-1',
      decision: 'always',
    }).catch((error: unknown) => error);

    expect(phoneOperationFailureReason(failure)).toBe(
      'host MCP is only for an agent that answers its owner',
    );
  });
});
