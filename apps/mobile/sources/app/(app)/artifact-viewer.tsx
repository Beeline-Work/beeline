import React from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { ArtifactViewerScreen } from '@/components/buzz/ArtifactViewer';
import { codeDocumentFromMessages, type CodeDocument } from '@/buzz/code-document';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { RoomViewClient } from '@/sync/transport/room-view-client';

export default function ArtifactViewerRoute() {
  const { roomId, messageId, blockIndex } = useLocalSearchParams<{
    roomId?: string;
    messageId?: string;
    blockIndex?: string;
  }>();
  const [document, setDocument] = React.useState<CodeDocument | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    void (async () => {
      const identity = await loadBuzzIdentity();
      if (!identity || !roomId || !messageId || blockIndex === undefined) throw new Error();
      const client = new RoomViewClient({
        baseUrl: await getEffectiveRelayUrl(),
        identity,
      });
      const view = await client.room(roomId);
      const index = Number(blockIndex);
      let next = codeDocumentFromMessages(view.messages, messageId, index);
      const oldest = [...view.messages].sort(
        (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
      )[0];
      let cursor = oldest ? { createdAt: oldest.createdAt, id: oldest.id } : undefined;
      while (!next) {
        const history = await client.history(roomId, cursor);
        next = codeDocumentFromMessages(history.messages, messageId, index);
        if (next || !history.nextBefore) break;
        cursor = history.nextBefore;
      }
      if (!next) throw new Error();
      if (live) setDocument(next);
    })().catch(() => {
      if (live) setFailed(true);
    });
    return () => {
      live = false;
    };
  }, [blockIndex, messageId, roomId]);

  return document ? (
    <ArtifactViewerScreen document={document} onClose={() => router.back()} />
  ) : (
    <ArtifactViewerScreen
      notice={{
        title: 'Code',
        message: failed ? 'The code block could not be loaded. Go back and try again.' : 'Loading…',
      }}
      onClose={() => router.back()}
    />
  );
}
