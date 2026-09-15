import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

// A file of its own because the dynamic-import failure must be the ONLY fact
// this module graph has ever seen: the load cache is module-level and a shared
// file would hand this test a WebView that already loaded successfully.
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

// A namespace without a default is what a broken optional native dependency
// produces; `loadSandboxWebView` resolves null and the status must say so.
vi.mock('react-native-webview', () => ({}));

import { useSandboxWebViewStatus } from './sandbox-webview';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function Probe({ onStatus }: { onStatus: (status: string) => void }) {
  onStatus(useSandboxWebViewStatus());
  return React.createElement('View');
}

async function flush(): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('useSandboxWebViewStatus', () => {
  it('reports unavailable — never a silent null — when the sandboxed WebView cannot load', async () => {
    const statuses: string[] = [];
    await act(async () => {
      create(React.createElement(Probe, { onStatus: (s: string) => statuses.push(s) }));
    });
    await flush();
    expect(statuses.at(-1)).toBe('unavailable');
  });
});
