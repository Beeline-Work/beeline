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

  // Captain ruling 2026-09-15 (mock 91aa0358328d716e) and the 2026-09-20
  // settings rebuild: the row speaks the Workbench vocabulary — Tools and
  // keys. Option B (mock 644e6683): it states both counts and names a
  // broken tool in the danger subtitle, from `workbenchSummary`.
  it('names the row Tools and keys and shows the Workbench summary', () => {
    expect(settings).toContain('title="Tools and keys"');
    expect(settings).toContain('value={workbench?.value}');
    expect(settings).toContain('description={workbench?.attention}');
    expect(settings).toContain("descriptionTone={workbench?.attention ? 'danger' : undefined}");
    expect(settings).not.toMatch(/title="Connections"/);
  });

  it('re-reads the Workbench on focus without a vault sync', () => {
    expect(settings).toMatch(/useFocusEffect\(/);
    expect(settings).not.toMatch(/refreshVault/);
  });
});
