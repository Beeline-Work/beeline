import { sharedLiveConnection } from '@/sync/transport/live-connection';

/** The update adapter observes the socket owner’s confirmed availability generations. */
export function subscribeUpdateConnections(listener: (generation: number) => void): () => void {
    const connection = sharedLiveConnection();
    return connection.subscribeConnected(() => listener(connection.commandState().generation));
}
