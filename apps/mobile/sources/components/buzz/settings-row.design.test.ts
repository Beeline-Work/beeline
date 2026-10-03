import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as appBoardStyle from '@/buzz/app-board-style';

const settingsRow = readFileSync(new URL('./SettingsRow.tsx', import.meta.url), 'utf8');
const workbench = readFileSync(
  new URL('../../app/(app)/beeline/settings/workbench.tsx', import.meta.url),
  'utf8',
);
const connectApp = readFileSync(
  new URL('../../app/(app)/beeline/settings/workbench/connect-app.tsx', import.meta.url),
  'utf8',
);

/**
 * The Workbench Tools/Apps rows (Trusty Squire, Wallet, Neon, Runway…) once
 * read 18px/15px from the copied-mock `appBoardType` scale instead of the
 * `SettingsRow`/index-row standard (`body` 16px title, `meta` 13px value) the
 * Keys rows and every other list in the app already use. The board-tinted
 * colors and row metrics are unrelated to that bug and are kept.
 */
describe('Workbench row text matches the standard body/meta sizes', () => {
  it('SettingsRow’s app-board row title/value read the shared type roles', () => {
    expect(settingsRow).not.toContain('appBoardType');
    expect(settingsRow).toContain('boardTitle: { ...Typography.ledger(), ...hull.type.body');
    expect(settingsRow).toContain('boardValue: { ...Typography.ledger(), ...hull.type.meta');
  });

  it('the Workbench Apps rows read the shared type roles', () => {
    expect(workbench).toContain('rowTitle: { ...Typography.ledger(), ...hull.type.body');
    expect(workbench).toContain('rowValue: { ...Typography.ledger(), ...hull.type.meta');
    expect(workbench).not.toContain('appBoardType');
  });

  it('Workbench and Connect an app section captions read the shared sectionHead role', () => {
    expect(workbench).toContain('hull.type.sectionHead');
    expect(connectApp).toContain('hull.type.sectionHead');
    expect(connectApp).not.toContain('appBoardType');
  });

  it('the retired section/icon-mark app-board sizes are gone from the shared scale', () => {
    expect(appBoardStyle).not.toHaveProperty('appBoardType');
  });
});
