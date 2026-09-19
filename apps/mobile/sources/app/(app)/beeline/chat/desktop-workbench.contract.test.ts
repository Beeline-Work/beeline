import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const room = readFileSync(join(here, 'chat-surface.tsx'), 'utf8');
const inspector = readFileSync(
  join(here, '../../../../components/DesktopRoomInspector.tsx'),
  'utf8',
);
const navigator = readFileSync(join(here, '../../../../components/SidebarNavigator.tsx'), 'utf8');
import { desktopWorkPaneEventApplies } from '../../../../buzz/desktop-workbench-state';

describe('desktop workbench wiring', () => {
  it('keeps drafts, send status, file drop, and desktop key semantics on the Room composer', () => {
    expect(room).toContain('loadDesktopDraft(decodedId)');
    expect(room).toContain("saveDesktopDraft(decodedId, '')");
    expect(room).toContain('desktopComposerKeyAction(');
    expect(room).toContain('onDrop: handleDesktopDrop');
    expect(room).toContain('onDesktopPaste={desktopExperience ? handleDesktopPaste : undefined}');
    expect(room).toContain('event.clipboardData?.files');
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
    expect(inspector).toContain('desktop-work-corners-header');
    expect(inspector).toContain('desktop-work-cockpit');
    expect(inspector).toContain('desktop-work-objective');
    expect(inspector).toContain('inspectorCornerObjective(');
    expect(inspector).not.toContain('BRANCH · PR · CHECKS');
    expect(inspector).not.toContain('desktop-work-overview-header');
    expect(inspector).not.toContain('desktop-work-members');
    expect(inspector).not.toContain('desktop-work-reviewer');
    expect(inspector).not.toContain('<SectionHeader title="WORKFLOWS" />');
    expect(inspector).not.toContain('<SectionHeader title="MEMBERS" />');
  });

  it('marks a newly announced corner on the handle instead of auto-opening the pane', () => {
    expect(room).toContain('observedCornerCardsRef');
    expect(room).toContain('setWorkPaneArrived(true)');
    expect(room).toContain('arrived={workPaneArrived}');
    expect(room).toContain('hasLiveDesktopCorners');
    expect(room).toContain(".filter((corner) => corner.state !== 'archived')");
    expect(room).not.toContain("commitDesktopWorkPane({ type: 'open-corner', cornerId: opened })");
    expect(room).not.toContain(
      "observedCornerCardsRef.current = { roomId: roomSurface.room.id, ids };\n      commitDesktopWorkPane({ type: 'open-overview' });",
    );
  });

  it('collapses the work pane entirely on a direct message', () => {
    // A direct message is refused corners by the server, restates its own
    // title as MEMBERS, and has no repository for a Reviewer, so the pane is
    // gone — not an empty shell — and nothing can reopen it.
    expect(room).toContain('const desktopWorkPaneMounted =');
    expect(room).toContain(
      "desktopExperience && !isDirectMessage && workPaneMode === 'present'",
    );
    expect(room).toContain('? desktopWorkRoom\n      : null;');
    expect(room).toContain('const desktopWorkHandleMounted =');
    expect(room).toContain("workPaneMode === 'dismissed'");
    expect(room).toContain('hasLiveDesktopCorners');
    expect(room).toContain('{desktopWorkPaneMounted && (');
    expect(room).toContain('{desktopWorkHandleMounted && (');
    // Pane events are no-ops there, so the person's persisted preference is
    // never overwritten by a channel that has nothing to show.
    expect(room).toContain('desktopWorkPaneEventApplies(event, isDirectMessage)');
    // The helper itself: a Room takes every pane event, a direct message only
    // hydration and window resizes.
    expect(desktopWorkPaneEventApplies({ type: 'open-overview' }, true)).toBe(false);
    expect(desktopWorkPaneEventApplies({ type: 'dismiss' }, true)).toBe(false);
    expect(desktopWorkPaneEventApplies({ type: 'hydrate', preference: 'present' }, true)).toBe(
      true,
    );
    expect(desktopWorkPaneEventApplies({ type: 'resize', width: 1400 }, true)).toBe(true);
    expect(desktopWorkPaneEventApplies({ type: 'toggle' }, false)).toBe(true);
    // An artifact Open press in a direct message always lands in the browser.
    expect(room).toMatch(
      /if \(isDirectMessage\) \{\s*void openArtifactInBrowserOrExplain\(selection\.attachment\);/,
    );
  });

  it('re-presents the work pane when an artifact opens while it is dismissed', () => {
    expect(room).toContain('subscribeDesktopArtifact');
    expect(room).toContain("commitDesktopWorkPane({ type: 'open-artifact' })");
    // A suppressed pane cannot host the artifact, so the press must still land:
    // the same browser handoff the pane itself uses for unsandboxable formats.
    expect(room).toContain('openArtifactInBrowserOrExplain(selection.attachment)');
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

  it('keeps repository lifecycle vocabulary out of overview corner rows', () => {
    const cornerRow = inspector.slice(
      inspector.indexOf('function CornerRow'),
      inspector.indexOf('function CornerCockpit'),
    );
    expect(cornerRow).toContain('inspectorCornerObjective(');
    expect(cornerRow).not.toContain('corner.corner.about ?? corner.corner.name');
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

  it('promotes a corner into main without forcing the work pane present', () => {
    expect(room).toContain("commitDesktopWorkPane({ type: 'open-corner-in-main' })");
    expect(room).toContain('router.push(cornerHref(cornerId, desktopWorkRoomId))');
    expect(room).not.toContain(
      "void saveDesktopWorkPanePreference(workPaneWindowClass, transition.state.preference);\n      router.push(cornerHref(cornerId, desktopWorkRoomId))",
    );
    expect(inspector).toContain('desktop-work-open-in-main');
    expect(inspector).toContain('label="Open in the main pane"');
    expect(inspector).toContain('title: label');
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
