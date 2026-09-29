import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

/**
 * Motion left on, with a 16 ms frame clock (headless Chrome's virtual time does
 * not keep requestAnimationFrame running), so the waiting pulse actually runs
 * in the page and can be sampled.
 */
function liveReanimated(base: string): string {
  const swap = (from: string, to: string) => {
    if (!base.includes(from)) throw new Error(`reanimated shim changed: ${from}`);
    base = base.replace(from, to);
  };
  swap(
    'export const useReducedMotion = () => true;',
    'export const useReducedMotion = () => false;',
  );
  swap(
    'export const useSharedValue = value => ({ value });',
    'export const useSharedValue = value => React.useRef({ value }).current;',
  );
  swap(
    'export const useAnimatedStyle = factory => factory();',
    `export const useAnimatedStyle = factory => {
      const [, tick] = React.useState(0);
      React.useEffect(() => {
        const id = setInterval(() => tick(n => n + 1), 16);
        return () => clearInterval(id);
      }, []);
      return factory();
    };`,
  );
  swap(
    'export const useFrameCallback = () => ({ setActive: () => undefined, isActive: false });',
    `export const useFrameCallback = callback => {
      const ref = React.useRef(null);
      if (!ref.current) {
        let id = 0;
        ref.current = { setActive(on) {
          clearInterval(id);
          if (on) id = setInterval(() => callback({ timestamp: performance.now() }), 16);
        } };
      }
      React.useEffect(() => () => ref.current.setActive(false), []);
      return ref.current;
    };`,
  );
  return `import React from 'react';\n${base}`;
}

describe.skipIf(!existsSync(CHROME))('Room list corner dropdown in a browser', () => {
  it('opens on a waiting corner, toggles on tap, aligns status and pulses waiting in phase', async () => {
    const mobile = process.cwd();
    const shims = webProofShims(mobile);
    const { result, status, stderr } = await runBrowserProof({
      entry: path.join(mobile, 'scripts/corner-dropdown-proof.tsx'),
      mobile,
      shims: {
        ...shims,
        'react-native-reanimated': liveReanimated(shims['react-native-reanimated']!),
        'expo-router': 'export const router = { push: () => undefined };',
        'expo-haptics': `export const selectionAsync = async () => undefined;
          export const impactAsync = async () => undefined;
          export const ImpactFeedbackStyle = { Light: 'light' };`,
      },
      width: 900,
    });
    expect(status, stderr).toBe(0);
    if (process.env.PRINT_PROOF) console.log(result);
    expect(result).toContain('RESULT PASS');
  }, 90_000);
});
