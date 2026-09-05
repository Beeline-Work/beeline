import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * Settings reads as the Members page's sibling (captain report, C106).
 *
 * Both settings screens were built before the Members page was aligned in
 * #875/#883/#902/#907, and drifted into their own vocabularies: a picture slab
 * with a 72px tile for one action, a boxed name field over a full-width
 * disabled commit plate, a visibility question in title type over a paragraph
 * over two toggle boxes, and — on the account hub — four different trailing
 * marks on one screen (a chevron, `MANAGE ↗`, a text button, and a ⌫ glyph).
 *
 * This holds the repair: one list, one row primitive, one trailing vocabulary,
 * values off the titles, no boxes around rows, no paragraph explainers.
 */
const settingsRow = readFileSync(
  new URL('../../../../components/buzz/SettingsRow.tsx', import.meta.url),
  'utf8',
);
const members = readFileSync(new URL('../MembersScreen.tsx', import.meta.url), 'utf8');
const account = readFileSync(new URL('./index.tsx', import.meta.url), 'utf8');
const workspace = readFileSync(new URL('./workspace.tsx', import.meta.url), 'utf8');

function styleBlock(text: string, name: string): string {
  const start = text.indexOf(`    ${name}: {`);
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

/** Every declaration in a style block, order-insensitive. */
function declarations(block: string): string[] {
  return block
    .slice(block.indexOf('{') + 1, block.lastIndexOf('}'))
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .sort();
}

describe('Settings reads as the Members page', () => {
  it('cuts the shared settings row to the Members row, declaration for declaration', () => {
    expect(declarations(styleBlock(settingsRow, 'row'))).toEqual(
      declarations(styleBlock(members, 'row')),
    );
  });

  it('sets both screens’ section heads in the Members page’s own head style', () => {
    const membersHead = declarations(styleBlock(members, 'sectionLabel'));
    for (const [name, source] of [
      ['index.tsx', account],
      ['workspace.tsx', workspace],
    ] as const) {
      const head = declarations(styleBlock(source, 'sectionLabel'));
      expect(head, `${name} section head`).toEqual(
        expect.arrayContaining(membersHead.filter((line) => !line.startsWith('paddingRight'))),
      );
      expect(head.join(' '), `${name} section head`).toContain('hull.type.sectionHead');
    }
  });

  it('keeps the trailing column a closed vocabulary on one axis', () => {
    // A chevron to leave for something, a value to state one, a single action
    // word to act — and nothing else. No screen invents a fourth mark.
    expect(settingsRow).toMatch(/tone\?: 'action' \| 'destructive' \| 'quiet'/);
    for (const [name, source] of [
      ['index.tsx', account],
      ['workspace.tsx', workspace],
    ] as const) {
      expect(source, `${name} hand-draws a trailing mark`).not.toMatch(
        /⌫|MANAGE ↗|rowGutter|updateAction|visibilityButton|segmentText/,
      );
    }
    // The account hub's four marks are gone: `MANAGE ↗` is the one action word.
    expect(account).toContain('action="Manage ↗"');
  });

  it('boxes nothing that repeats, on either screen', () => {
    // DESIGN.md → Shape: a box wraps only an input, a button, or a genuinely
    // non-repeating region. The rows carry a hairline and nothing else.
    expect(declarations(styleBlock(settingsRow, 'row')).join(' ')).not.toMatch(
      /borderWidth|borderRadius|backgroundColor/,
    );
    // Workspace Settings keeps exactly two boxes: the rename input and the
    // error notice. The account hub keeps one: the sign-out confirmation.
    expect(workspace.match(/borderWidth: StyleSheet\.hairlineWidth/g)).toHaveLength(2);
    expect(workspace.match(/borderRadius: hull\.radius/g)).toHaveLength(2);
    expect(account.match(/borderWidth: StyleSheet\.hairlineWidth/g)).toHaveLength(1);
    expect(account.match(/borderRadius: hull\.radius/g)).toHaveLength(1);
  });

  it('carries no paragraph explainer and no question in title type', () => {
    // The visibility question, its two-line paragraph and its two toggle boxes
    // are one row and a Hull sheet now; the explanation is the sheet's one
    // subtitle line.
    expect(workspace).not.toMatch(/sectionTitle|sectionBody|segmented|textButtonLabel/);
    expect(workspace).toContain('<HullActionSheetModal');
    expect(workspace).toContain(
      'subtitle="Invite-only keeps discovery closed. Existing members keep their access."',
    );
  });

  it('leads both headers with the eyebrow the Members page leads with', () => {
    for (const [name, source] of [
      ['index.tsx', account],
      ['workspace.tsx', workspace],
    ] as const) {
      expect(declarations(styleBlock(source, 'eyebrow')), `${name} eyebrow`).toEqual(
        declarations(styleBlock(members, 'eyebrow')),
      );
      expect(declarations(styleBlock(source, 'title')), `${name} title`).toEqual(
        declarations(styleBlock(members, 'title')),
      );
      // The eyebrow stands above the title, and neither is mono.
      expect(source.indexOf('styles.eyebrow'), `${name} eyebrow order`).toBeLessThan(
        source.indexOf('styles.title'),
      );
      expect(source, `${name} header`).not.toMatch(/headerMeta/);
    }
  });
});
