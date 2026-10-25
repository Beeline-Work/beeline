import { afterEach, describe, expect, it, vi } from 'vitest';
const show = vi.hoisted(() => vi.fn());
vi.mock('@/modal', () => ({ Modal: { show } }));
vi.mock('@/components/buzz/ArtifactViewer', () => ({
  ArtifactViewerScreen: 'ArtifactViewerScreen',
}));
import { subscribeDesktopArtifact } from '@/buzz/desktop-artifact-pane';
import { openCornerBriefViewer } from './corner-brief-viewer';
import {
  initialDesktopWorkPaneState,
  transitionDesktopWorkPane,
} from '@/buzz/desktop-workbench-state';

const brief = {
  revision: 3,
  spec: '# Readable desktop\n\n## Section\nBody',
  authorHandle: 'ruby',
  attachments: [],
};
afterEach(() => vi.clearAllMocks());
describe('brief presentation', () => {
  it('uses the file selection event and includes document title, author and revision', () => {
    const receive = vi.fn(() => true);
    const unsubscribe = subscribeDesktopArtifact(receive);
    try {
      openCornerBriefViewer(brief);
      expect(receive).toHaveBeenCalledWith({
        authorHandle: 'ruby',
        markdown: {
          title: 'Readable desktop',
          revision: 3,
          text: brief.spec,
        },
      });
      expect(show).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
  it.each(['narrow', 'direct-message', 'phone'] as const)(
    'uses the existing full-screen viewer for %s',
    (context) => {
      const unsubscribe =
        context === 'phone'
          ? () => {}
          : subscribeDesktopArtifact(
              (artifact) =>
                transitionDesktopWorkPane(
                  initialDesktopWorkPaneState(context === 'narrow' ? 700 : 1280),
                  {
                    type: 'open-artifact',
                    artifact,
                    primary: context === 'direct-message' ? 'direct-message' : 'room',
                  },
                ).placement === 'pane',
            );
      try {
        openCornerBriefViewer(brief);
        expect(show).toHaveBeenCalledWith(
          expect.objectContaining({
            placement: 'fill',
            props: {
              markdown: { title: 'Brief · revision 3', text: brief.spec },
            },
          }),
        );
      } finally {
        unsubscribe();
      }
    },
  );
});
