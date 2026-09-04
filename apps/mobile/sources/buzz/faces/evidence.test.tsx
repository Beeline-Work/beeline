/**
 * Contact-sheet generator — NOT a test of behaviour. It renders the REAL
 * `IdentityMark` for all twelve creatures as people (dark and light plate)
 * and as agents, serialises the rendered tree to an HTML page, and writes it
 * to `FACES_EVIDENCE_DIR`. A browser screenshot of that page is what lands in
 * `apps/mobile/docs/evidence/faces/`. It is skipped unless the directory is
 * set, so the ordinary suite never writes files:
 *
 *   FACES_EVIDENCE_DIR=/tmp/faces npx vitest run sources/buzz/faces/evidence.test.tsx
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
    Image: host('Image'),
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
    StyleSheet: {
      create: (styles: unknown) => styles,
      absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    },
    View: host('View'),
  };
});
vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    default: host('Svg'),
    Circle: host('Circle'),
    Ellipse: host('Ellipse'),
    G: host('G'),
    Line: host('Line'),
    Path: host('Path'),
    Polygon: host('Polygon'),
    Rect: host('Rect'),
  };
});
vi.mock('expo-haptics', () => ({
  impactAsync: () => undefined,
  notificationAsync: () => undefined,
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  return {
    default: {
      View: (props: any) => ReactModule.createElement('AnimatedView', props, props.children),
    },
    Easing: { linear: 'linear', out: (fn: unknown) => fn, poly: (n: number) => n },
    ReduceMotion: { System: 'system' },
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useReducedMotion: () => false,
    useSharedValue: (value: number) => ({ value }),
    withRepeat: (value: unknown) => value,
    withTiming: (value: number) => value,
    withSequence: (value: unknown) => value,
    FadeInDown: { duration: () => ({}) },
  };
});

// A mutable theme so the same component can be rendered on a dark and on a
// light ground (the shipped themes are all dark).
const themeState = vi.hoisted(() => ({ buzz: { dark: true } as Record<string, unknown> }));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    hairlineWidth: 1,
    configure: vi.fn(),
    create: (definition: unknown) =>
      typeof definition === 'function'
        ? (definition as (value: typeof themeState) => unknown)(themeState)
        : definition,
  },
  UnistylesRuntime: { setTheme: vi.fn(), setAdaptiveThemes: vi.fn() },
  useUnistyles: () => ({ theme: themeState }),
}));

import { beelineThemes } from '@/buzz/groknight';
import { identityPalette } from '@/buzz/identity-mark';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { FACE_IDS } from './index';

const OUT = process.env.FACES_EVIDENCE_DIR;

type Json = { type: string; props: Record<string, any>; children?: Array<Json | string> | null };

const ATTR: Record<string, string> = {
  strokeWidth: 'stroke-width',
  strokeLinecap: 'stroke-linecap',
  strokeLinejoin: 'stroke-linejoin',
  viewBox: 'viewBox',
};
const SKIP = new Set(['children', 'style', 'accessibilityLabel']);

function css(style: unknown): string {
  const merged = Object.assign(
    {},
    ...(Array.isArray(style) ? style : [style]).filter(Boolean),
  ) as Record<string, unknown>;
  const out: string[] = [];
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) continue;
    const name = key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
    out.push(`${name}:${typeof value === 'number' ? `${value}px` : String(value)}`);
  }
  return out.join(';');
}

function html(node: Json | string): string {
  if (typeof node === 'string') return node;
  const kids = (node.children ?? []).map(html).join('');
  if (node.type === 'View' || node.type === 'AnimatedView') {
    const style = css(node.props.style);
    const position = node.type === 'View' && !/position:/.test(style) ? 'position:relative;' : '';
    return `<div style="${position}${style}">${kids}</div>`;
  }
  const tag = node.type === 'Svg' ? 'svg' : node.type.toLowerCase();
  const attrs = Object.entries(node.props)
    .filter(([key, value]) => !SKIP.has(key) && value !== undefined && typeof value !== 'function')
    .map(([key, value]) => `${key === 'testID' ? 'data-testid' : (ATTR[key] ?? key)}="${String(value)}"`)
    .join(' ');
  const xmlns = tag === 'svg' ? ' xmlns="http://www.w3.org/2000/svg"' : '';
  const style = node.type === 'Svg' && node.props.style ? ` style="${css(node.props.style)}"` : '';
  return `<${tag}${xmlns} ${attrs}${style}>${kids}</${tag}>`;
}

function tile(element: React.ReactElement): string {
  let renderer: any;
  act(() => {
    renderer = create(element);
  });
  return html(renderer.toJSON() as Json);
}

const SEED = (face: string) => `evidence-${face}-pubkey`;

describe.skipIf(!OUT)('faces contact sheet', () => {
  it('writes the sheet rendered from the real IdentityMark', () => {
    const page: string[] = [];
    const figure = (mark: string, caption: string) =>
      `<figure>${mark}<figcaption>${caption}</figcaption></figure>`;

    const section = (title: string, ground: string, ink: string, body: () => string) =>
      page.push(
        `<section style="background:${ground};color:${ink}"><h2>${title}</h2><div class="g">${body()}</div></section>`,
      );

    themeState.buzz = { ...beelineThemes.obsidian, dark: true };
    section('People · dark plate (Obsidian, as shipped)', '#14091A', '#c9c9d1', () =>
      FACE_IDS.map((face) =>
        figure(
          tile(React.createElement(IdentityMark, { seed: SEED(face), kind: 'human', face, size: 64 })),
          face,
        ),
      ).join(''),
    );
    section('Agents · bone-and-ink creature on the hue plate', '#14091A', '#c9c9d1', () =>
      FACE_IDS.map((face) =>
        figure(
          tile(React.createElement(IdentityMark, { seed: SEED(face), kind: 'agent', face, size: 64 })),
          face,
        ),
      ).join(''),
    );
    section('Agents · alive ring, and the 26px byline scale', '#14091A', '#c9c9d1', () =>
      [
        figure(
          tile(
            React.createElement(IdentityMark, {
              seed: SEED('fox'),
              kind: 'agent',
              face: 'fox',
              size: 64,
              alive: true,
            }),
          ),
          'alive',
        ),
        ...(['hare', 'owl'] as const).flatMap((face) => [
          figure(
            tile(React.createElement(IdentityMark, { seed: SEED(face), kind: 'human', face, size: 26 })),
            `${face} 26`,
          ),
          figure(
            tile(React.createElement(IdentityMark, { seed: SEED(face), kind: 'agent', face, size: 26 })),
            `${face} 26`,
          ),
        ]),
        figure(
          `<div class="by"><span>${tile(
            React.createElement(IdentityMark, { seed: SEED('bear'), kind: 'human', face: 'bear', size: 26 }),
          )}</span><span class="n" style="color:${identityPalette(SEED('bear'), 'human').mid}">Alex</span><span class="st">11:38</span></div>`,
          'byline',
        ),
      ].join(''),
    );

    themeState.buzz = { ...beelineThemes.obsidian, dark: false };
    section('People · light plate (edge layer flips to INK)', '#F7F3F8', '#3A2F41', () =>
      FACE_IDS.map((face) =>
        figure(
          tile(React.createElement(IdentityMark, { seed: SEED(face), kind: 'human', face, size: 64 })),
          face,
        ),
      ).join(''),
    );

    const doc = `<!doctype html><meta charset="utf-8"><title>Beeline faces — rendered from IdentityMark</title>
<style>
body{margin:0;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:11px}
section{padding:18px 24px}h2{font:600 13px/1.2 "Space Grotesk",system-ui,sans-serif;margin:0 0 12px}
.g{display:flex;flex-wrap:wrap;gap:14px 12px;align-items:flex-end}
figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:6px}
figcaption{letter-spacing:.08em;opacity:.7}
.by{display:flex;align-items:center;gap:8px;padding:6px 8px}.by .n{font:500 16px "Space Grotesk",system-ui,sans-serif}.by .st{opacity:.6;margin-left:12px}
</style>
${page.join('\n')}`;
    mkdirSync(OUT!, { recursive: true });
    writeFileSync(`${OUT}/faces.html`, doc);
    expect(doc).toContain('face-figure');
  });
});
