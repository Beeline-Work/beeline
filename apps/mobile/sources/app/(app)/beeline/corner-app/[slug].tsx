import React from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import type { CornerAppView } from '@beeline/api-contract/phone';
import { CornerAppScreen } from '@/components/buzz/CornerAppScreen';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { MonolithRigTransport } from '@/sync/transport/monolith-rig-transport';

export default function CornerAppRoute() {
  const { roomId, slug } = useLocalSearchParams<{ roomId?: string; slug?: string }>();
  const [app, setApp] = React.useState<CornerAppView>();
  const [busyAction, setBusyAction] = React.useState<string>();

  React.useEffect(() => {
    let live = true;
    void (async () => {
      if (!roomId || !slug) return;
      const identity = await loadBuzzIdentity();
      if (!identity) return;
      const view = await new RoomViewClient({
        baseUrl: await getEffectiveRelayUrl(),
        identity,
      }).room(roomId);
      if (live) setApp(view.cornerApps?.find((candidate) => candidate.slug === slug));
    })();
    return () => {
      live = false;
    };
  }, [roomId, slug]);

  const run = React.useCallback(
    async (prompt: string) => {
      if (!roomId || !app || busyAction) return;
      setBusyAction(prompt);
      try {
        const identity = await loadBuzzIdentity();
        if (!identity) throw new Error('not signed in');
        const transport = new MonolithRigTransport(identity);
        const event = await transport.composeMessage(
          { sessionId: roomId, text: prompt },
          { mentionAgent: app.authorId, mentionPubkeys: [app.authorId] },
        );
        await transport.publishPreparedMessage(event);
        router.back();
      } finally {
        setBusyAction(undefined);
      }
    },
    [app, busyAction, roomId],
  );

  return (
    <CornerAppScreen
      app={app}
      busyAction={busyAction}
      onAction={(prompt) => void run(prompt)}
      onBack={() => router.back()}
    />
  );
}
