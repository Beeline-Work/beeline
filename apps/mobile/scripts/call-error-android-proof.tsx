/** Local proof only: fixture server owns disposable authentication. */
import 'react-native-get-random-values';
import '@livekit/react-native';
import '../sources/unistyles';
import { monolithSession } from '../sources/auth/monolith-session';
import './multi-human-silence-native-proof';
monolithSession.fetch = (input, init = {}, options = {}) => (options.fetchImpl ?? fetch)(input, init);

// Observe actual inbound RTP on the native client, without changing the transport.
import { Room, RoomEvent } from 'livekit-client';
const emit = Room.prototype.emit;
(Room.prototype as any).emit = function (event: string, ...args: any[]) {
  const track = args[0];
  if (event === RoomEvent.TrackSubscribed && track.kind === 'audio') {
    const timer = setInterval(() => {
      void track.getRTCStatsReport().then((stats: any) => {
        const audio: unknown[] = [];
        stats?.forEach((row: any) => { if (row.type === 'inbound-rtp') audio.push({ bytesReceived: row.bytesReceived, packetsReceived: row.packetsReceived, totalAudioEnergy: row.totalAudioEnergy }); });
        return fetch('http://10.0.2.2:18097/observe', { method: 'POST', body: JSON.stringify({ at: Date.now(), nativeAudio: audio }) });
      }).catch(() => {});
    }, 500);
    this.once(RoomEvent.Disconnected, () => clearInterval(timer));
  }
  return emit.apply(this, [event, ...args] as any);
};
