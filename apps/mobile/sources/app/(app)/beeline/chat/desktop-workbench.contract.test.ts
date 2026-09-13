import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const room = readFileSync(join(here, '[channelId].tsx'), 'utf8');
const inspector = readFileSync(
  join(here, '../../../../components/DesktopRoomInspector.tsx'),
  'utf8',
);
const navigator = readFileSync(join(here, '../../../../components/SidebarNavigator.tsx'), 'utf8');

describe('desktop workbench wiring', () => {
  it('keeps drafts, send status, file drop, and desktop key semantics on the Room composer', () => {
    expect(room).toContain('loadDesktopDraft(decodedId)');
    expect(room).toContain("saveDesktopDraft(decodedId, '')");
    expect(room).toContain('desktopComposerKeyAction(');
    expect(room).toContain('onDrop: handleDesktopDrop');
    expect(room).toContain('onPaste: handleDesktopPaste');
    expect(room).toContain('event.clipboardData.files');
    expect(room).toContain('testID="desktop-message-status"');
    expect(room).toContain("setDesktopDeliveryState('sending')");
    expect(room).toContain("setDesktopDeliveryState('delivered')");
    expect(room).toContain("setDesktopDeliveryState('failed')");
  });

  it('mounts the work pane beside the transcript and exposes a focused recovery handle', () => {
    expect(room).toContain('<DesktopRoomInspector');
    expect(room).toContain('<DesktopWorkPaneHandle');
    expect(room).toContain("workPaneMode === 'present'");
    expect(room).toContain("workPaneMode === 'dismissed'");
    expect(room).toContain('workPaneHandleRef.current?.focus()');
    expect(room).not.toContain('desktop-inspector-toggle');
    expect(inspector).toMatch(/client\.room\(selectedCornerId\)/);
    expect(inspector).toContain('desktop-work-overview-header');
    expect(inspector).toContain('desktop-work-cockpit');
    expect(inspector).toContain('desktop-work-objective');
    expect(inspector).toContain('corner.corner.about ?? corner.corner.name');
    expect(inspector).not.toContain('BRANCH · PR · CHECKS');
  });

  it('auto-opens a newly announced corner while the work pane is present', () => {
    expect(room).toContain('observedCornerCardsRef');
    expect(room).toContain("commitDesktopWorkPane({ type: 'open-corner', cornerId: opened })");
  });

  it('renders dispatchable workflows as ordinary overview rows behind confirmation', () => {
    expect(inspector).toContain('<SectionHeader title="WORKFLOWS" />');
    expect(inspector).toContain("monolithPhoneOperation('listRoomWorkflows'");
    expect(inspector).toContain("monolithPhoneOperation('dispatchRoomWorkflow'");
    expect(inspector).toContain('Modal.confirm(');
    expect(inspector).toContain("confirmText: 'Run'");
    expect(inspector).not.toContain('Workflows arrive with the next release');
    expect(inspector).not.toMatch(/workflow\.name\s*===\s*['"]Release/);
  });

  it('keeps repository lifecycle vocabulary out of overview corner rows', () => {
    const cornerRow = inspector.slice(
      inspector.indexOf('function CornerRow'),
      inspector.indexOf('function CornerCockpit'),
    );
    expect(cornerRow).toContain('corner.corner.about ?? corner.corner.name');
    expect(cornerRow).toContain('cornerDisplayState(corner)');
    expect(cornerRow).toContain('{display.word}');
    expect(cornerRow).not.toMatch(/pull request|github|branch|checks|\bPR\b/i);
  });

  it('opens inspector links through the shared external URL boundary', () => {
    // The desktop shell is a webview: Linking.openURL never reaches a browser,
    // so transcript lifecycle cards keep the shared Tauri/Expo boundary.
    expect(inspector).toContain("import { openExternalUrl } from '@/utils/open-external-url'");
    expect(inspector).not.toContain('Linking.openURL');
    expect(inspector).toContain('openExternalUrl(url)');
    expect(inspector).toContain('<GitHubEventCard');
    expect(inspector).toContain('<DaemonFactCard');
  });

  it('promotes a corner into main while leaving the work pane on its overview', () => {
    expect(room).toContain("commitDesktopWorkPane({ type: 'open-corner-in-main' })");
    expect(room).toContain('router.push(cornerHref(cornerId, desktopWorkRoomId))');
    expect(inspector).toContain('desktop-work-open-in-main');
    expect(inspector).toContain('label="Open in the main pane"');
    expect(inspector).toContain("title: label");
    expect(inspector).not.toMatch(/maximize|maximized/i);
  });

  it('keeps the desktop frame and both pane widths persistent', () => {
    expect(navigator).toContain(
      'usesPersistentDesktopFrame(inDesktopShell || desktopPlatform, isTablet)',
    );
    expect(navigator).toContain("loadDesktopPaneWidth('navigation')");
    expect(navigator).toContain("saveDesktopPaneWidth('navigation', width)");
    expect(inspector).toContain("loadDesktopPaneWidth('inspector')");
    expect(inspector).toContain("saveDesktopPaneWidth('inspector', next)");
  });
});
