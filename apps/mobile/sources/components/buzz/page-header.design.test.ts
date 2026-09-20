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

describe('the one page header', () => {
  it('owns the title/meta/back shape a full-bleed section draws', () => {
    expect(pageHeader).toContain('theme.buzz.type.bodyStrong');
    expect(pageHeader).toContain('theme.buzz.type.meta');
    expect(pageHeader).toContain('paddingHorizontal: 12');
  });

  it('is the one header Bookmarks and Workbench render', () => {
    expect(bookmarks).toContain('<PageHeader');
    expect(bookmarks).toContain('meta={`${bookmarks.length} SAVED`}');
    expect(bookmarks).not.toContain('PRIVATE');
    expect(bookmarks).not.toContain('styles.header');
    expect(workbench).toContain('<PageHeader');
  });

  it('keeps the Workbench stack header only where the phone back control lives', () => {
    expect(appLayout).toContain('headerShown: !isDesktop');
  });
});
