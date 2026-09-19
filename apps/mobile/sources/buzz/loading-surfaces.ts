/**
 * Every normal-use loading surface and its treatment. A leftover on the old
 * four-dot `PixelLoader` (or a text-only "Loading…" gate) must land here as an
 * explicit exception — never silently.
 *
 * Paths are relative to `apps/mobile/sources`.
 */
export type LoadingTreatment = 'glyph' | 'exception';

export type LoadingSurface = {
  id: string;
  file: string;
  treatment: LoadingTreatment;
  /** Required when `treatment` is `exception`. */
  reason?: string;
};

export const LOADING_SURFACES: readonly LoadingSurface[] = [
  { id: 'boot', file: 'components/buzz/BootPaint.tsx', treatment: 'glyph' },
  { id: 'thinking', file: 'components/buzz/TurnProgressLine.tsx', treatment: 'glyph' },
  { id: 'activity-working', file: 'components/buzz/ActivityTimeline.tsx', treatment: 'glyph' },
  { id: 'room-corner-entry', file: 'app/(app)/beeline/chat/[channelId].tsx', treatment: 'glyph' },
  { id: 'room-deck', file: 'app/(app)/beeline/channels.tsx', treatment: 'glyph' },
  { id: 'changes-list', file: 'app/(app)/beeline/corners/[roomId].tsx', treatment: 'glyph' },
  { id: 'members', file: 'app/(app)/beeline/MembersScreen.tsx', treatment: 'glyph' },
  { id: 'workspace-settings', file: 'app/(app)/beeline/settings/workspace.tsx', treatment: 'glyph' },
  { id: 'community', file: 'app/(app)/beeline/community.tsx', treatment: 'glyph' },
  { id: 'schedules', file: 'app/(app)/beeline/settings/schedules.tsx', treatment: 'glyph' },
  { id: 'workbench', file: 'app/(app)/beeline/settings/workbench.tsx', treatment: 'glyph' },
  { id: 'workbench-connect', file: 'app/(app)/beeline/settings/workbench/connect.tsx', treatment: 'glyph' },
  { id: 'wallet', file: 'app/(app)/beeline/settings/workbench/wallet.tsx', treatment: 'glyph' },
  { id: 'bookmarks', file: 'app/(app)/beeline/bookmarks.tsx', treatment: 'glyph' },
  { id: 'member-picker', file: 'components/buzz/MemberPickerSheet.tsx', treatment: 'glyph' },
  { id: 'forward-picker', file: 'components/buzz/ForwardMessagePickerSheet.tsx', treatment: 'glyph' },
  { id: 'desktop-sidebar', file: 'components/SidebarView.tsx', treatment: 'glyph' },
  { id: 'desktop-inspector', file: 'components/DesktopRoomInspector.tsx', treatment: 'glyph' },
  { id: 'invite-join', file: 'app/(app)/join/[token].tsx', treatment: 'glyph' },
  { id: 'review-signin', file: 'app/(app)/review/[secret].tsx', treatment: 'glyph' },
  {
    id: 'button-busy',
    file: 'components/buzz/MonoHull.tsx',
    treatment: 'exception',
    reason:
      'MonoButton/BrassButton compact busy sits on a labeled 44pt control; a release-loop glyph would crowd the plate and flash on sub-100ms submits.',
  },
  {
    id: 'ota-check-busy',
    file: 'app/(app)/beeline/settings/identity.tsx',
    treatment: 'exception',
    reason:
      'Trailing Settings-row busy while a version check returns; same compact-control case as a button, not a page load gate.',
  },
  {
    id: 'history-line',
    file: 'app/(app)/beeline/chat/[channelId].tsx',
    treatment: 'exception',
    reason:
      '"Loading earlier messages…" is an inscribed transcript history row, not a load gate. A painting glyph would interrupt the ledger.',
  },
  {
    id: 'artifact-preview',
    file: 'components/buzz/ArtifactCard.tsx',
    treatment: 'exception',
    reason:
      'Content-shaped preview placeholder; cache hits resolve in well under 100ms and a paint loop would flash.',
  },
  {
    id: 'artifact-viewer',
    file: 'components/buzz/ArtifactViewer.tsx',
    treatment: 'exception',
    reason:
      'Content-shaped viewer placeholder while preview bytes or the native module resolve; same flash risk as the card.',
  },
  {
    id: 'desktop-artifact',
    file: 'components/buzz/DesktopArtifactPane.tsx',
    treatment: 'exception',
    reason: 'Shares the artifact viewer placeholder; not a Room/Corner load gate.',
  },
  {
    id: 'webview-signin',
    file: 'app/(app)/beeline/settings/workbench/connect-signin.tsx',
    treatment: 'exception',
    reason: 'Native WebView document chrome, not a Beeline surface load gate.',
  },
  {
    id: 'legacy-round-button',
    file: 'components/RoundButton.tsx',
    treatment: 'exception',
    reason: 'Vendored Happy control busy indicator; not a Beeline load gate.',
  },
  {
    id: 'legacy-item',
    file: 'components/Item.tsx',
    treatment: 'exception',
    reason: 'Vendored Happy list-item busy indicator; not a Beeline load gate.',
  },
];

export function loadingSurfaceExceptions(): readonly LoadingSurface[] {
  return LOADING_SURFACES.filter((surface) => surface.treatment === 'exception');
}

export function loadingSurfaceGlyphFiles(): readonly string[] {
  return [...new Set(LOADING_SURFACES.filter((surface) => surface.treatment === 'glyph').map((surface) => surface.file))];
}

export function loadingSurfaceExceptionFiles(): readonly string[] {
  return [
    ...new Set(
      LOADING_SURFACES.filter((surface) => surface.treatment === 'exception').map((surface) => surface.file),
    ),
  ];
}
