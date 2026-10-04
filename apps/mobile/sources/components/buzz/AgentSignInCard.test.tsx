import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSignInCardView } from '@beeline/api-contract/phone';

const linking = vi.hoisted(() => ({ openURL: vi.fn(async () => undefined) }));
const clipboard = vi.hoisted(() => ({
  setStringAsync: vi.fn(async () => undefined),
  getStringAsync: vi.fn(async () => ''),
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
  return { Linking: linking, Text: host('Text'), TextInput: host('TextInput'), View: host('View') };
});
vi.mock('react-native-unistyles', () => {
  const theme = {
    buzz: {
      space: { xs: 4, sm: 8, md: 16 },
      radius: 3,
      type: { body: {}, meta: {}, machine: {} },
      textPrimary: 'ink',
      textSecondary: 'ink2',
      textMuted: 'muted',
      ledgerQuiet: 'quiet',
      accent: 'brass',
      border: 'border',
      borderStrong: 'borderStrong',
      bgBase: 'canvas',
    },
  };
  return {
    StyleSheet: { create: (styles: any) => (typeof styles === 'function' ? styles(theme) : styles) },
    useUnistyles: () => ({ theme }),
  };
});
vi.mock('expo-clipboard', () => clipboard);
vi.mock('./TranscriptCard', async () => {
  const ReactModule = await import('react');
  return {
    TranscriptCard: (props: any) =>
      ReactModule.createElement(
        'TranscriptCard',
        props,
        ReactModule.createElement('Head', null, props.identity),
        props.children,
      ),
  };
});
vi.mock('./AppMark', async () => {
  const ReactModule = await import('react');
  return { AppMark: (props: any) => ReactModule.createElement('AppMark', props) };
});
vi.mock('./Button', async () => {
  const ReactModule = await import('react');
  return { Button: (props: any) => ReactModule.createElement('Button', props) };
});
vi.mock('./StateDot', async () => {
  const ReactModule = await import('react');
  return { StateDot: (props: any) => ReactModule.createElement('StateDot', props) };
});
vi.mock('./WorkflowRunLine', async () => {
  const ReactModule = await import('react');
  return { WorkflowStepCircle: (props: any) => ReactModule.createElement('WorkflowStepCircle', props) };
});

const { AgentSignInCard } = await import('./AgentSignInCard');

const AGENT = 'a'.repeat(64);
const OWNER = 'b'.repeat(64);
const renderers: ReactTestRenderer[] = [];
afterEach(() => {
  for (const renderer of renderers.splice(0)) act(() => renderer.unmount());
  vi.clearAllMocks();
});

function render(card: AgentSignInCardView, isOwner = true, onSubmit = vi.fn(async () => undefined)) {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <AgentSignInCard agentName="Hoots" card={card} isOwner={isOwner} onSubmit={onSubmit} />,
    );
  });
  renderers.push(renderer);
  return { renderer, onSubmit };
}

const byId = (renderer: ReactTestRenderer, testID: string) =>
  renderer.root.findByProps({ testID });
const texts = (node: ReactTestRenderer | { findAllByType: ReactTestRenderer['root']['findAllByType'] }) =>
  ('root' in node ? node.root : node)
    .findAllByType('Text' as any)
    .map((node: any) => node.props.children)
    .filter((child: unknown) => typeof child === 'string');

