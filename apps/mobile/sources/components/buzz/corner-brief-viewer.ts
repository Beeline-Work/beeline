import { cornerBriefMarkdown, type CornerBrief } from '@/buzz/corner-brief-markdown';
import { ArtifactViewerScreen } from '@/components/buzz/ArtifactViewer';
import { Modal } from '@/modal';

/**
 * Opens the corner's latest brief full-screen in the artifact viewer, composed
 * as one Markdown document (spec, approval, files). Phone and desktop share the
 * same viewer, the way a picture artifact does.
 */
export function openCornerBriefViewer(brief: CornerBrief): void {
  Modal.show({
    component: ArtifactViewerScreen,
    props: {
      markdown: { title: `Brief · revision ${brief.revision}`, text: cornerBriefMarkdown(brief) },
    },
    // Full-screen surface: the centered placement would collapse its flex:1 root.
    placement: 'fill',
  });
}
