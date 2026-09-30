import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { BeelineMark } from '../sources/components/buzz/BeelineMark';

/**
 * The settings screen mounts the Beeline mark in its version footer
 * (`settings/identity.tsx`, `size={32}`) and as the identity tile's avatar
 * fallback. On web that mount used to log "Received `true` for a non-boolean
 * attribute `accessible`" because `accessible` is a native-only prop that
 * react-native-svg's `<Svg>` forwarded straight to the DOM. The mark must keep
 * the same painted output, size and accessible name on every surface without
 * that warning.
 */
const SIZE = 32;

const pause = () => new Promise((resolve) => setTimeout(resolve, 200));
const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};
const report = (text: string) => {
  document.getElementById('result')!.textContent = text;
};

async function measure() {
  createRoot(document.getElementById('root')!).render(<BeelineMark size={SIZE} />);
  await pause();

  const svg = document.querySelector<SVGElement>('svg');
  assert(svg != null, 'BeelineMark did not render an <svg>');
  assert(svg!.getAttribute('width') === String(SIZE), `width reads ${svg!.getAttribute('width')}`);
  assert(
    svg!.getAttribute('height') === String(SIZE),
    `height reads ${svg!.getAttribute('height')}`,
  );
  assert(
    svg!.querySelectorAll('path').length === 2,
    'BeelineMark no longer draws both of its paths',
  );

  // The logo must stop handing React a native-only boolean prop.
  const warnings = (window as unknown as { __console: string[] }).__console.filter((entry) =>
    /non-boolean attribute/.test(entry),
  );
  assert(warnings.length === 0, `DOM prop warnings: ${warnings.join(' | ')}`);

  // The logo stays ONE named image element for a screen reader on the web.
  assert(
    svg!.getAttribute('aria-label') === 'Beeline logo',
    `accessible name reads: ${svg!.getAttribute('aria-label')}`,
  );
  assert(svg!.getAttribute('role') === 'img', `role reads: ${svg!.getAttribute('role')}`);

  report('PASS');
}

measure().catch((error) => report(String(error)));
