import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// #1242 shipped the Workbench screens and routes but nothing navigated to
// them, so the captain could not find his Workbench on the phone
// (2026-09-15). Settings is the only entry point; keep it wired.
const settings = readFileSync(new URL('./identity.tsx', import.meta.url), 'utf8');

describe('Settings Workbench entry', () => {
  it('offers a row that opens the Workbench', () => {
    expect(settings).toContain('testID="settings-workbench-row"');
    expect(settings).toContain("router.push('/beeline/settings/workbench'");
  });

  it('heads that row with its own section', () => {
    expect(settings).toContain('testID="workbench-section"');
    expect(settings).toMatch(/sectionLabel}>Workbench</);
  });
});
