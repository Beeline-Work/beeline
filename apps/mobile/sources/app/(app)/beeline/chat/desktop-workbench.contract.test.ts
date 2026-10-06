import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const room = readFileSync(join(here, '_chat-surface.tsx'), 'utf8');
const inspector = readFileSync(
  join(here, '../../../../components/DesktopRoomInspector.tsx'),
  'utf8',
);
const navigator = readFileSync(join(here, '../../../../components/SidebarNavigator.tsx'), 'utf8');

describe('desktop workbench wiring', () => {
  it('keeps drafts, send status, file drop, and desktop key semantics on the Room composer', () => {
    expect(room).toMatch(/useTextDraft\(\s*`composer:\$\{decodedId\}`/);
    expect(room).toContain('desktopExperience ? desktopDraftKey(decodedId) : undefined');
    expect(room).not.toContain('saveDesktopDraft(');
    expect(room).toContain('clearSubmittedDraft()');
    expect(room).toContain('desktopComposerKeyAction(');
    expect(room).toContain('onDrop: handleDesktopDrop');
    expect(room).toContain('onDesktopPaste={desktopExperience ? handleDesktopPaste : undefined}');
    expect(room).toContain('event.clipboardData?.files');
    expect(room).toContain('testID="desktop-message-status"');
    expect(room).toContain("setDesktopDeliveryState('sending')");
    expect(room).toContain("setDesktopDeliveryState('delivered')");
    expect(room).toContain("setDesktopDeliveryState('failed')");
  });

  it('mounts the one-content work pane beside the transcript, with no handle or list', () => {
    expect(room).toContain('<DesktopRoomInspector');
    expect(room).toContain('content={desktopWorkPaneContent}');
    expect(room).not.toContain('DesktopWorkPaneHandle');
    expect(room).not.toContain('isDesktopWorkPaneCommand');
    expect(room).not.toContain('WorkPanePreference');
    expect(inspector).toMatch(/client!?\.room\(selectedCornerId!?\)/);
    expect(inspector).not.toContain('desktop-work-corners-header');
    expect(inspector).not.toContain('desktop-artifact-pane');
    expect(inspector).toContain('desktop-work-cockpit');
    expect(inspector).toContain('desktop-work-objective');
    expect(inspector).not.toContain('BRANCH · PR · CHECKS');
    expect(inspector).not.toContain('desktop-work-members');
    expect(inspector).not.toContain('desktop-work-reviewer');
  });

  it('never opens the pane for a corner nobody opened, and closes it on a room switch', () => {
    expect(room).not.toContain('observedCornerCountRef');
    expect(room).toMatch(
      /commitDesktopWorkPane\(\{ type: 'close' \}\);\n  \}, \[commitDesktopWorkPane, decodedId\]\);/,
    );
  });

  it('takes an artifact into the pane only when the pane can show it', () => {
    expect(room).toContain('subscribeDesktopArtifact');
    expect(room).toContain("type: 'open-artifact', artifact, primary: desktopWorkPanePrimary");
    expect(room).toContain(".placement === 'pane'");
  });

  it('keeps members, workflows, and reviewer out of the work pane', () => {
    expect(inspector).not.toContain('<SectionHeader title="WORKFLOWS" />');
    expect(inspector).not.toContain("monolithPhoneOperation('listRoomWorkflows'");
    expect(inspector).not.toContain("monolithPhoneOperation('dispatchRoomWorkflow'");
    expect(inspector).not.toContain('desktop-work-members');
    expect(inspector).not.toContain('desktop-work-reviewer');
    expect(inspector).not.toContain('onOpenRoster');
    expect(room).not.toContain('onOpenRoster=');
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

  it('expands a corner into main and closes the work pane', () => {
    expect(room).toContain("commitDesktopWorkPane({ type: 'expand' })");
    expect(room).toContain('router.push(cornerHref(cornerId, desktopWorkRoomId))');
    expect(inspector).toContain('desktop-work-open-in-main');
    expect(inspector).toContain('label="Open in the main pane"');
    expect(inspector).toContain('title: label');
    expect(inspector).not.toMatch(/maximize|maximized/i);
  });

  it('keeps the desktop frame and both pane widths persistent', () => {
    expect(navigator).toContain('usesPersistentDesktopFrame(inDesktopShell, isTablet)');
    expect(navigator).not.toContain('inDesktopShell || desktopPlatform');
    expect(navigator).toContain('showsDesktopSessionChrome(inDesktopShell, isTablet, desktopSession)');
    expect(navigator).not.toContain('desktopPlatform || isTablet');
    expect(navigator).toContain("loadDesktopPaneWidth('navigation')");
    expect(navigator).toContain("saveDesktopPaneWidth('navigation', width)");
    expect(inspector).toContain("loadDesktopPaneWidth('inspector')");
    expect(inspector).toContain("saveDesktopPaneWidth('inspector', next)");
  });
});
