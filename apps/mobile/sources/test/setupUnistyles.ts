import { vi } from 'vitest';
import { beelineThemes } from '../buzz/groknight';

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
