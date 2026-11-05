import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return {
    Platform: {
      get OS() {
        return 'android';
      },
      select: (choices: Record<string, unknown>) => choices.default,
    },
    View: (props: Record<string, unknown>) =>
      ReactModule.createElement('View', props, props.children as React.ReactNode),
  };
});

vi.mock('react-native-webview', () => ({
  default: (props: Record<string, unknown>) => null,
}));

import { useSandboxWebView, useSandboxWebViewStatus } from './sandbox-webview';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function Probe({ onStatus }: { onStatus: (status: string) => void }) {
  onStatus(useSandboxWebViewStatus());
  const WebView = useSandboxWebView();
  return React.createElement('View', { webview: WebView ? 'yes' : 'no' });
}

async function flush(): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('useSandboxWebViewStatus', () => {
  it('starts loading, then settles to ready when the sandboxed WebView loads', async () => {
    const statuses: string[] = [];
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(Probe, { onStatus: (s: string) => statuses.push(s) }));
    });
    await flush();
    expect(statuses[0]).toBe('loading');
    expect(statuses.at(-1)).toBe('ready');
    expect(renderer.root.findByProps({ webview: 'yes' })).toBeDefined();
  });
});
