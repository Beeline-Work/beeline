import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const variants = readFileSync(
  fileURLToPath(new URL('./RoomMessageVariants.tsx', import.meta.url)),
  'utf8',
);

function styleBlock(text: string, name: string): string {
  const start = text.indexOf(`  ${name}: {`);
  expect(start, `missing style ${name}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = text.indexOf('{', start); index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated style ${name}`);
}

describe('quoted reply/forward excerpt design contract', () => {
  it('reads the quoted reply reference at the lifted quiet tier', () => {
    // The ↳ reference quotes a parent message a reader may actually open, so
    // it is provenance that still gets read — never the gutter's ghost tier.
    expect(styleBlock(variants, 'replyReferenceText')).toContain(
      'color: theme.buzz.ledgerQuiet',
    );
    expect(styleBlock(variants, 'replyReferenceText')).not.toContain('ledgerGhost');
  });

  it('reads the forward caption at the lifted quiet tier', () => {
    expect(styleBlock(variants, 'forwardCaption')).toContain('color: theme.buzz.ledgerQuiet');
    expect(styleBlock(variants, 'forwardCaption')).not.toContain('ledgerGhost');
  });
});
