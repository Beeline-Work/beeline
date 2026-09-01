import { vi } from 'vitest';
import { beelineThemes } from '../buzz/groknight';

(globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = false;

vi.mock('expo-modules-core', () => ({
  CodedError: class CodedError extends Error {},
  EventEmitter: class EventEmitter {},
  requireOptionalNativeModule: () => null,
}));
vi.mock('expo-constants', () => ({
  default: { expoConfig: { extra: { app: {} } } },
}));

const theme = { buzz: beelineThemes.obsidian };

// Production configures Unistyles before rendering. Unit tests run in Node and
// intentionally do not load React Native's Flow entrypoint, so give style-only
// modules the deterministic default theme they would receive in the app.
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    hairlineWidth: 1,
    configure: vi.fn(),
    create: (definition: unknown) => typeof definition === 'function'
      ? (definition as (value: typeof theme) => unknown)(theme)
      : definition,
  },
  UnistylesRuntime: {
    setTheme: vi.fn(),
    setAdaptiveThemes: vi.fn(),
    setRootViewBackgroundColor: vi.fn(),
  },
  useUnistyles: () => ({ theme }),
}));
