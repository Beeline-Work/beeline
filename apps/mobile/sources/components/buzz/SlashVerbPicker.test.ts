import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

vi.mock('react-native-unistyles', () => ({
  // The picker's factory reads only `theme.buzz` tokens; a stub palette keeps
  // StyleSheet.create resolvable without pulling the real theme module.
  StyleSheet: {
    create: (
      factory: (theme: { buzz: Record<string, unknown> }) => unknown,
    ) =>
      factory({
        buzz: {
          border: '#000',
          borderQuiet: '#111',
          bgBase: '#000',
          bgHover: '#111',
          radius: 3,
          textMuted: '#888',
          textSecondary: '#999',
          textPrimary: '#fff',
          textDisabled: '#555',
          accent: '#d7af5f',
        },
      }),
    hairlineWidth: 1,
  },
}));

import type { AgentPaletteCommand } from '@/buzz/slash-verbs';
import { SlashVerbPicker } from './SlashVerbPicker';

const originalConsoleError = console.error;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
    originalConsoleError(message, ...args);
  });
});

afterAll(() => vi.restoreAllMocks());

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

const verbs = [
  {
    id: 'open-corner' as const,
    command: 'open-corner',
    label: 'Open edit corner',
    description: 'Allow the pending repository edit request',
  },
];

const advertisedCommands: AgentPaletteCommand[] = [
  { name: 'loop', description: 'Run again and again' },
  { name: 'review', description: 'Review the diff', inputHint: '[pr-number]' },
];

function find_by_test_id(renderer: ReactTestRenderer, testId: string) {
  // The pass-through host mock propagates props to children, so restrict to
  // the touchable host nodes that actually own the testID.
  return renderer.root.findAll(
    (node) => node.type === 'TouchableOpacity' && node.props.testID === testId,
  );
}

describe('SlashVerbPicker agent command palette', () => {
  it('renders ONLY from the published command list handed to it — never a hardcoded inventory', () => {
    const renderer = render(
      React.createElement(SlashVerbPicker, {
        verbs: [],
        query: '',
        highlightedIndex: 0,
        onDismiss: () => undefined,
        onSelect: () => undefined,
        commands: advertisedCommands,
        agentName: 'lena',
        agentLacksCommands: false,
        onSelectCommand: () => undefined,
      }),
    );
    expect(find_by_test_id(renderer, 'slash-agent-command-loop')).toHaveLength(1);
    expect(find_by_test_id(renderer, 'slash-agent-command-review')).toHaveLength(1);
    // No built-in verbs were offered, none are rendered.
    expect(find_by_test_id(renderer, 'slash-verb-open-corner')).toHaveLength(0);
    expect(renderer.root.props.commands).toHaveLength(2);
  });

  it('selecting an advertised command inserts it via onSelectCommand', () => {
    const onCommand = vi.fn();
    const renderer = render(
      React.createElement(SlashVerbPicker, {
        verbs,
        query: 're',
        highlightedIndex: 0,
        onDismiss: () => undefined,
        onSelect: () => undefined,
        commands: advertisedCommands,
        agentName: 'lena',
        agentLacksCommands: false,
        onSelectCommand: onCommand,
      }),
    );
    find_by_test_id(renderer, 'slash-agent-command-review')[0].props.onPress();
    expect(onCommand).toHaveBeenCalledWith('review');
  });

  it('keeps Beeline built-ins selectable alongside the agent commands', () => {
    const onVerb = vi.fn();
    const renderer = render(
      React.createElement(SlashVerbPicker, {
        verbs,
        query: '',
        highlightedIndex: 0,
        onDismiss: () => undefined,
        onSelect: onVerb,
        commands: advertisedCommands,
        agentName: 'lena',
        agentLacksCommands: false,
        onSelectCommand: () => undefined,
      }),
    );
    find_by_test_id(renderer, 'slash-verb-open-corner')[0].props.onPress();
    expect(onVerb).toHaveBeenCalledWith('open-corner');
  });

  it('states honestly when the agent does not advertise commands', () => {
    const renderer = render(
      React.createElement(SlashVerbPicker, {
        verbs,
        query: '',
        highlightedIndex: 0,
        onDismiss: () => undefined,
        onSelect: () => undefined,
        commands: [],
        agentName: 'pi runner',
        agentLacksCommands: true,
        onSelectCommand: () => undefined,
      }),
    );
    const noteViews = renderer.root.findAll(
      (node) => node.type === 'View' && node.props.testID === 'slash-agent-no-commands',
    );
    expect(noteViews).toHaveLength(1);
    // Read `.props.children` directly — JSON.stringify on test-instance props
    // walks the circular Fiber graph.
    const noteLabel = noteViews[0].findByType('Text').props.children as string;
    expect(noteLabel).toContain('PI RUNNER');
    // And the palette still shows Beeline's built-in verbs.
    expect(find_by_test_id(renderer, 'slash-verb-open-corner')).toHaveLength(1);
  });
});
