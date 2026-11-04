// @ts-expect-error The connection owner is module-private.
import { LiveConnection } from './live-connection';
import { sharedLiveConnection } from './live-connection';

function plantedConnectionBackdoors() {
  const client = sharedLiveConnection();
  // @ts-expect-error Production callers cannot end the shared connection.
  client.dispose();
  // @ts-expect-error No socket handle escapes the client facade.
  client.socket.close();
  // @ts-expect-error Connection death is owner-only.
  client.declareDead(undefined);
  // @ts-expect-error A second caller cannot replace the singleton's methods.
  client.reconnectNow = () => undefined;
}
void LiveConnection;
void plantedConnectionBackdoors;
