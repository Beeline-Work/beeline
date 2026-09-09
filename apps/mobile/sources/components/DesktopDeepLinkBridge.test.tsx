import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const replace = vi.hoisted(() => vi.fn());
const native = vi.hoisted(() => ({ listener: null as null | ((url: string) => void) }));

vi.mock('expo-router', () => ({ useRouter: () => ({ replace }) }));
vi.mock('@/utils/isTauri', () => ({ isTauri: () => true }));
vi.mock('@/auth/desktop-auth-session', () => ({
  subscribeToAuthUrls: vi.fn((listener: (url: string) => void) => {
    native.listener = listener;
    return { remove: vi.fn() };
  }),
}));

import { DesktopDeepLinkBridge } from './DesktopDeepLinkBridge';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('running desktop app deep-link bridge', () => {
  beforeEach(() => {
    replace.mockReset();
    native.listener = null;
  });

  it('routes every separate delivery, including reopening the same review link', async () => {
    await act(async () => {
      create(React.createElement(DesktopDeepLinkBridge));
      await Promise.resolve();
    });
    expect(native.listener).not.toBeNull();
    const url = 'beeline://review/play-review-secret-value-0001';
    act(() => {
      native.listener?.(url);
      native.listener?.(url);
    });
    expect(replace).toHaveBeenCalledTimes(2);
    expect(replace).toHaveBeenCalledWith({
      pathname: '/review/[secret]',
      params: { secret: 'play-review-secret-value-0001' },
    });
  });
});
