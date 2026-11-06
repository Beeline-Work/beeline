import React from 'react';
import { View } from 'react-native';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ failed: false, reconnect: vi.fn() }));
vi.mock('@/sync/transport/live-connection', () => ({
  useConnectionFailure: () => state.failed,
  reconnectNow: state.reconnect,
}));
vi.mock('react-native', () => ({ View: 'View', Pressable: 'Pressable', Text: 'Text' }));
vi.mock('react-native-safe-area-context', () => {
  const SafeAreaInsetsContext = React.createContext({ top: 24, bottom: 16, left: 0, right: 0 });
  return { SafeAreaInsetsContext, useSafeAreaInsets: () => React.useContext(SafeAreaInsetsContext) };
});
vi.mock('./Button', () => ({ Button: 'Button' }));
vi.mock('./ChevronGlyph', () => ({ ChevronGlyph: 'ChevronGlyph', CHEVRON_ROW_SIZE: 16 }));
vi.mock('./HullSwitch', () => ({ HullSwitch: 'HullSwitch' }));
vi.mock('./StateDot', () => ({ StateDot: 'StateDot' }));
import { IndexRow } from './IndexRow';
import { ConnectionStatus } from './ConnectionStatus';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; state.failed = false; state.reconnect.mockClear(); });

it('shows one recovery row only after failure and removes it on the next success', async () => {
  let tree: any;
  try {
    await act(async () => { tree = create(<ConnectionStatus />); });
    expect(tree.toJSON()).toBeNull();
    state.failed = true;
    await act(async () => tree.update(<ConnectionStatus />));
    const rows = tree.root.findAllByType(IndexRow);
    expect(rows).toHaveLength(1);
    expect(rows[0].props.title).toBe('Beeline isn’t connected');
    await act(async () => rows[0].props.onPress());
    expect(state.reconnect).toHaveBeenCalledOnce();
    state.failed = false;
    await act(async () => tree.update(<ConnectionStatus />));
    expect(tree.toJSON()).toBeNull();
  } finally { if (tree) await act(async () => tree.unmount()); }
});

it('consumes the top safe area once and retains the mounted Room when the banner changes', async () => {
  const mounted = vi.fn();
  function Room() {
    React.useEffect(() => { mounted(); }, []);
    return React.createElement('RoomHeader', { insets: useSafeAreaInsets() });
  }
  let tree: any;
  try {
    await act(async () => { tree = create(<ConnectionStatus><Room /></ConnectionStatus>); });
    expect(tree.root.findByType('RoomHeader').props.insets).toMatchObject({ top: 24, bottom: 16 });
    state.failed = true;
    await act(async () => tree.update(<ConnectionStatus><Room /></ConnectionStatus>));
    expect(tree.root.findByProps({ testID: 'connection-status-disconnected' }).props.style[1].paddingTop).toBe(24);
    expect(tree.root.findByType('RoomHeader').props.insets).toMatchObject({ top: 0, bottom: 16 });
    expect(tree.root.findByType(IndexRow).props.wrap).toBe(true);
    state.failed = false;
    await act(async () => tree.update(<ConnectionStatus><Room /></ConnectionStatus>));
    expect(tree.root.findByType('RoomHeader').props.insets.top).toBe(24);
    expect(mounted).toHaveBeenCalledOnce();
  } finally { if (tree) await act(async () => tree.unmount()); }
});

it('keeps the actual recovery row intrinsic and all of its text wrapping at phone width', async () => {
  state.failed = true;
  let tree: any;
  try {
    await act(async () => { tree = create(<View style={{ width: 390 }}><ConnectionStatus /></View>); });
    const flatten = (style: any): any => Array.isArray(style)
      ? Object.assign({}, ...style.filter(Boolean).map(flatten)) : style ?? {};
    const banner = flatten(tree.root.findByProps({ testID: 'connection-status-disconnected' }).props.style);
    const row = tree.root.findByType('Pressable');
    const rowStyle = flatten(row.props.style({ pressed: false }));
    const copy = tree.root.findAllByType('Text').map((node: any) => ({
      text: node.props.children, numberOfLines: node.props.numberOfLines,
    }));
    expect({
      width: 390, bannerHeight: banner.height, bannerFlex: banner.flex,
      bannerFlexShrink: banner.flexShrink, safeAreaTop: banner.paddingTop,
      rowHeight: rowStyle.height, rowPadding: rowStyle.paddingVertical, copy,
    }).toMatchInlineSnapshot(`
      {
        "bannerFlex": undefined,
        "bannerFlexShrink": 0,
        "bannerHeight": undefined,
        "copy": [
          {
            "numberOfLines": undefined,
            "text": "Beeline isn’t connected",
          },
          {
            "numberOfLines": undefined,
            "text": "Try your request again.",
          },
          {
            "numberOfLines": undefined,
            "text": "Reconnect",
          },
        ],
        "rowHeight": undefined,
        "rowPadding": 14,
        "safeAreaTop": 24,
        "width": 390,
      }
    `);
  } finally { if (tree) await act(async () => tree.unmount()); }
});
