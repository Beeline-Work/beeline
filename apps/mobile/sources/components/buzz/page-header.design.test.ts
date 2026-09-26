import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageHeader = readFileSync(new URL('./PageHeader.tsx', import.meta.url), 'utf8');
const bookmarks = readFileSync(
  new URL('../../app/(app)/beeline/bookmarks.tsx', import.meta.url),
  'utf8',
);
const workbench = readFileSync(
  new URL('../../app/(app)/beeline/settings/workbench.tsx', import.meta.url),
  'utf8',
);
const appLayout = readFileSync(new URL('../../app/(app)/_layout.tsx', import.meta.url), 'utf8');
const agentProfile = readFileSync(new URL('./AgentProfileView.tsx', import.meta.url), 'utf8');
const humanProfile = readFileSync(
  new URL('../../app/(app)/beeline/human-profile.tsx', import.meta.url),
  'utf8',
);
const settings = readFileSync(
  new URL('../../app/(app)/beeline/settings/identity.tsx', import.meta.url),
  'utf8',
);
const members = readFileSync(
  new URL('../../app/(app)/beeline/members.tsx', import.meta.url),
  'utf8',
);
const portrait = readFileSync(new URL('./SoulPortraitControls.tsx', import.meta.url), 'utf8');

describe('the one page header', () => {
  it('owns the title/meta/back shape a full-bleed section draws', () => {
    expect(pageHeader).toContain('theme.buzz.type.bodyStrong');
    expect(pageHeader).toContain('theme.buzz.type.hero');
    expect(pageHeader).toContain('theme.buzz.type.meta');
    expect(pageHeader).toContain('paddingHorizontal: 12');
  });

  it('is the one header Bookmarks and Workbench render', () => {
    expect(bookmarks).toContain('<PageHeader');
    expect(bookmarks).toContain('trailing={`${bookmarks.length} SAVED`}');
    expect(bookmarks).not.toContain('PRIVATE');
    expect(bookmarks).not.toContain('styles.header');
    expect(workbench).toContain('<PageHeader');
    expect(workbench).toContain('eyebrow="Settings"');
    expect(workbench).toContain('title="Workbench"');
  });

  it('lets Workbench and its tool pages draw the shared header instead of the stack title', () => {
    expect(appLayout).toMatch(/name="beeline\/settings\/workbench"[\s\S]*?headerShown: false/);
    expect(appLayout).toMatch(
      /name="beeline\/settings\/workbench\/connection"[\s\S]*?headerShown: false/,
    );
    expect(appLayout).not.toContain('headerShown: !isDesktop');
  });

  it('keeps profiles, Settings, and the Members entry point in one page vocabulary', () => {
    for (const source of [agentProfile, humanProfile, settings, members]) {
      expect(source).toContain('<PageHeader');
      expect(source).toContain('prominent');
    }
    for (const source of [agentProfile, humanProfile, settings]) {
      expect(source).toContain('<ProfileIdentity');
      expect(source).toContain('<SettingsRow');
    }
    expect(agentProfile).not.toContain('headerActions');
    expect(humanProfile).not.toContain('<MonoButton label="Back"');
    expect(portrait).not.toContain('avatar-direction');
    expect(portrait).not.toContain('TextInput');
    expect(portrait).toContain('generating, will DM you when the avatar is ready');
  });
});
