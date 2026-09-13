import {
  connect as http2Connect,
  constants as http2Constants,
  type ClientHttp2Session,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from 'node:http2';
import { createPrivateKey, sign } from 'node:crypto';
import type { PushSender } from './background.js';
import { pushMessageData, type PushDeliveryMessage } from './firebase-push.js';

const APNS_PRODUCTION_AUTHORITY = 'https://api.push.apple.com';
const APNS_SANDBOX_AUTHORITY = 'https://api.sandbox.push.apple.com';
const APNS_TOKEN_REFRESH_SECONDS = 50 * 60;
const APNS_REQUEST_TIMEOUT_MS = 15_000;

interface ApnsEnvironment {
  APNS_BUNDLE_ID?: string;
  APNS_ENVIRONMENT?: string;
  APNS_KEY_ID?: string;
  APNS_KEY_P8_BASE64?: string;
  APNS_TEAM_ID?: string;
}

export interface ApnsProviderOptions {
  authority?: string;
  bundleId: string;
  connect?: (authority: string) => ClientHttp2Session;
  keyId: string;
  privateKey: string | Buffer;
  teamId: string;
}

export type ApnsResponseClassification = 'success' | 'unregistered' | 'retryable' | 'permanent';

export class ApnsPushError extends Error {
  readonly code: string;

  constructor(
    message: string,
    readonly status: number,
    readonly reason: string,
    readonly classification: Exclude<ApnsResponseClassification, 'success'>,
  ) {
    super(message);
    this.name = 'ApnsPushError';
    this.code =
      classification === 'unregistered' ? 'apns/unregistered-device-token' : 'apns/delivery-error';
  }
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

export function buildApnsProviderToken(
  keyId: string,
  teamId: string,
  privateKey: string | Buffer,
  issuedAtSeconds = Math.floor(Date.now() / 1000),
): string {
  const header = base64Url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = base64Url(JSON.stringify({ iss: teamId, iat: issuedAtSeconds }));
  const input = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(input), {
    key: createPrivateKey(privateKey),
    dsaEncoding: 'ieee-p1363',
  });
  return `${input}.${base64Url(signature)}`;
}

export function apnsPushRequest(
  token: string,
  message: PushDeliveryMessage,
  bundleId: string,
  providerToken: string,
): { headers: OutgoingHttpHeaders; payload: Record<string, unknown> } {
  const data = pushMessageData(message);
  const threadId = data.threadId ?? data.roomId;
  return {
    headers: {
      [http2Constants.HTTP2_HEADER_METHOD]: 'POST',
      [http2Constants.HTTP2_HEADER_PATH]: `/3/device/${encodeURIComponent(token)}`,
      authorization: `bearer ${providerToken}`,
      'apns-topic': bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': '0',
      ...(threadId ? { 'apns-collapse-id': threadId } : {}),
    },
    payload: {
      aps: {
        alert: { title: 'Beeline', body: message.text.slice(0, 200) },
        sound: 'default',
        ...(threadId ? { 'thread-id': threadId } : {}),
      },
      ...data,
    },
  };
}

export function classifyApnsResponse(status: number, reason = ''): ApnsResponseClassification {
  if (status >= 200 && status < 300) return 'success';
  if (
    (status === 410 && reason === 'Unregistered') ||
    (status === 400 && (reason === 'BadDeviceToken' || reason === 'Unregistered'))
  )
    return 'unregistered';
  if (status === 429 || status >= 500) return 'retryable';
  return 'permanent';
}

function responseReason(body: string): string {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    return typeof parsed.reason === 'string' ? parsed.reason : '';
  } catch {
    return '';
  }
}

export class ApnsPushProvider implements PushSender {
  readonly #authority: string;
  readonly #bundleId: string;
  readonly #connect: (authority: string) => ClientHttp2Session;
  readonly #keyId: string;
  readonly #privateKey: string | Buffer;
  readonly #teamId: string;
  #providerToken?: { issuedAt: number; value: string };
  #session?: ClientHttp2Session;

