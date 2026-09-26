import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const settings = readFileSync(new URL('./identity.tsx', import.meta.url), 'utf8');
const members = readFileSync(new URL('../members.tsx', import.meta.url), 'utf8');
const profileIdentity = readFileSync(
  new URL('../../../../components/buzz/ProfileIdentity.tsx', import.meta.url),
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
    const settingsLabel = declarations(styleBlock(settings, 'sectionLabel'));
    const membersLabel = declarations(styleBlock(members, 'sectionLabel'));
    expect(settingsLabel).toEqual(expect.arrayContaining(membersLabel));
    expect(settingsLabel.join(' ')).toContain('hull.type.sectionHead');
  });

  it('uses SettingsRow for the list, without cards', () => {
    expect(settings).toContain('<SettingsRow');
    expect(settings).not.toMatch(/borderRadius: hull\.radius/);
    expect(settings).toContain('<ProfileIdentity');
    expect(styleBlock(profileIdentity, 'tile')).not.toMatch(
      /backgroundColor: theme\.buzz\.bgTerminal/,
    );
  });

  it('has no explanatory paragraphs or card headings', () => {
    expect(settings).not.toMatch(
      /How people see you|sectionBody|sectionTitle|opens your GitHub profile/i,
    );
    expect(settings).not.toMatch(/Switch GitHub|Linked sign-in|Display</);
  });

  it('centres a 2px brass-bezelled identity tile above the handle', () => {
    expect(styleBlock(profileIdentity, 'identity')).toContain("alignItems: 'center'");
    // The 2px brass bezel is named once, with the rest of the tile's geometry
    // (`buzz/workspace-tile`, where the picture's seat is derived from it).
    expect(profileIdentity).toContain('const tile = IDENTITY_SETTINGS_TILE');
    expect(profileIdentity).toContain('const seat = workspacePictureSeat(tile)');
    expect(styleBlock(profileIdentity, 'tile')).toContain('borderWidth: tile.borderWidth');
    expect(styleBlock(profileIdentity, 'tile')).toContain('borderColor: theme.buzz.accent');
    expect(styleBlock(profileIdentity, 'seat')).toContain('borderRadius: seat.pictureRadius');
    expect(profileIdentity).toContain('size={seat.pictureSize}');
    expect(settings).not.toContain('WORKSPACE_SETTINGS_TILE');
    expect(settings).not.toContain('const IDENTITY_TILE');
    expect(settings).toContain('avatarTestID="identity-face-setting"');
    expect(settings).toContain('handleTestID="identity-managed-handle"');
  });

  it('paints the handle @ in brass and the rest in ordinary text', () => {
    expect(styleBlock(profileIdentity, 'at')).toContain('color: theme.buzz.accent');
    expect(styleBlock(profileIdentity, 'handle')).toContain('color: theme.buzz.textPrimary');
    expect(profileIdentity).toMatch(/styles\.at}>@</);
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
    expect(settings).toContain("t('settings.privacyPolicy')");
    expect(settings).toContain("t('settings.termsOfService')");
    expect(settings).toContain('https://usebeeline.app/privacy/');
    expect(settings).toContain('https://usebeeline.app/terms/');
    expect(settings).toContain('mailto:hello@usebeeline.app');
  });
});
