import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { MCP_STARTER_ROUTINE } from '@beeline/api-contract/phone';

const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn(async (_text: string) => undefined) }));
vi.mock('expo-clipboard', () => clipboard);
vi.mock('react-native', async () => {
  const R = await import('react');
  return { View: (p: any) => R.createElement('View', p, p.children), Text: (p: any) => R.createElement('Text', p, p.children) };
});
vi.mock('react-native-unistyles', () => ({
  StyleSheet: { create: (factory: any) => factory({ buzz: { space: { lg: 24, xs: 4, sm: 8 }, type: { body: {} }, textSecondary: 'ink' } }) },
}));
vi.mock('./SettingsRow', async () => {
  const R = await import('react');
  return { SettingsRow: (p: any) => R.createElement('SettingsRow', p) };
});
const { McpStarterRoutine } = await import('./McpStarterRoutine');

it('shows the complete starter prompt and copies exactly that text, with a retry after failure', async () => {
  let renderer: any;
  act(() => { renderer = create(<McpStarterRoutine />); });
  try {
    const row = () => renderer.root.findByType('SettingsRow');
    expect(row().props.title).toBe('Starter instructions');
    expect(row().props.actionControl.label).toBe('Copy');
    expect(renderer.root.findByProps({ testID: 'mcp-starter-routine-text' }).props.children).toBe(MCP_STARTER_ROUTINE);
    clipboard.setStringAsync.mockRejectedValueOnce(new Error('clipboard unavailable'));
    await act(async () => { row().props.actionControl.onPress(); });
    expect(row().props.description).toContain('Could not copy');
    await act(async () => { row().props.actionControl.onPress(); });
    expect(clipboard.setStringAsync).toHaveBeenLastCalledWith(MCP_STARTER_ROUTINE);
    expect(row().props.actionControl.label).toBe('Copied');
  } finally { act(() => renderer.unmount()); }
});
