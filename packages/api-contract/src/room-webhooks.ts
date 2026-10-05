export const WEBHOOK_MAX_BYTES = 32 * 1024;
export function isWebhookSource(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9-]{1,40}$/.test(value);
}
export type WebhookRequestCard = {
  requestId: string; agentId: string; agentName: string; source: string; reason: string;
  status: 'pending' | 'approved' | 'denied' | 'expired'; expiresAt: number;
};
export type RoomWebhookView = { id: string; source: string; signed: boolean; revoked: boolean };
export type WebhookDeliveryView = { id: string; source: string; receivedAt: number; delivered: number };
export type RoomWebhooksResult = {
  sources: RoomWebhookView[]; requests: WebhookRequestCard[]; deliveries: WebhookDeliveryView[];
};
