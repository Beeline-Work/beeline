import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { AsyncLock } from '../utils/lock';

// Exercise the root's actual loader without mounting its unrelated providers.
function rootLoader(loadAsync: ReturnType<typeof vi.fn>) {
  const layout = readFileSync(new URL('../app/_layout.tsx', import.meta.url), 'utf8');
  const source = layout.slice(
    layout.indexOf('let lock ='),
    layout.indexOf('export default function RootLayout'),
  );
  const js = ts.transpile(source, { target: ts.ScriptTarget.ES2022 });
  return new Function(
    'AsyncLock',
    'Fonts',
    'FontAwesome',
    'Platform',
    'require',
    `${js}; return loadFonts;`,
  )(
    AsyncLock,
    { loadAsync },
    { font: { FontAwesome: 'icons.ttf' } },
    { OS: 'web' },
    (asset: string) => asset,
  ) as () => Promise<void>;
}

function icon(loadAsync: ReturnType<typeof vi.fn>, platform = 'web') {
  const require = createRequire(import.meta.url);
  const path = require.resolve('@expo/vector-icons/build/createIconSet');
  const js = ts.transpile(readFileSync(path, 'utf8'), {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.React,
  });
  const exports: any = {};
  const deps = (name: string) => {
    if (name === 'expo-font') return { loadAsync, isLoaded: () => false };
    if (name === 'react-native')
      return { Platform: { OS: platform }, Text: () => null, PixelRatio: { get: () => 1 } };
    if (name === 'react') return { default: require('react') };
    return { default: () => () => null };
  };
  new Function('require', 'exports', js)(deps, exports);
  const Icon = exports.default({ back: 65 }, 'Ionicons', 'icons.ttf');
  const instance = new Icon({ name: 'back' });
  instance.setState = vi.fn();
  return instance;
}

describe('FONT-STARTUP-1 root font loading', () => {
  it('does not cache a rejected timeout, so a later startup can recover', async () => {
    const error = new Error('12000ms timeout exceeded');
    const load = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const start = rootLoader(load);
    await expect(start()).rejects.toBe(error);
    await start();
    await start();
    expect(load).toHaveBeenCalledTimes(2);
    expect(Object.keys(load.mock.calls[1][0])).toEqual([
      'IBMPlexMono-Regular',
      'IBMPlexMono-Italic',
      'IBMPlexMono-SemiBold',
      'SpaceGrotesk-Regular',
      'SpaceGrotesk-Medium',
      'SpaceGrotesk-SemiBold',
      'FontAwesome',
    ]);
  });
});

describe('ICON-FONT-1 icon mount font loading', () => {
  it.each(['12000ms timeout exceeded', 'A network error occurred.'])(
    'handles web failure: %s',
    async (message) => {
      const error = new Error(message);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const instance = icon(vi.fn().mockRejectedValue(error));
        await expect(instance.componentDidMount()).resolves.toBeUndefined();
        expect(instance.state.fontIsLoaded).toBe(false);
        expect(instance.setState).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ionicons'), error);
      } finally {
        warn.mockRestore();
      }
    },
  );

  it('shows the original icon after successful loading', async () => {
    const load = vi.fn().mockResolvedValue(undefined);
    const instance = icon(load);
    await instance.componentDidMount();
    expect(load).toHaveBeenCalledWith({ Ionicons: 'icons.ttf' });
    expect(instance.setState).toHaveBeenCalledWith({ fontIsLoaded: true });
  });

  it('preserves native error propagation', async () => {
    const error = new Error('native failure');
    await expect(icon(vi.fn().mockRejectedValue(error), 'ios').componentDidMount()).rejects.toBe(
      error,
    );
  });

  it('does not update an unmounted icon after loading', async () => {
    let finish!: () => void;
    const instance = icon(
      vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const loading = instance.componentDidMount();
    instance.componentWillUnmount();
    finish();
    await loading;
    expect(instance.setState).not.toHaveBeenCalled();
  });
});
