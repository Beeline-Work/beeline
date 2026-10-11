import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { fireServiceSubscriptions } from './agent-subscriptions.js';

/** Verify the raw Standard Webhooks delivery before parsing any outside data. */
export function verifyComposioDelivery(raw: Buffer, headers: Record<string, string | string[] | undefined>,
  secret: string, now = Date.now()): string | undefined {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signature = headers['webhook-signature'];
  if (typeof id !== 'string' || !id || typeof timestamp !== 'string' ||
    !/^\d{10}$/.test(timestamp) || typeof signature !== 'string' || !secret ||
    Math.abs(now / 1000 - Number(timestamp)) > 300) return undefined;
  const expected = createHmac('sha256', secret)
    .update(`${id}.${timestamp}.`).update(raw).digest();
  for (const version of signature.split(' ')) {
    if (!version.startsWith('v1,')) continue;
    const received = Buffer.from(version.slice(3), 'base64');
    if (received.length === expected.length && timingSafeEqual(received, expected)) return id;
  }
  return undefined;
}

/** The HTTP route and integration proof use the same authenticated ingestion path. */
export async function ingestComposioDelivery(db: SqlDatabase, raw: Buffer,
  headers: Record<string, string | string[] | undefined>, secret: string): Promise<boolean> {
  const id = verifyComposioDelivery(raw, headers, secret);
  if (!id) return false;
  let value: unknown;
  try { value = JSON.parse(raw.toString('utf8')) as unknown; } catch { return false; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  const deliveryId = typeof envelope.id === 'string' && envelope.id ? envelope.id : id;
  await fireServiceSubscriptions(db, envelope, deliveryId);
  return true;
}
