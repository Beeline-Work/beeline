import { sharedLiveConnection } from '@/sync/transport/live-connection';

/** The existing update adapter observes actual socket generations only. */
export function subscribeUpdateConnections(listener: (generation: number) => void): () => void {
    const connection = sharedLiveConnection();
    return connection.subscribeConnected(() => listener(connection.commandState().generation));
}
