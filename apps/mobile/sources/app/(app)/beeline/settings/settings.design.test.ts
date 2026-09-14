import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const settings = readFileSync(new URL('./identity.tsx', import.meta.url), 'utf8');
const members = readFileSync(new URL('../MembersScreen.tsx', import.meta.url), 'utf8');

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

function declarations(block: string): string[] {
  return block
    .slice(block.indexOf('{') + 1, block.lastIndexOf('}'))
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .sort();
}

describe('Settings reads as the Members page', () => {
  it('uses the same small-caps mono section label role', () => {
    const settingsLabel = declarations(styleBlock(settings, 'sectionLabel'));
    const membersLabel = declarations(styleBlock(members, 'sectionLabel'));
    expect(settingsLabel).toEqual(expect.arrayContaining(membersLabel));
    expect(settingsLabel.join(' ')).toContain('hull.type.sectionHead');
  });

  it('uses flat divided rows without cards', () => {
    const row = declarations(styleBlock(settings, 'row')).join(' ');
    expect(row).toContain('borderBottomWidth: StyleSheet.hairlineWidth');
    expect(row).not.toMatch(/borderRadius|backgroundColor/);
  });

  it('has no explanatory paragraphs or card headings', () => {
    expect(settings).not.toMatch(/How people see you|sectionBody|sectionTitle|description=/);
    expect(settings).not.toContain('<SettingsRow');
  });

  it('keeps danger last and uses a danger tone', () => {
    expect(settings.indexOf('testID="delete-account-setting"')).toBeGreaterThan(
      settings.indexOf('testID="sign-out-setting"'),
    );
    expect(styleBlock(settings, 'dangerTitle')).toContain('hull.dialogDanger');
  });
});
