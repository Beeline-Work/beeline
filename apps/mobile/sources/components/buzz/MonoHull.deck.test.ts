import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The deck mark's three states each own ONE visual language, per the approved
 * supervision-deck mockup:
 *
 *   working   → a rotating RING (peak track, accent top arc). Motion, no glow.
 *   needs-you → a solid 9px accent dot inside the live pulse. The only glow.
 *   idle      → a quiet 7px steel dot. No motion, no accent.
 *
 * The owner reported the working state reading as a "gold glow" — that is the
 * needs-you language leaking. These invariants keep the two apart at the
 * source level: the ring may never pulse, the pulse may never wrap the ring.
 */
const source = readFileSync(resolve(__dirname, './MonoHull.tsx'), 'utf8');

function styleBlock(text: string, name: string): string {
  const match = text.match(new RegExp(`  ${name}: \\{[\\s\\S]*?\\n  \\},`));
  if (!match) throw new Error(`style ${name} not found`);
  return match[0];
}

function branch(text: string, state: string): string {
  const start = text.indexOf(`if (state === '${state}')`);
  if (start < 0) throw new Error(`no ${state} branch`);
  const next = text.indexOf('if (state ===', start + 1);
  return text.slice(start, next > 0 ? next : text.indexOf('return', start + 600));
}

describe('HullDeckMark — one visual language per deck state', () => {
  it('working is a rotating ring: peak track, accent top arc, mockup geometry', () => {
    const ring = styleBlock(source, 'deckRingWorking');
    expect(ring).toContain('borderColor: groknight.bgTexturePeak');
    expect(ring).toContain('borderTopColor: groknight.accent');
    expect(ring).toContain('width: 14');
    expect(ring).toContain('borderWidth: 2');
  });

  it('working never glows: the ring is not wrapped in the live pulse', () => {
    expect(branch(source, 'working')).not.toContain('HullLivePulse');
  });

  it('needs-you is the solid accent dot inside the live pulse — the one glow', () => {
    const b = branch(source, 'needs-you');
    expect(b).toContain('deckDotAttention');
    expect(b).toContain('HullLivePulse');
    const dot = styleBlock(source, 'deckDotAttention');
    expect(dot).toContain('backgroundColor: groknight.accent');
    expect(dot).toContain('width: 9');
  });

  it('idle is the quiet steel dot: no accent, no motion, 7px', () => {
    const dot = styleBlock(source, 'deckDotIdle');
    expect(dot).toContain('backgroundColor: groknight.bgTexturePeak');
    expect(dot).toContain('width: 7');
    expect(dot).not.toContain('accent');
  });
});
