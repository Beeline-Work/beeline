import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const codeBlock = readFileSync(
  new URL('../../../../components/buzz/CodeBlock.tsx', import.meta.url),
  'utf8',
);
const viewerRoute = readFileSync(new URL('../../artifact-viewer.tsx', import.meta.url), 'utf8');
const viewer = readFileSync(
  new URL('../../../../components/buzz/ArtifactViewer.tsx', import.meta.url),
  'utf8',
);
const chat = readFileSync(new URL('./_chat-surface.tsx', import.meta.url), 'utf8');

describe('code artifact navigation', () => {
  it('routes identifier coordinates into the existing ArtifactViewer shell', () => {
    expect(codeBlock).toContain("pathname: '/artifact-viewer'");
    expect(codeBlock).toContain('roomId,');
    expect(codeBlock).toContain('messageId,');
    expect(codeBlock).toContain('blockIndex: String(blockIndex)');
    expect(codeBlock).not.toContain('storeTempText');
    expect(viewerRoute).toContain('<ArtifactViewerScreen document={document}');
    expect(viewer).toContain("format === 'code'");
  });

  it('restores the exact originating transcript row after Back', () => {
    expect(chat).toContain('artifactReturnMessageIdRef.current = messageId');
    expect(chat).toMatch(
      /useFocusEffect\([\s\S]*artifactReturnMessageIdRef\.current[\s\S]*message\.relayId === messageId[\s\S]*viewPosition: 0\.5/,
    );
  });
});
