import { groknight } from '../../apps/mobile/sources/buzz/groknight';

// Preserve each component's production style callback and token values.
export const StyleSheet = {
  create<T>(styles: ((theme: { buzz: typeof groknight }) => T) | T): T {
    return typeof styles === 'function' ? styles({ buzz: groknight }) : styles;
  },
};