describe('@agent login card', () => {
  const claude: AgentSignInCardView = {
    agentId: AGENT,
    ownerId: OWNER,
    harness: 'claude',
    status: 'pending',
    kind: 'paste-code',
    authorizeUrl: 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c',
  };

  it("carries the company's logo, not an identity plate", () => {
    const logo = (card: AgentSignInCardView) =>
      render(card).renderer.root.findByType('AppMark' as any).props;
    expect(logo(claude)).toMatchObject({ name: 'Claude', domain: 'claude.ai', size: 26 });
    expect(logo({ ...claude, harness: 'codex', kind: 'device-code' })).toMatchObject({
      name: 'ChatGPT',
      domain: 'openai.com',
    });
    expect(logo({ ...claude, harness: 'grok' })).toMatchObject({ name: 'Grok', domain: 'x.ai' });
    expect(logo({ ...claude, harness: 'cursor' })).toMatchObject({ name: 'Cursor', domain: 'cursor.com' });
    expect(
      logo({ ...claude, harness: 'pi', kind: 'api-key', provider: 'openrouter', authorizeUrl: undefined }),
    ).toMatchObject({ name: 'OpenRouter', domain: 'openrouter.ai' });
  });

  it('runs the paste-back steps for the owner and sends the code once', async () => {
    const { renderer, onSubmit } = render(claude);
    const card = renderer.root.findByType('TranscriptCard' as any).props;
    expect(card).toMatchObject({ tier: 'ask', title: 'Sign in to Claude', subline: 'Hoots · Claude Code' });
    expect(byId(renderer, 'agent-sign-in-url').props.children).toBe(
      'claude.com/cai/oauth/authorize?code=true&client_id=9d1c',
    );
    act(() => byId(renderer, 'agent-sign-in-open').props.onPress());
    expect(linking.openURL).toHaveBeenCalledWith(claude.authorizeUrl);
    expect(texts(renderer)).toContain('Approved on claude.ai');
    expect(byId(renderer, 'agent-sign-in-submit').props.disabled).toBe(true);
    act(() => byId(renderer, 'agent-sign-in-input').props.onChangeText('8hKq2abcdWd9#Xp4rabcdaZ1'));
    expect(byId(renderer, 'agent-sign-in-shape').props.children).toBe(
      '✓ Looks like a Claude login code · 8hKq2…daZ1',
    );
    await act(async () => byId(renderer, 'agent-sign-in-submit').props.onPress());
    expect(onSubmit).toHaveBeenCalledWith('8hKq2abcdWd9#Xp4rabcdaZ1');
    expect(byId(renderer, 'agent-sign-in-input').props.value).toBe('');
  });

  it('pastes from the clipboard and shows a rejection as a brass ✗ with its reason', async () => {
    clipboard.getStringAsync.mockResolvedValueOnce('  old-code  ');
    const rejected = 'Claude did not accept that code.';
    const { renderer } = render(claude, true, vi.fn(async () => {
      throw new Error(rejected);
    }));
    await act(async () => {
      byId(renderer, 'agent-sign-in-paste').props.onPress();
      await vi.waitFor(() => expect(clipboard.getStringAsync).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(byId(renderer, 'agent-sign-in-input').props.value).toBe('old-code');
    await act(async () => byId(renderer, 'agent-sign-in-submit').props.onPress());
    expect(texts(byId(renderer, 'agent-sign-in-error') as any)).toEqual(['✗', rejected]);
  });

  it('shows a device code to type on the provider page and waits', async () => {
    const { renderer } = render({
      ...claude,
      harness: 'codex',
      kind: 'device-code',
      authorizeUrl: 'https://auth.openai.com/codex/device',
      userCode: 'EBQ9-VJCLN',
      expiresAt: Date.now() + 15 * 60_000,
    });
    expect(renderer.root.findByType('TranscriptCard' as any).props.title).toBe('Sign in to ChatGPT');
    expect(byId(renderer, 'agent-sign-in-code').props.children).toBe('EBQ9-VJCLN');
    await act(async () => {
      byId(renderer, 'agent-sign-in-copy').props.onPress();
    });
    await vi.waitFor(() => expect(clipboard.setStringAsync).toHaveBeenCalledWith('EBQ9-VJCLN'));
    expect(renderer.root.findByType('StateDot' as any).props.kind).toBe('pulse');
    expect(texts(renderer)).toContain('Waiting for approval · expires in 15 min');
    expect(texts(renderer)).toContain('Device-code sign-in must be on in ChatGPT → Settings → Security.');
    expect(renderer.root.findAllByProps({ testID: 'agent-sign-in-input' })).toHaveLength(0);
  });

  it('runs approve-and-wait with nothing to paste', () => {
    const { renderer } = render({
      ...claude,
      harness: 'cursor',
      kind: 'approve-wait',
      authorizeUrl: 'https://cursor.com/loginDeepControl?challenge=x&uuid=y',
    });
    expect(texts(renderer)).toContain('Approve on cursor.com');
    expect(texts(renderer)).toContain('Waiting for approval');
    expect(renderer.root.findAllByProps({ testID: 'agent-sign-in-input' })).toHaveLength(0);
  });

  it('takes a provider key in a masked field', async () => {
    const { renderer, onSubmit } = render({
      agentId: AGENT,
      ownerId: OWNER,
      harness: 'pi',
      status: 'pending',
      kind: 'api-key',
      provider: 'openrouter',
    });
    expect(renderer.root.findByType('TranscriptCard' as any).props.title).toBe('Add an OpenRouter key');
    expect(byId(renderer, 'agent-sign-in-input').props.secureTextEntry).toBe(true);
    act(() => byId(renderer, 'agent-sign-in-input').props.onChangeText('sk-or-key'));
    await act(async () => byId(renderer, 'agent-sign-in-submit').props.onPress());
    expect(onSubmit).toHaveBeenCalledWith('sk-or-key');
  });

  it('shows anyone else only whose sign-in it is', () => {
    const { renderer } = render(claude, false);
    const card = renderer.root.findByType('TranscriptCard' as any).props;
    expect(card).toMatchObject({ tier: 'record', subline: 'Hoots · waiting for its owner' });
    expect(renderer.root.findAllByProps({ testID: 'agent-sign-in-url' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'agent-sign-in-input' })).toHaveLength(0);
  });

  it('settles to a record once signed in, and says why when the machine is offline', () => {
    const done = render({ ...claude, status: 'signed-in' }).renderer.root.findByType('TranscriptCard' as any).props;
    expect(done).toMatchObject({ tier: 'record', title: 'Signed in to Claude', subline: 'Hoots uses it next turn' });
    const offline = "The agent's machine is offline. Start its helper with `beeline start`, then try again.";
    const { renderer } = render({ ...claude, status: 'failed', authorizeUrl: undefined, kind: undefined, errorMessage: offline });
    expect(texts(byId(renderer, 'agent-sign-in-error') as any)).toEqual(['✗', offline]);
    const starting = render({ agentId: AGENT, ownerId: OWNER, harness: 'goose', status: 'starting' }).renderer;
    expect(texts(starting)).toContain("Asking Hoots's machine to start its sign-in…");
  });
});
