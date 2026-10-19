import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { obsidianTheme } from './theme';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const inlineRequires = require('metro-transform-plugins').inlineRequiresPlugin;
const mobile = resolve(import.meta.dirname, '..');

// Exercise Expo's module transform followed by the same lazy-require pass as
// Metro. A source-only import check misses the merged, deferred theme import.
function transform(file: string): string {
  const filename = resolve(mobile, file);
  const expo = babel.transformSync(readFileSync(filename, 'utf8'), {
    filename,
    cwd: mobile,
    caller: { name: 'metro', platform: 'android', isDev: false, supportsStaticESM: false },
  });
  return babel.transformSync(expo.code, {
    configFile: false,
    babelrc: false,
    plugins: [inlineRequires],
  }).code;
}

describe('native voice proof startup after Metro inline requires', () => {
  it.each([
    'scripts/multi-human-silence-native-proof.tsx',
    'scripts/voice-delivery-native-proof.tsx',
  ])('%s selects a theme before loading the call stylesheet', (entry) => {
    let selected = false;
    let initializedAtRegistration = false;
    let root: (() => unknown) | undefined;
    let stylesheetLoads = 0;
    const card = { startedAt: 1, participants: [] };
    let stateIndex = 0;
    const react = {
      useState: () => [['fixture-room', card, 1][stateIndex++], () => {}],
      useEffect: () => {},
    };
    const jsx = (type: unknown, props: unknown) => ({ type, props });
    const nativeRequire = (id: string): unknown => {
      if (id.startsWith('@babel/runtime/')) return require(id);
      if (id === 'react') return react;
      if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (id === 'expo') return { registerRootComponent: (component: () => unknown) => {
        initializedAtRegistration = selected;
        root = component;
      } };
      if (id === 'expo-font') return { useFonts: () => [true] };
      if (id === 'react-native') return { LogBox: { ignoreAllLogs() {} }, View: 'View', Text: 'Text', Pressable: 'Pressable' };
      if (id === '../sources/unistyles') {
        selected = true;
        return { setAppAppearance() {} };
      }
      if (id.endsWith('/use-voice-call')) return { useVoiceCall: () => ({ call: null, humans: 0 }) };
      if (id.endsWith('/VoiceCallCard')) {
        const exports = {};
        runInNewContext(transform('sources/components/buzz/VoiceCallCard.tsx'), { exports, require: nativeRequire });
        return exports;
      }
      if (id === 'react-native-unistyles') return {
        StyleSheet: { create: (definition: (theme: typeof obsidianTheme) => unknown) => {
          if (!selected) throw new Error('Call stylesheet evaluated before the initial theme was selected');
          stylesheetLoads++;
          return definition(obsidianTheme);
        } },
      };
      if (id === 'livekit-client') return { Room: class { emit() {} }, RoomEvent: {} };
      if (id.endsWith('/monolith-session')) return { monolithSession: {} };
      // Remaining imports are fonts, polyfills and components not rendered by
      // this startup-order check. Native rendering is covered on the emulator.
      return {};
    };

    runInNewContext(transform(entry), { require: nativeRequire, exports: {}, fetch() {} });
    expect(root).toBeTypeOf('function');
    const screen = root!() as { type: (props: unknown) => unknown; props: unknown };
    screen.type(screen.props);
    expect(initializedAtRegistration).toBe(true);
    expect(selected).toBe(true);
    expect(stylesheetLoads).toBe(1);
  });
});
