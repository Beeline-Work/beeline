import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const settings = readFileSync(new URL('./identity.tsx', import.meta.url), 'utf8');
const members = readFileSync(new URL('../members.tsx', import.meta.url), 'utf8');
const scopeTabs = readFileSync(
  new URL('../../../../components/buzz/SettingsScopeTabs.tsx', import.meta.url),
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
    expect(settings).toContain('<RoomListSectionHeader');
    expect(members).toContain('<RoomListSectionHeader');
  });

  it('uses SettingsRow for the list, without cards', () => {
    expect(settings).toContain('<SettingsRow');
    expect(settings).not.toMatch(/borderRadius: hull\.radius/);
    expect(settings).toContain('<SettingsScopeTabs');
    expect(styleBlock(scopeTabs, 'tile')).not.toMatch(/backgroundColor: hull\.bgTerminal/);
  });

  it('has no explanatory paragraphs or card headings', () => {
    expect(settings).not.toMatch(
      /How people see you|sectionBody|sectionTitle|opens your GitHub profile/i,
    );
    expect(settings).not.toMatch(/Switch GitHub|Linked sign-in|Display</);
  });

  it('heads Settings with one You / workspace segmented control', () => {
    // The selected side rises onto a tile on one pale track; its picture
    // takes the 2px brass bezel, named once with the tile's geometry.
    expect(scopeTabs).toContain('accessibilityRole="tablist"');
    expect(scopeTabs).toContain('accessibilityRole="tab"');
    expect(styleBlock(scopeTabs, 'track')).toContain('backgroundColor: hull.bgRaised');
    expect(scopeTabs).toContain('const seat = workspacePictureSeat(tile)');
    expect(styleBlock(scopeTabs, 'tile')).toContain('borderWidth: tile.borderWidth');
    expect(styleBlock(scopeTabs, 'tileSelected')).toContain('borderColor: hull.accent');
    expect(styleBlock(scopeTabs, 'seat')).toContain('borderRadius: seat.pictureRadius');
    expect(styleBlock(scopeTabs, 'labelSelected')).toContain("Typography.default('semiBold')");
    expect(styleBlock(scopeTabs, 'dimmed')).toContain('opacity');
    expect(scopeTabs).not.toMatch(/shadow[A-Z]|elevation:/);
    expect(settings).not.toContain('WORKSPACE_SETTINGS_TILE');
    expect(settings).toContain("tileTestID: 'identity-face-setting'");
    expect(settings).toContain('testID="identity-managed-handle"');
    expect(settings).not.toContain('settings-workspace-row');
  });

  it('paints the handle in brass in the caption under the control', () => {
    expect(styleBlock(settings, 'captionHandle')).toContain('color: hull.accent');
  });

  it('keeps danger last and uses a danger tone', () => {
    expect(settings.indexOf('testID="delete-account-setting"')).toBeGreaterThan(
      settings.indexOf('testID="sign-out-setting"'),
    );
    expect(settings).toMatch(/testID="sign-out-setting"[\s\S]*tone="destructive"/);
    expect(settings).toMatch(/testID="delete-account-setting"[\s\S]*tone="destructive"/);
  });

  it('wires privacy, terms, and send-feedback through openExternalUrl', () => {
    expect(settings).toContain("import { openExternalUrl } from '@/utils/open-external-url'");
    expect(settings).not.toContain('Linking.openURL');
    expect(settings).toContain('testID="settings-privacy-row"');
    expect(settings).toContain('testID="settings-terms-row"');
    expect(settings).toContain('testID="settings-feedback-row"');
    expect(settings).toContain('title={"Privacy Policy"}');
    expect(settings).toContain('title={"Terms of Service"}');
    expect(settings).toContain('https://usebeeline.app/privacy/');
    expect(settings).toContain('https://usebeeline.app/terms/');
    expect(settings).toContain('mailto:hello@usebeeline.app');
  });
});
