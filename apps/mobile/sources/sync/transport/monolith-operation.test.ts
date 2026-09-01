import { beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://server.example' }),
}));
vi.mock('@/auth/monolith-session', () => ({
  monolithSession: { fetch: controls.fetch },
}));

import { monolithPhoneOperation } from './monolith-operation';

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
});
