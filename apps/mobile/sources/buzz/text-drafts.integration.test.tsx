import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const harness = vi.hoisted(() => ({
  path: '',
  identity: 'alice',
  listeners: new Set<(status: string) => void>(),
  send: vi.fn(),
}));
vi.mock('@/buzz/draft-identity', () => ({
  useDraftIdentity: (explicit?: string | null) =>
    explicit === undefined ? harness.identity : explicit,
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) =>
      (JSON.parse(readFileSync(harness.path, 'utf8')) as Record<string, string>)[key] ?? null,
    setItem: async (key: string, value: string) => {
      const values = JSON.parse(readFileSync(harness.path, 'utf8'));
      values[key] = value;
      writeFileSync(harness.path, JSON.stringify(values));
    },
    removeItem: async (key: string) => {
      const values = JSON.parse(readFileSync(harness.path, 'utf8'));
      delete values[key];
      writeFileSync(harness.path, JSON.stringify(values));
    },
  },
}));
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: Record<string, unknown>) =>
    ReactModule.createElement(name, props, props.children as React.ReactNode);
  return {
    AppState: {
      addEventListener: (_: string, listener: (status: string) => void) => {
        harness.listeners.add(listener);
        return { remove: () => harness.listeners.delete(listener) };
      },
    },
    Platform: { OS: 'android' },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});
vi.mock('@/components/buzz/HullDialog', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: Record<string, unknown>) =>
    ReactModule.createElement(name, props, props.children as React.ReactNode);
  return { HullDialog: host('HullDialog'), HullDialogInput: host('TextInput') };
});
vi.mock('@/components/buzz/HullActionSheet', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: Record<string, unknown>) =>
    ReactModule.createElement(
      name,
      props,
      props.children as React.ReactNode,
      props.footer as React.ReactNode,
    );
  return {
    HULL_SHEET_INSET: 22,
    HullActionSheetModal: host('Sheet'),
    HullActionSheetCancel: host('Cancel'),
    HullActionSheetRow: host('Row'),
  };
});
vi.mock('@/components/buzz/Button', async () => {
  const ReactModule = await import('react');
  return { Button: (props: any) => ReactModule.createElement('Button', props, props.children) };
});
vi.mock('@/components/buzz/SettingsRow', async () => {
  const ReactModule = await import('react');
  return {
    SettingsRow: (props: Record<string, unknown>) => ReactModule.createElement('Row', props),
  };
});
vi.mock('@/buzz/wallet-source', () => ({
  chainFeeLabel: () => '',
  getWalletSource: () => ({
    readWallet: async () => ({
      chains: [{ id: 'base', name: 'Base' }],
      coins: [{ symbol: 'USDC' }],
    }),
    sendFromWallet: harness.send,
  }),
}));

import { CreatePollSheet } from '@/components/buzz/CreatePollSheet';
import { WebPromptModal } from '@/modal/components/WebPromptModal';
import { WalletSendForm } from './wallet-send-form';
import { useTextDraft } from './use-text-draft';
import { textDraftKey } from './text-draft-store';
import { NavigationContext } from '@react-navigation/core';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let directory: string;
const renderers: ReactTestRenderer[] = [];
async function render(element: React.ReactElement) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(element);
  });
  renderers.push(renderer);
  return renderer;
}
async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}
async function unmount(renderer: ReactTestRenderer) {
  await act(async () => renderer.unmount());
}
const field = (renderer: ReactTestRenderer, id: string) =>
  renderer.root
    .findAllByProps({ testID: id })
    .find((node: { type: unknown }) => typeof node.type === 'string')!;
const stored = () => JSON.parse(readFileSync(harness.path, 'utf8')) as Record<string, string>;

beforeEach(() => {
  vi.useFakeTimers();
  directory = mkdtempSync(join(tmpdir(), 'beeline-drafts-'));
  harness.path = join(directory, 'storage.json');
  writeFileSync(harness.path, '{}');
  harness.identity = 'alice';
  harness.send.mockReset();
});
afterEach(async () => {
  for (const renderer of renderers.splice(0)) await unmount(renderer);
  await settle();
  rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});
