import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The approve-and-merge moment is the one place besides identity/presence
 * that DESIGN.md's single gold accent is allowed to appear (see "The two
 * color exceptions" there) — and it must read as unmistakably different from
 * every other gray control, not just another muted button. This locks the
 * button in as filled gold + a real border weight, not merely gold text on
 * an otherwise gray surface.
 */
const CHAT_SCREEN_PATH = '../../app/(app)/buzz/chat/[channelId].tsx';

function styleDefinition(source: string, name: string): string {
  const start = source.indexOf(`  ${name}: {`);
  expect(start, `missing style definition for ${name}`).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unclosed style definition for ${name}`);
}

describe('merge-approve control accent', () => {
  const source = readFileSync(new URL(CHAT_SCREEN_PATH, import.meta.url), 'utf8');

  it('names the approve-merge accent after the single sanctioned design token, not a new color', () => {
    expect(source).toMatch(/const MERGE_APPROVAL_ACCENT = groknight\.accent;/);
  });

  it('fills and borders the approve button with the accent, at real border weight', () => {
    const definition = styleDefinition(source, 'approveButton');
    expect(definition).toMatch(/backgroundColor:\s*MERGE_APPROVAL_ACCENT/);
    expect(definition).toMatch(/borderColor:\s*MERGE_APPROVAL_ACCENT/);
    const borderWidth = Number(definition.match(/borderWidth:\s*(\d+)/)?.[1] ?? '0');
    expect(borderWidth).toBeGreaterThanOrEqual(2);
  });

  it('does not spend the accent on any other approval-bar element', () => {
    for (const name of ['approvalBar', 'approvalPending', 'approvalSent', 'approvalStateText']) {
      const definition = styleDefinition(source, name);
      expect(definition, `styles.${name}`).not.toMatch(/MERGE_APPROVAL_ACCENT|groknight\.accent/);
    }
  });
});
