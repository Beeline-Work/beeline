import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import type { CornerAppManifest, CornerAppView } from '@beeline/api-contract/phone';
import { isRoomView } from '@beeline/buzz-client';
import { CornerAppScreen } from '@/components/buzz/CornerAppScreen';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
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
    let stop: (() => void) | undefined;
    void (async () => {
      if (!roomId || !slug) return;
      try {
        const identity = await loadBuzzIdentity();
        if (!identity) throw new Error('not signed in');
        const relayUrl = await getEffectiveRelayUrl();
        if (!live) return;
        // The chat's live Room surface owns the app list; this route reads the same entry.
        const address = surfaceAddress(relayUrl, identity.publicKey, `/room/${roomId}`);
        const paint = () => {
          const view = mobileSurfaceCache.peek(address, isRoomView);
          if (!live || !view) return false;
          setApp(view.cornerApps?.find((candidate) => candidate.slug === slug));
          setManifest(view.boundApp?.manifest.slug === slug ? view.boundApp.manifest : undefined);
          setLoadError(undefined);
          return true;
        };
        stop = mobileSurfaceCache.subscribe(address, () => void paint());
        if (paint()) return;
        await mobileSurfaceCache.fetch(address, isRoomView, () =>
          new RoomViewClient({ baseUrl: relayUrl, identity }).room(roomId),
        );
      } catch (error) {
        if (live) setLoadError(`Could not load this app. ${phoneOperationFailureReason(error)}`);
      }
    })();
    return () => {
      live = false;
      stop?.();
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
