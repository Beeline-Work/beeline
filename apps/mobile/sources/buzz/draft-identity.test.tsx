import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('@/buzz/draft-identity');
const identity = vi.hoisted(() => ({
  load: vi.fn<() => Promise<string | null>>(),
  changed: undefined as (() => void) | undefined,
  unsubscribe: vi.fn(),
}));
vi.mock('@/auth/buzz-identity-storage', () => ({ loadBuzzViewerPubkey: identity.load }));
vi.mock('@/auth/monolith-session', () => ({
  monolithSession: {
    subscribeIdentityChange: (listener: () => void) => {
      identity.changed = listener;
      return identity.unsubscribe;
    },
  },
}));
import { useDraftIdentity } from './draft-identity';
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: ReactTestRenderer;
function Screen({ explicit }: { explicit?: string | null }) {
  const current = useDraftIdentity(explicit);
  return <span>{current ?? 'no identity'}</span>;
}
afterEach(async () => {
  await act(async () => renderer?.unmount());
  identity.load.mockReset();
  identity.unsubscribe.mockClear();
  identity.changed = undefined;
});
describe('public identity isolation for drafts', () => {
  it('bypasses storage and subscriptions for an explicit state owner identity', async () => {
    await act(async () => {
      renderer = create(<Screen explicit="owner" />);
    });
    expect(renderer.root.findByType('span').props.children).toBe('owner');
    expect(identity.load).not.toHaveBeenCalled();
    expect(identity.changed).toBeUndefined();
  });
  it('clears the old identity during sign-in changes and ignores stale reads', async () => {
    const resolvers: ((value: string | null) => void)[] = [];
    identity.load.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    await act(async () => {
      renderer = create(<Screen />);
    });
    expect(renderer.root.findByType('span').props.children).toBe('no identity');
    await act(async () => resolvers[0]!('alice'));
    expect(renderer.root.findByType('span').props.children).toBe('alice');
    await act(async () => identity.changed!());
    expect(renderer.root.findByType('span').props.children).toBe('no identity');
    await act(async () => identity.changed!());
    await act(async () => resolvers[2]!('bob'));
    await act(async () => resolvers[1]!('alice'));
    expect(renderer.root.findByType('span').props.children).toBe('bob');
    await act(async () => identity.changed!());
    await act(async () => resolvers[3]!(null));
    expect(renderer.root.findByType('span').props.children).toBe('no identity');
    await act(async () => renderer.unmount());
    expect(identity.unsubscribe).toHaveBeenCalled();
  });
});
