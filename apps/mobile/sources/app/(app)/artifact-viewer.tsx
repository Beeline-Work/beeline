import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { ArtifactViewerScreen } from '@/components/buzz/ArtifactViewer';
import { codeDocumentFromMessages, type CodeDocument } from '@/buzz/code-document';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { findInRoomHistory } from '@/buzz/room-message-store';

export default function ArtifactViewerRoute() {
  useLatencyRouteFrame('/artifact-viewer');
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
      next ??= await findInRoomHistory(
        client,
        roomId,
        oldest ? { createdAt: oldest.createdAt, id: oldest.id } : undefined,
        (rows) => codeDocumentFromMessages(rows, messageId, index),
      );
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
