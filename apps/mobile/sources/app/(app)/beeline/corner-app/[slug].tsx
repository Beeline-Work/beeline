import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import type { CornerAppManifest, CornerAppView } from '@beeline/api-contract/phone';
import { CornerAppScreen } from '@/components/buzz/CornerAppScreen';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { MonolithRigTransport } from '@/sync/transport/monolith-rig-transport';
import { phoneOperationFailureReason } from '@/sync/transport/monolith-operation';
import { Modal } from '@/modal';

export default function CornerAppRoute() {
  useLatencyRouteFrame('/beeline/corner-app/[slug]');
  const { roomId, slug } = useLocalSearchParams<{ roomId?: string; slug?: string }>();
  const [app, setApp] = React.useState<CornerAppView>();
  const [busyAction, setBusyAction] = React.useState<string>();
  const [manifest, setManifest] = React.useState<CornerAppManifest>();
  useLatencyRouteFrame('/beeline/corner-app/[slug]', app !== undefined, true);
  const [loadError, setLoadError] = React.useState<string>();

  React.useEffect(() => {
    let live = true;
    void (async () => {
      if (!roomId || !slug) return;
      try {
        const identity = await loadBuzzIdentity();
        if (!identity) throw new Error('not signed in');
        const view = await new RoomViewClient({
          baseUrl: await getEffectiveRelayUrl(),
          identity,
        }).room(roomId);
        if (live) {
          setApp(view.cornerApps?.find((candidate) => candidate.slug === slug));
          setManifest(view.boundApp?.manifest.slug === slug ? view.boundApp.manifest : undefined);
        }
      } catch (error) {
        if (live) setLoadError(`Could not load this app. ${phoneOperationFailureReason(error)}`);
      }
    })();
    return () => {
      live = false;
    };
  }, [roomId, slug]);

  const run = React.useCallback(
    async (prompt: string) => {
      if (!roomId || !app?.authorId || busyAction) return;
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
      } catch (error) {
        Modal.alert('Could not send', phoneOperationFailureReason(error));
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
      onAction={app?.authorId ? (prompt) => void run(prompt) : undefined}
      onBack={() => router.back()}
      unavailableTitle={manifest?.title}
      unavailableMessage={
        loadError ??
        (manifest?.humanUi?.kind === 'broker'
          ? 'This app requires its permissioned UI broker, which is not connected on this device.'
          : undefined)
      }
    />
  );
}
