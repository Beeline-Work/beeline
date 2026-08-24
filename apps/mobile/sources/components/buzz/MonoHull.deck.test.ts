import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The deck mark's three states each own ONE visual language, per the approved
 * supervision-deck mockup:
 *
 *   working   → a rotating circular ring (grey track, brass top arc).
 *   needs-you → a filled brass circle with an expanding soft ring.
 *   idle      → a hollow grey circle with no motion.
 *
 * The owner reported the working state reading as a "gold glow" — that is the
 * needs-you language leaking. These invariants keep the two apart at the
 * source level: the ring may never pulse, the pulse may never wrap the ring.
 */
const source = readFileSync(resolve(__dirname, './MonoHull.tsx'), 'utf8');

function styleBlock(text: string, name: string): string {
  const match = text.match(new RegExp(`\\b${name}: \\{[\\s\\S]*?\\n\\s*\\},`));
  if (!match) throw new Error(`style ${name} not found`);
  return match[0];
}

describe('HullDeckMark — one visual language per deck state', () => {
  it('working is a rotating circle: grey track and brass top arc', () => {
    const ring = styleBlock(source, 'stateCircleWorking');
    expect(ring).toContain('borderColor: groknight.bgTexturePeak');
    expect(ring).toContain('borderTopColor: groknight.accent');
    expect(ring).toContain('borderWidth: 1');
    expect(source).toContain('duration: 900');
    expect(source).toContain('borderRadius: diameter / 2');
  });

  it('working never glows: only needs-you mounts the soft pulse ring', () => {
    expect(source).toContain("state === 'needs-you' && !reducedMotion && (");
    expect(source).toContain('styles.stateCircleNeedsYouPulse');
    expect(source).not.toContain("state === 'working' && !reducedMotion && (");
  });

  it('needs-you is the filled accent circle plus the one expanding soft ring', () => {
    const dot = styleBlock(source, 'stateCircleNeedsYou');
    expect(dot).toContain('backgroundColor: groknight.accent');
    const pulse = styleBlock(source, 'stateCircleNeedsYouPulse');
    expect(pulse).toContain("position: 'absolute'");
    expect(pulse).toContain('borderColor: groknight.accent');
    expect(source).toContain('scale: 1 + 0.55 * phase');
  });

  it('idle is a transparent circle with a grey outline and no accent', () => {
    const circle = styleBlock(source, 'stateCircleIdle');
    expect(circle).toContain('borderColor: groknight.steel');
    expect(circle).toContain("backgroundColor: 'transparent'");
    expect(circle).not.toContain('accent');
  });

  it('restores the compact pre-#419 room scale and keeps corners smaller', () => {
    expect(source).toContain('<StateCircle state={state} scale="room" />');
    expect(source).toContain('export const stateCircleDiameter = { room: 9, corner: 7 } as const;');
    expect(source).toContain('const diameter = stateCircleDiameter[scale];');
    expect(9).toBeGreaterThan(7);
  });

  it('exposes state as accessibility metadata, never a visible word', () => {
    expect(source).toContain('accessibilityLabel={state}');
    expect(source).not.toMatch(/>\s*(IDLE|WORKING|NEEDS YOU)\s*</);
  });
});
