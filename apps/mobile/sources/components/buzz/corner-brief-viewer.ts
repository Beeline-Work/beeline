import { openArtifactInDesktopWorkPane } from '@/buzz/desktop-artifact-pane';
import { cornerBriefMarkdown, type CornerBrief } from '@/buzz/corner-brief-markdown';
import { ArtifactViewerScreen } from '@/components/buzz/ArtifactViewer';
import { Modal } from '@/modal';

/** Briefs share the file pane on desktop and its full-screen fallback elsewhere. */
export function openCornerBriefViewer(brief: CornerBrief): void {
  const markdown = {
    title: brief.spec.match(/^#\s+(.+)$/m)?.[1]?.trim() || 'Brief',
    text: cornerBriefMarkdown(brief),
    revision: brief.revision,
  };
  if (openArtifactInDesktopWorkPane({ markdown, authorHandle: brief.authorHandle })) return;
  Modal.show({
    component: ArtifactViewerScreen,
    props: {
      markdown: { title: `Brief · revision ${brief.revision}`, text: markdown.text },
    },
    // Full-screen surface: the centered placement would collapse its flex:1 root.
    placement: 'fill',
  });
}
