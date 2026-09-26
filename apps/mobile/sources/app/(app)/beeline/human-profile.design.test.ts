import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./human-profile.tsx', import.meta.url), 'utf8');
const grantRow = readFileSync(
  new URL('../../../components/buzz/MemberGrantRow.tsx', import.meta.url),
  'utf8',
);

function styleBlock(text: string, name: string): string {
  const start = text.search(new RegExp(`\\n\\s+${name}: \\{`));
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

describe('Human profile layout contract', () => {
  it('sizes the access-level control to its labels instead of the content column', () => {
    // A `flex: 1` option stretched two short words across the whole profile
    // column on desktop (captain report). The row hugs its labels on the
    // section head's left edge and the options are padding-driven plates.
    expect(styleBlock(source, 'roleToggle')).toContain("alignSelf: 'flex-start'");
    expect(styleBlock(source, 'roleToggle')).toContain("flexDirection: 'row'");
    expect(styleBlock(source, 'roleChoice')).not.toMatch(/flex:\s*1/);
    expect(styleBlock(source, 'roleChoice')).toContain('paddingHorizontal: theme.buzz.space.md');
    // Compact is the width and the plate, never a shrunken hit target.
    expect(styleBlock(source, 'roleChoice')).toContain('minHeight: 44');
  });

  it('renders the member grant ledger through one disclosure row', () => {
    expect(source).toContain('<MemberGrantRow');
    expect(source).not.toMatch(/description=\{`\$\{grant\.agent\.handle/);
    // The row reuses the shared primitives: SettingsRow for the row, a quiet
    // detail body beneath it, and SettingsRow's second quiet line for the
    // provenance fact.
    expect(grantRow).toContain("from './SettingsRow'");
    expect(grantRow).toContain('descriptionDetail={provenance}');
    expect(grantRow).toContain("chevron={expanded ? 'up' : 'down'}");
    // Display only: the ledger never carries a grant mutation.
    expect(grantRow).not.toMatch(/monolithPhoneOperation|decideAgentGrant|revokeAgentGrant/);
  });
});
