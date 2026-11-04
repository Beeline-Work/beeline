// @ts-expect-error Implementations are module-private, not another store entrypoint.
import { ChatReads, TrayReads } from './server-read-owner';
import type { MonolithRigTransport } from '@/sync/transport/monolith-rig-transport';
import { monolithPhoneOperation, readServerSurface } from '@/sync/transport/monolith-operation';
import { RoomViewClient } from '@/sync/transport/room-view-client';
function plantedBackdoors(client: RoomViewClient, transport: MonolithRigTransport) {
  // @ts-expect-error A feature cannot dispatch a committed Tray read through the generic executor.
  void monolithPhoneOperation('readTray', { workspaceId: 'ws' });
  // @ts-expect-error The retained generic transport cannot dispatch an owned surface read.
  void transport.operation('readChats', { workspaceId: 'ws' });
  // @ts-expect-error No feature can construct the owner's private capability.
  void readServerSurface({}, 'readTray', { workspaceId: 'ws' });
  // @ts-expect-error Room-list reads require the same unforgeable capability.
  void client.chats({}, 'ws');
}
void plantedBackdoors;

void ChatReads;
void TrayReads;
