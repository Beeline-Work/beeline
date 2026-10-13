import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// #1242 shipped the Workbench screens and routes but nothing navigated to
// them, so the captain could not find his Workbench on the phone
// (2026-09-15). Settings is the only entry point; keep it wired.
const settings = readFileSync(new URL('./identity.tsx', import.meta.url), 'utf8');

describe('Settings Workbench entry', () => {
  it('offers a row that opens the Workbench', () => {
    expect(settings).toContain('testID="settings-workbench-row"');
    expect(settings).toContain("pathname: '/beeline/settings/workbench'");
  });

  it('heads that row with its own section', () => {
    expect(settings).toContain('testID="workbench-section"');
    expect(settings).toContain('<RoomListSectionHeader title="Connectors"');
  });

  // Captain ruling 2026-09-15 (mock 91aa0358328d716e) and the 2026-09-20
  // settings rebuild, revised 2026-10-13 by the owner: the row states one
  // total of the Your connections rows and names a broken tool in the
  // danger subtitle, from `workbenchSummary`.
  it('names the row Your connections and shows the Workbench summary', () => {
    expect(settings).toContain('title="Your connections"');
    expect(settings).toContain('value={workbench?.value}');
    expect(settings).toContain('description={workbench?.attention}');
    expect(settings).toContain("descriptionTone={workbench?.attention ? 'danger' : undefined}");
    expect(settings).not.toMatch(/title="Connections"/);
  });

  it('uses the shared Workbench owner without a focus read', () => {
    expect(settings).toContain('useSharedWorkbench(');
    expect(settings).not.toMatch(/useFocusEffect\(/);
    expect(settings).not.toMatch(/refreshVault/);
  });
});
