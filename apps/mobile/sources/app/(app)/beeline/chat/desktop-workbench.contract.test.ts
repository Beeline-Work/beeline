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
    expect(room).toContain('testID="desktop-message-status"');
    expect(room).toContain("setDesktopDeliveryState('sending')");
    expect(room).toContain("setDesktopDeliveryState('delivered')");
    expect(room).toContain("setDesktopDeliveryState('failed')");
  });

  it('mounts the inspector beside the transcript and restores trigger focus on dismissal', () => {
    expect(room).toContain('<DesktopRoomInspector');
    expect(room).toContain("desktopMode !== 'three-pane'");
    expect(room).toContain('inspectorTriggerRef.current?.focus()');
    expect(inspector).toMatch(/client\s*\.\s*room\(cornerId\)/);
    expect(inspector).toContain('BRANCH · PR · CHECKS');
    expect(inspector).toContain('Shared actions such as closing the Corner');
  });

  it('opens inspector links through the shared external URL boundary', () => {
    // The desktop shell is a webview: Linking.openURL never reaches a
    // browser, so the PR and artifact links in the inspector go through
    // openExternalUrl (the Tauri opener there, Expo Linking elsewhere).
    expect(inspector).toContain("import { openExternalUrl } from '@/utils/open-external-url'");
    expect(inspector).not.toContain('Linking.openURL');
    expect(inspector).toContain('openExternalUrl(detail.cornerLifecycle!.pr!.url)');
    expect(inspector).toContain('openExternalUrl(artifact.url)');
  });

  it('keeps the desktop frame and both pane widths persistent', () => {
    expect(navigator).toContain('usesPersistentDesktopFrame(desktopPlatform, isTablet)');
    expect(navigator).toContain("loadDesktopPaneWidth('navigation')");
    expect(navigator).toContain("saveDesktopPaneWidth('navigation', width)");
    expect(inspector).toContain("loadDesktopPaneWidth('inspector')");
    expect(inspector).toContain("saveDesktopPaneWidth('inspector', next)");
  });
});
