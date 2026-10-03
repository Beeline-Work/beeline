import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as appBoardStyle from '@/buzz/app-board-style';

const appPageHeader = readFileSync(new URL('./AppPageHeader.tsx', import.meta.url), 'utf8');
const workbenchApp = readFileSync(
  new URL('../../app/(app)/beeline/settings/workbench/app.tsx', import.meta.url),
  'utf8',
);
const connectApp = readFileSync(
  new URL('../../app/(app)/beeline/settings/workbench/connect-app.tsx', import.meta.url),
  'utf8',
);

/**
 * The Composio Workbench build once gave "Connect an app" and the app detail
 * page their own 32px/15px header scale (`appBoard`) instead of the shared
 * `PageHeader`'s Corners-matching `prominent` scale (22px/13px). Both pages
 * only ever draw their header through `AppPageHeader`, so pinning its one
 * call site keeps every current and future consumer aligned with Corners.
 */
describe('App-board sub-pages share the ordinary PageHeader scale', () => {
  it('AppPageHeader renders the shared prominent header, not the retired app-board one', () => {
    expect(appPageHeader).toContain('<PageHeader prominent');
    expect(appPageHeader).not.toContain('appBoard');
  });

  it('the copied-mock app-board type scale is gone; every board size is a shared role', () => {
    expect(appBoardStyle).not.toHaveProperty('appBoardType');
  });

  it('the app detail page reads its text sizes from the shared type roles', () => {
    expect(workbenchApp).toContain('<AppPageHeader');
    expect(workbenchApp).not.toContain('appBoardType');
    expect(workbenchApp).toContain('hull.type.body');
    expect(workbenchApp).toContain('hull.type.meta');
  });

  it('Connect an app reads its row text sizes from the shared type roles', () => {
    expect(connectApp).toContain('<AppPageHeader');
    expect(connectApp).toContain('hull.type.body');
    expect(connectApp).toContain('hull.type.meta');
    expect(connectApp).not.toContain('appBoardType');
  });
});
