import type { PhoneSocket } from './phone-live-output.js';

function plantedPhoneBackdoors(client: PhoneSocket) {
  // @ts-expect-error Phone handlers do not own shutdown authority.
  client.close();
  // @ts-expect-error Phone handlers cannot terminate a slow connection.
  client.terminate();
  // @ts-expect-error Event subscriptions do not return the raw WebSocket.
  client.on('close', () => {}).terminate();
  // @ts-expect-error Native stream ownership never escapes admission.
  client._socket.destroy();
}
void plantedPhoneBackdoors;