  constructor(options: ApnsProviderOptions) {
    this.#authority = options.authority ?? APNS_PRODUCTION_AUTHORITY;
    this.#bundleId = options.bundleId;
    this.#connect = options.connect ?? http2Connect;
    this.#keyId = options.keyId;
    this.#privateKey = options.privateKey;
    this.#teamId = options.teamId;
    // Fail boot for a configured but unusable key instead of failing every delivery later.
    this.#token();
  }

  #token(nowSeconds = Math.floor(Date.now() / 1000)): string {
    if (
      !this.#providerToken ||
      nowSeconds - this.#providerToken.issuedAt >= APNS_TOKEN_REFRESH_SECONDS
    ) {
      this.#providerToken = {
        issuedAt: nowSeconds,
        value: buildApnsProviderToken(this.#keyId, this.#teamId, this.#privateKey, nowSeconds),
      };
    }
    return this.#providerToken.value;
  }

  #client(): ClientHttp2Session {
    if (this.#session && !this.#session.closed && !this.#session.destroyed) return this.#session;
    const session = this.#connect(this.#authority);
    session.on('error', () => {
      if (this.#session === session) this.#session = undefined;
    });
    session.on('goaway', () => {
      if (this.#session === session) this.#session = undefined;
      session.close();
    });
    this.#session = session;
    return session;
  }

  async send(token: string, message: PushDeliveryMessage): Promise<void> {
    const request = apnsPushRequest(token, message, this.#bundleId, this.#token());
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      let stream;
      try {
        stream = this.#client().request(request.headers);
      } catch (error) {
        fail(error);
        return;
      }
      let headers: IncomingHttpHeaders = {};
      let body = '';
      stream.setEncoding('utf8');
      stream.on('response', (value) => {
        headers = value;
      });
      stream.on('data', (chunk: string) => {
        body += chunk;
      });
      stream.on('error', fail);
      stream.setTimeout(APNS_REQUEST_TIMEOUT_MS, () => {
        stream.close(http2Constants.NGHTTP2_CANCEL);
        fail(new Error('APNs request timed out'));
      });
      stream.on('end', () => {
        if (settled) return;
        settled = true;
        const status = Number(headers[http2Constants.HTTP2_HEADER_STATUS] ?? 0);
        const reason = responseReason(body);
        const classification = classifyApnsResponse(status, reason);
        if (classification === 'success') resolve();
        else
          reject(
            new ApnsPushError(
              `APNs request failed (${status} ${reason || 'unknown'})`,
              status,
              reason,
              classification,
            ),
          );
      });
      stream.end(JSON.stringify(request.payload));
    });
  }

  close(): void {
    this.#session?.close();
    this.#session = undefined;
  }
}

export function createApnsPushSender(
  environment: ApnsEnvironment = process.env,
  log: (message: string) => void = console.log,
): ApnsPushProvider | undefined {
  if (!environment.APNS_KEY_P8_BASE64) {
    log('[push] iOS APNs delivery disabled: APNS_KEY_P8_BASE64 is not set');
    return undefined;
  }
  if (!environment.APNS_KEY_ID)
    throw new Error('APNS_KEY_ID is required when APNS_KEY_P8_BASE64 is set');
  if (
    environment.APNS_ENVIRONMENT &&
    !['production', 'sandbox'].includes(environment.APNS_ENVIRONMENT)
  )
    throw new Error('APNS_ENVIRONMENT must be production or sandbox');
  const privateKey = Buffer.from(environment.APNS_KEY_P8_BASE64, 'base64').toString('utf8');
  return new ApnsPushProvider({
    authority:
      environment.APNS_ENVIRONMENT === 'sandbox'
        ? APNS_SANDBOX_AUTHORITY
        : APNS_PRODUCTION_AUTHORITY,
    bundleId: environment.APNS_BUNDLE_ID ?? 'app.usebeeline.mobile',
    keyId: environment.APNS_KEY_ID,
    privateKey,
    teamId: environment.APNS_TEAM_ID ?? '89KT3SWYAF',
  });
}
