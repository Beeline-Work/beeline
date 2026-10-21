import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, it, expect, vi } from 'vitest';
const state = vi.hoisted(() => ({
  os: 'android',
  requests: 0,
  url: 'https://games.example.net/play/11111111-1111-4111-8111-111111111111?token=opaque',
}));
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return state.os;
    },
  },
  Text: 'Text',
  View: 'View',
}));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    create: (fn: (theme: unknown) => unknown) =>
      fn({ buzz: { space: { md: 16 }, type: { body: {} }, textSecondary: 'text' } }),
  },
}));
vi.mock('@/buzz/artifact-link', () => ({ runnableArtifactUrl: async () => { state.requests++; return state.url; } }));
vi.mock('./sandbox-webview', () => ({
  useSandboxWebView: () => 'WebView',
  useSandboxWebViewStatus: () => 'ready',
}));
import { RunnableArtifact } from './RunnableArtifact';
const attachment = {
  kind: 'artifact' as const,
  url: '/v1/media/11111111-1111-4111-8111-111111111111',
  mimeType: 'application/vnd.beeline.game+html',
  name: 'Game',
  size: 42,
};
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
describe('runnable viewer boundary', () => {
  it('has no bridge, bearer, injected script, or file/permission access; rejects external navigation', async () => {
    state.os = 'android';
    let tree: any;
    await act(async () => {
      tree = create(<RunnableArtifact attachment={attachment} />);
    });
    const props = tree.root.findByType('WebView').props;
    expect(props.source).toEqual({ uri: state.url });
    for (const name of [
      'onMessage',
      'injectedJavaScript',
      'injectedJavaScriptBeforeContentLoaded',
      'injectedJavaScriptObject',
    ])
      expect(name in props).toBe(false);
    expect(props.originWhitelist).toEqual(['*']);
    for (const target of [
      'https://server.usebeeline.app/v1/phone/identity',
      'file:///etc/passwd',
      'beeline://rooms',
      'https://games.example.net.evil.test/',
      'data:text/html,x',
      'about:blank',
    ])
      expect(props.onShouldStartLoadWithRequest({ url: target })).toBe(false);
    expect(props.onShouldStartLoadWithRequest({ url: state.url })).toBe(true);
    for (const name of [
      'allowFileAccess',
      'allowFileAccessFromFileURLs',
      'allowUniversalAccessFromFileURLs',
      'geolocationEnabled',
      'domStorageEnabled',
      'sharedCookiesEnabled',
      'thirdPartyCookiesEnabled',
      'setSupportMultipleWindows',
    ])
      expect(props[name]).toBe(false);
    expect(props.mediaCapturePermissionGrantType).toBe('deny');
    await act(async () => props.onRenderProcessGone());
    expect(tree.root.findAllByType('WebView')).toHaveLength(0);
    expect(tree.root.findByType('Text').props.children).toContain('Game stopped');
    await act(async () => tree.unmount());
  });
  it('keeps a running game mounted when trusted parent controls rerender', async () => {
    state.os = 'android';
    state.requests = 0;
    let tree: any;
    await act(async () => { tree = create(<RunnableArtifact attachment={attachment} />); });
    const game = tree.root.findByType('WebView');
    await act(async () => { tree.update(<RunnableArtifact attachment={{...attachment}} />); });
    expect(state.requests).toBe(1);
    expect(tree.root.findByType('WebView')).toBe(game);
    await act(async () => tree.unmount());
  });
  it('web grants scripts without same-origin, top navigation, or browser permissions', async () => {
    state.os = 'web';
    let tree: any;
    await act(async () => {
      tree = create(<RunnableArtifact attachment={attachment} />);
    });
    const props = tree.root.findByType('iframe').props;
    expect(props.sandbox).toBe('allow-scripts');
    expect(props.src).toBe(state.url);
    expect(props.referrerPolicy).toBe('no-referrer');
    expect(props.allow).toContain("microphone 'none'");
    await act(async () => tree.unmount());
  });
});
