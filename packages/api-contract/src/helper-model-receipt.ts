/** Node-only authenticated same-response outcome. Never import into a phone
 * barrel. This contains no transcript, bearer or provider credential. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { OwnedModelAttemptReceipt } from './helper-model.js';

export const OWNED_MODEL_RECEIPT_MAX_CHARS = 1024;
const prefix = 'bfmr_v1.';
const reasons = ['authority', 'queue', 'cancelled', 'deadline'] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const tokenPattern = /^bfmc_v1\.[a-f0-9]{32}\.[a-f0-9]{64}$/;
const hash = (token: string) => createHash('sha256').update('beeline:owned-model:receipt:credential:v1\0').update(token).digest('hex');
function mac(token: string, body: string): Buffer {
  const key = createHmac('sha256', token).update('beeline:owned-model:receipt:key:v1\0').digest();
  return createHmac('sha256', key).update('beeline:owned-model:receipt:tag:v1\0').update(body).digest();
}
function closed(value: unknown, keys: string): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.getOwnPropertySymbols(value).length || Object.getOwnPropertyNames(value).sort().join() !== keys) return false;
  return Object.getOwnPropertyNames(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor?.enumerable === true && 'value' in descriptor;
  });
}
function tuple(receipt: unknown, credentialHash: string): unknown[] {
  if (!closed(receipt, 'requestId,state') && !closed(receipt, 'evidence,requestId,state')) throw new Error('Invalid owned model receipt');
  if (typeof receipt.requestId !== 'string' || !uuid.test(receipt.requestId)) throw new Error('Invalid owned model receipt');
  const header = [1, receipt.requestId, credentialHash];
  if (receipt.state === 'unknown' && !Object.hasOwn(receipt, 'evidence')) return [...header, 0];
  const evidence = receipt.evidence;
  if (receipt.state === 'succeeded' && closed(evidence, 'kind,tokens,usd') && evidence.kind === 'usage' &&
      Number.isSafeInteger(evidence.tokens) && Number(evidence.tokens) >= 0 && typeof evidence.usd === 'number' &&
      Number.isFinite(evidence.usd) && evidence.usd >= 0 && evidence.usd <= Number.MAX_SAFE_INTEGER)
    return [...header, 1, evidence.tokens, evidence.usd];
  if (receipt.state === 'refused' && closed(evidence, 'kind,reason') && evidence.kind === 'not-dispatched' &&
      reasons.includes(evidence.reason as typeof reasons[number])) return [...header, 2, 0, reasons.indexOf(evidence.reason as typeof reasons[number])];
  if (receipt.state === 'refused' && closed(evidence, 'kind,status') && evidence.kind === 'provider-refused' &&
      Number.isSafeInteger(evidence.status) && Number(evidence.status) >= 400 && Number(evidence.status) <= 599)
    return [...header, 2, 1, evidence.status];
  throw new Error('Invalid owned model receipt');
}

/** Call only with the outcome returned AFTER its settlement transaction commits.
 * This codec authenticates bytes; it does not itself assert DB authority. */
export function encodeOwnedModelReceipt(token: string, receipt: OwnedModelAttemptReceipt): string {
  if (typeof token !== 'string' || !tokenPattern.test(token)) throw new Error('Invalid owned model receipt');
  const body = Buffer.from(JSON.stringify(tuple(receipt, hash(token))), 'utf8').toString('base64url');
  const result = prefix + body + '.' + mac(token, body).toString('hex');
  if (result.length > OWNED_MODEL_RECEIPT_MAX_CHARS) throw new Error('Invalid owned model receipt');
  return result;
}

/** Untrusted SDK responseId. Null keeps the local UNKNOWN barrier closed. */
export function readOwnedModelReceipt(value: unknown, token: string, requestId: string): OwnedModelAttemptReceipt | null {
  try {
    if (typeof value !== 'string' || value.length > OWNED_MODEL_RECEIPT_MAX_CHARS || !value.startsWith(prefix) ||
        typeof token !== 'string' || !tokenPattern.test(token) || typeof requestId !== 'string' || !uuid.test(requestId)) return null;
    const parts = value.slice(prefix.length).split('.');
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[a-f0-9]{64}$/.test(parts[1]!)) return null;
    const body = parts[0]!;
    if (!timingSafeEqual(mac(token, body), Buffer.from(parts[1]!, 'hex'))) return null;
    const decoded: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!Array.isArray(decoded) || decoded[0] !== 1 || decoded[1] !== requestId || decoded[2] !== hash(token)) return null;
    let receipt: OwnedModelAttemptReceipt;
    if (decoded.length === 4 && decoded[3] === 0) receipt = { requestId, state: 'unknown' };
    else if (decoded.length === 6 && decoded[3] === 1) receipt = { requestId, state: 'succeeded', evidence: { kind: 'usage', tokens: decoded[4], usd: decoded[5] } };
    else if (decoded.length === 6 && decoded[3] === 2 && decoded[4] === 0 && Number.isInteger(decoded[5]) && reasons[decoded[5]])
      receipt = { requestId, state: 'refused', evidence: { kind: 'not-dispatched', reason: reasons[decoded[5]]! } };
    else if (decoded.length === 6 && decoded[3] === 2 && decoded[4] === 1)
      receipt = { requestId, state: 'refused', evidence: { kind: 'provider-refused', status: decoded[5] } };
    else return null;
    // Exact re-encoding rejects alternate base64/JSON/number spellings and
    // validates every semantic field before returning a typed outcome.
    return encodeOwnedModelReceipt(token, receipt) === value ? Object.freeze(receipt) : null;
  } catch { return null; }
}
