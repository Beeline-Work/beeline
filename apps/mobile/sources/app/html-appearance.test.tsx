import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-router/html', () => ({
  ScrollViewStyleReset: () => null,
}));
vi.mock('../unistyles', () => ({}));

import Root from './+html';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function renderRoot() {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<Root>{null}</Root>);
  });
  return renderer.toJSON();
}

function findByType(node: any, type: string): any {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByType(child, type);
      if (found) return found;
    }
    return null;
  }
  if (node.type === type) return node;
  for (const child of node.children ?? []) {
    const found = findByType(child, type);
    if (found) return found;
  }
  return null;
}

function runAppearanceScript(scriptSource: string, storedSettings: unknown): string[] {
  const appended: string[] = [];
  const documentStub = {
    head: { appendChild: (node: { textContent: string }) => appended.push(node.textContent) },
    createElement: () => ({ textContent: '' }),
  };
  const windowStub = {
    localStorage: {
      getItem: (key: string) =>
        key === 'beeline.settings.local-settings' && storedSettings !== undefined
          ? JSON.stringify(storedSettings)
          : null,
    },
  };
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'document', scriptSource);
  run(windowStub, documentStub);
  return appended;
}

describe('the static HTML shell', () => {
  it('embeds a blocking inline script (not deferred/module) that overrides the CSS default', () => {
    const tree = renderRoot();
    const script = findByType(tree, 'script');
    expect(script).not.toBeNull();
    expect(script.props.defer).toBeUndefined();
    expect(script.props.async).toBeUndefined();
    expect(script.props.type).toBeUndefined();

    const source = script.props.dangerouslySetInnerHTML.__html as string;
    expect(runAppearanceScript(source, { appearance: 'light' })).toEqual([
      'body { background-color: #F3EEE4; }',
    ]);
    expect(runAppearanceScript(source, { appearance: 'dark' })).toEqual([]);
    expect(runAppearanceScript(source, undefined)).toEqual([]);
  });

  it('defaults the static CSS to the Obsidian canvas, matching localSettingsDefaults', () => {
    const tree = renderRoot();
    const style = findByType(tree, 'style');
    expect(style.props.dangerouslySetInnerHTML.__html).toContain('#14091A');
    expect(style.props.dangerouslySetInnerHTML.__html).not.toContain('prefers-color-scheme');
  });
});
