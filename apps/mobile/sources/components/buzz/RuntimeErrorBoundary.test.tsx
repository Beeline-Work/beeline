import * as React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
const report = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/buzz/client-error-report', async original => ({ ...await original<object>(), reportClientError: report }));
vi.mock('react-native', () => {
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return { Appearance: { getColorScheme: () => 'light' }, View: host('View'), Text: host('Text'),
    ScrollView: host('ScrollView'), Pressable: host('Pressable') };
});
import { RuntimeErrorBoundary, RuntimeErrorView } from './RuntimeErrorBoundary';

it('keeps the Room mounted when the first voice render throws, reports it, and retries', async () => {
  const cause = new Error('Voice render failed');
  cause.stack = 'Error: Voice render failed\n at VoiceBar (index.android.bundle:1:42)';
  let fail = true;
  function Voice() { if (fail) throw cause; return <NativeCall />; }
  function NativeCall() { return React.createElement('Call'); }
  const end = vi.fn(async () => {}); const retry = vi.fn(() => { fail = false; });
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  let renderer: any;
  try {
    await act(async () => { renderer = create(<><TextHeader /><RuntimeErrorBoundary scope="conversation" onError={end} onRetry={retry}><Voice /></RuntimeErrorBoundary></>); });
    expect(renderer.root.findByType('Header')).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'runtime-error-message' }).props.children).toBe(cause.message);
    expect(renderer.root.findByProps({ testID: 'runtime-error-stack' }).props.children).toContain('VoiceBar');
    expect(report).toHaveBeenCalledWith('conversation', cause);
    expect(end).toHaveBeenCalledOnce();
    await act(async () => renderer.root.findByProps({ testID: 'runtime-error-retry' }).props.onPress());
    expect(retry).toHaveBeenCalledOnce();
    expect(renderer.root.findByType('Call')).toBeDefined();
    expect(renderer.root.findAllByProps({ testID: 'runtime-error' })).toHaveLength(0);
  } finally { if (renderer) await act(async () => renderer.unmount()); consoleError.mockRestore(); }
  function TextHeader() { return React.createElement('Header'); }
});

it('shows a root error without app providers and keeps Retry operable', async () => {
  const retry = vi.fn(); let renderer: any;
  await act(async () => { renderer = create(<RuntimeErrorView scope="app" error={new Error('Root failed')} retry={retry} />); });
  expect(renderer.root.findByProps({ testID: 'runtime-error-message' }).props.children).toBe('Root failed');
  await act(async () => renderer.root.findByProps({ testID: 'runtime-error-retry' }).props.onPress());
  expect(retry).toHaveBeenCalledOnce();
  await act(async () => renderer.unmount());
});
