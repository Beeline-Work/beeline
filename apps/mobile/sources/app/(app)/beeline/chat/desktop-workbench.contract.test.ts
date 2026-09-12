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

  it('mounts the inspector beside the transcript and restores trigger focus on dismissal', () => {
    expect(room).toContain('<DesktopRoomInspector');
    expect(room).toContain("desktopMode !== 'three-pane'");
    expect(room).toContain('inspectorTriggerRef.current?.focus()');
    expect(inspector).toMatch(/client\.room\(selectedCornerId\)/);
    expect(inspector).toContain('desktop-work-overview-header');
    expect(inspector).toContain('desktop-work-cockpit');
    expect(inspector).toContain('desktop-work-objective');
    expect(inspector).toContain('corner.corner.about ?? corner.corner.name');
    expect(inspector).not.toContain('BRANCH · PR · CHECKS');
  });

  it('auto-opens a newly announced corner and keeps back inside the work pane', () => {
    expect(room).toContain('observedCornerCardsRef');
    expect(room).toContain('setSelectedDesktopCornerId(opened)');
    expect(inspector).toContain('onBack={() => onSelectCorner(null)}');
    expect(inspector).toContain('Back to work overview');
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
    expect(cornerRow).toContain('stateLine(corner)');
    expect(cornerRow).toContain('roomRowNeedsAttention');
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

  it('keeps the desktop frame and both pane widths persistent', () => {
    expect(navigator).toContain(
      'usesPersistentDesktopFrame(inDesktopShell || isDesktop, isTablet)',
    );
    expect(navigator).toContain("loadDesktopPaneWidth('navigation')");
    expect(navigator).toContain("saveDesktopPaneWidth('navigation', width)");
    expect(inspector).toContain("loadDesktopPaneWidth('inspector')");
    expect(inspector).toContain("saveDesktopPaneWidth('inspector', next)");
  });
});