const poll = (onCreate = vi.fn(async () => false), context = 'room-one', visible = true) => (
  <CreatePollSheet
    visible={visible}
    busy={false}
    draftContext={context}
    onClose={() => undefined}
    onCreate={onCreate}
  />
);
async function typePoll(renderer: ReactTestRenderer) {
  await act(async () => {
    field(renderer, 'create-poll-question').props.onChangeText('Ship the update?');
    field(renderer, 'create-poll-option-0').props.onChangeText('Yes');
    field(renderer, 'create-poll-option-1').props.onChangeText('No');
  });
}

describe('rendered draft state owners with file-backed durable storage', () => {
  it('keeps server defaults while the first identity loads, then lets a saved draft win', async () => {
    let identity: string | null = null;
    function Screen() {
      const [value, , draft] = useTextDraft('profile-default', '', identity);
      React.useEffect(() => draft.initialize('Server name'), [draft]);
      return <input value={value} />;
    }
    const renderer = await render(<Screen />);
    expect(renderer.root.findByType('input').props.value).toBe('Server name');
    identity = 'alice';
    await act(async () => renderer.update(<Screen />));
    expect(renderer.root.findByType('input').props.value).toBe('Server name');
    expect(stored()).toEqual({});
    await unmount(renderer);
    writeFileSync(harness.path, JSON.stringify({
      [textDraftKey('alice', 'profile-default')]: JSON.stringify('Saved edit'),
    }));
    identity = null;
    const restored = await render(<Screen />);
    identity = 'alice';
    await act(async () => restored.update(<Screen />));
    expect(restored.root.findByType('input').props.value).toBe('Saved edit');
  });
  it('restores the poll fields after background, disposal and a fresh mounted screen', async () => {
    let renderer = await render(poll());
    await typePoll(renderer);
    expect(field(renderer, 'create-poll-question').props.value).toBe('Ship the update?');
    expect(stored()).toEqual({});
    await act(async () => {
      for (const listener of harness.listeners) listener('background');
    });
    expect(Object.keys(stored())).toHaveLength(2);
    await unmount(renderer);
    renderer = await render(poll());
    expect(field(renderer, 'create-poll-question').props.value).toBe('Ship the update?');
    expect(field(renderer, 'create-poll-option-0').props.value).toBe('Yes');
    console.log(
      'Demonstrated: type poll → background flush → remount with durable storage → question "Ship the update?", options "Yes" and "No" restored. Native process death/reboot not tested.',
    );
  });
  it('preserves validation failures, failed submission and a dismissed dialog; clears after success', async () => {
    const createPoll = vi.fn(async () => false);
    const renderer = await render(poll(createPoll));
    await act(async () => field(renderer, 'create-poll-question').props.onChangeText('Incomplete'));
    expect(field(renderer, 'create-poll-submit').props.disabled).toBe(true);
    await typePoll(renderer);
    await act(async () => {
      await field(renderer, 'create-poll-submit').props.onPress();
    });
    expect(field(renderer, 'create-poll-question').props.value).toBe('Ship the update?');
    await act(async () => renderer.update(poll(createPoll, 'room-one', false)));
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await act(async () => renderer.update(poll(createPoll)));
    expect(field(renderer, 'create-poll-question').props.value).toBe('Ship the update?');
    createPoll.mockResolvedValue(true);
    await act(async () => {
      await field(renderer, 'create-poll-submit').props.onPress();
    });
    expect(field(renderer, 'create-poll-question').props.value).toBe('');
    expect(stored()).toEqual({});
  });
  it('an in-flight poll completion cannot erase newer typing', async () => {
    let finish!: (value: boolean) => void;
    const createPoll = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const renderer = await render(poll(createPoll));
    await typePoll(renderer);
    let pending!: Promise<void>;
    await act(async () => {
      pending = field(renderer, 'create-poll-submit').props.onPress();
    });
    await act(async () =>
      field(renderer, 'create-poll-question').props.onChangeText('A newer question'),
    );
    await act(async () => {
      finish(true);
      await pending;
    });
    expect(field(renderer, 'create-poll-question').props.value).toBe('A newer question');
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(stored()[textDraftKey('alice', 'poll:room-one:prompt')]).toBe(
      JSON.stringify('A newer question'),
    );
  });
  it('restores separate room/account drafts on context switches', async () => {
    const renderer = await render(poll());
    await typePoll(renderer);
    await act(async () => renderer.update(poll(undefined, 'room-two')));
    expect(field(renderer, 'create-poll-question').props.value).toBe('');
    await act(async () => field(renderer, 'create-poll-question').props.onChangeText('Room two'));
    harness.identity = 'bob';
    await act(async () => renderer.update(poll()));
    expect(field(renderer, 'create-poll-question').props.value).toBe('');
    harness.identity = 'alice';
    await act(async () => renderer.update(poll()));
    expect(field(renderer, 'create-poll-question').props.value).toBe('Ship the update?');
  });
  it('wallet refusals preserve input; sent outcomes clear only submitted versions', async () => {
    const renderer = await render(<WalletSendForm workspaceId="workspace" />);
    await act(async () => {
      field(renderer, 'wallet-send-amount').props.onChangeText('5');
      field(renderer, 'wallet-send-to').props.onChangeText('0xrecipient');
    });
    harness.send.mockResolvedValue({ outcome: 'insufficient', asset: 'USDC', available: '0' });
    await act(async () => {
      await field(renderer, 'wallet-send-confirm').props.onPress();
    });
    expect(field(renderer, 'wallet-send-amount').props.value).toBe('5');
    let finish!: (result: unknown) => void;
    harness.send.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = field(renderer, 'wallet-send-confirm').props.onPress();
    });
    await act(async () => field(renderer, 'wallet-send-amount').props.onChangeText('7'));
    await act(async () => {
      finish({ outcome: 'sent' });
      await pending;
    });
    expect(field(renderer, 'wallet-send-amount').props.value).toBe('7');
    expect(field(renderer, 'wallet-send-to').props.value).toBe('');
  });
  it('secure prompts never write storage even when a draft context is supplied', async () => {
    const renderer = await render(
      <WebPromptModal
        config={{
          id: 'secret',
          type: 'prompt',
          title: 'Secret',
          inputType: 'secure-text',
          draft: { context: 'secret', onSubmitted: () => undefined },
        }}
        onConfirm={() => undefined}
      />,
    );
    await act(async () => field(renderer, 'hull-prompt-input').props.onChangeText('credential'));
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(stored()).toEqual({});
  });
  it('typing before identity hydration survives; navigation blur flushes pending edits', async () => {
    let identity: string | null = null;
    let cachedSet: ((value: string) => void) | undefined;
    let blur!: () => void;
    const navigation = {
      addListener: (_: string, callback: () => void) => {
        blur = callback;
        return () => undefined;
      },
    };
    function Screen() {
      const [value, setValue] = useTextDraft('first-load', '', identity);
      cachedSet ??= setValue;
      return <input value={value} onChange={(event) => setValue(event.target.value)} />;
    }
    const screen = () => (
      <NavigationContext.Provider value={navigation as never}>
        <Screen />
      </NavigationContext.Provider>
    );
    const renderer = await render(screen());
    await act(async () =>
      renderer.root.findByType('input').props.onChange({ target: { value: 'new typing' } }),
    );
    identity = 'alice';
    await act(async () => renderer.update(screen()));
    expect(renderer.root.findByType('input').props.value).toBe('new typing');
    await act(async () => cachedSet!('typing after identity'));
    expect(renderer.root.findByType('input').props.value).toBe('typing after identity');
    await act(async () => blur());
    expect(stored()[textDraftKey('alice', 'first-load')]).toBe(
      JSON.stringify('typing after identity'),
    );
  });
});
