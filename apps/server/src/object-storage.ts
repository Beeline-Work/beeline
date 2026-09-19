/**
 * One module owning every word we say to S3-compatible object storage
 * (production: Fly Tigris, provisioned with `fly storage create`).
 *
 * Signing rests on `aws4fetch` for header- and query-signed requests; the
 * presigned POST policy is signed here, because a POST policy signs the
 * base64 policy document directly with the derived signing key rather than a
 * canonical request, which aws4fetch does not model.
 *
 * The credentials come from the environment exactly as `fly secrets` stages
 * them: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`
 * and `BUCKET_NAME`. Absent any of them there is no storage: the server runs
 * and every object write answers a clear 503.
 *
 * Presigning is HMAC-only and needs no storage round-trip; the injected clock
 * keeps the golden-signature tests deterministic.
 */
import { AwsClient } from 'aws4fetch';
import { createHmac } from 'node:crypto';

export interface ObjectStorageConfig {
  accessKeyId: string;
  secretAccessKey: string;
  /** S3 endpoint base URL, e.g. https://fly.storage.tigris.dev */
  endpoint: string;
  bucket: string;
  region?: string;
}

export interface ObjectStorageOptions {
  /** Injectable clock for policy expiration and signed dates. */
  now?: () => number;
  fetch?: typeof fetch;
}

export interface PresignGetOptions {
  /** Seconds the signed URL stays valid; storage refuses anything older. */
  expiresIn?: number;
  /** Signed into the request so the response carries it — inside the signature. */
  responseContentDisposition?: string;
  responseContentType?: string;
}

export interface HeadObjectResult {
  size: number;
  etag?: string;
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

export class ObjectStorage {
  readonly #client: AwsClient;
  readonly #endpoint: string;
  readonly #bucket: string;
  readonly #region: string;
  readonly #now: () => number;

  constructor(config: ObjectStorageConfig, options: ObjectStorageOptions = {}) {
    this.#client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: 's3',
      region: config.region ?? 'auto',
    });
    this.#endpoint = config.endpoint.replace(/\/+$/, '');
    this.#bucket = config.bucket;
    this.#region = config.region ?? 'auto';
    this.#now = options.now ?? Date.now;
    if (options.fetch) this.#client.fetch = options.fetch.bind(globalThis);
  }

  get bucket(): string {
    return this.#bucket;
  }

  /** Path-style object URL; Tigris serves `<endpoint>/<bucket>/<key>`. */
  objectUrl(key: string): string {
    return `${this.#endpoint}/${this.#bucket}/${key}`;
  }

  /** AmzDate: `YYYYMMDDTHHMMSSZ` from the injected clock. */
  #amzDate(): { amzDate: string; dateStamp: string } {
    const iso = new Date(this.#now()).toISOString().replace(/[-:]/g, '');
    return { amzDate: iso.replace(/\.\d{3}/, ''), dateStamp: iso.slice(0, 8) };
  }

  async putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
    const response = await this.#client.fetch(this.objectUrl(key), {
      method: 'PUT',
      body: Buffer.from(body),
      headers: { 'content-type': contentType },
    });
    if (!response.ok) throw new Error(`object storage put failed: HTTP ${response.status}`);
  }

  /**
   * A presigned POST policy pinning the key, the exact content type and an
   * exact `content-length-range` (`[size, size]`), so storage itself refuses
   * bytes that differ from what the server recorded. Returns the form action
   * and every field the client must POST verbatim alongside `file`.
   */
  presignPost(
    key: string,
    options: { contentType: string; size: number; expiresIn?: number },
  ): { url: string; fields: Record<string, string> } {
    const expiresIn = options.expiresIn ?? 600;
    const { amzDate, dateStamp } = this.#amzDate();
    const credential = `${this.#client.accessKeyId}/${dateStamp}/${this.#region}/s3/aws4_request`;
    const expiration = new Date(this.#now() + expiresIn * 1_000).toISOString();
    const policy = {
      expiration,
      conditions: [
        { bucket: this.#bucket },
        { key },
        { 'Content-Type': options.contentType },
        ['content-length-range', options.size, options.size],
        { 'x-amz-credential': credential },
        { 'x-amz-algorithm': 'AWS4-HMAC-SHA256' },
        { 'x-amz-date': amzDate },
      ],
    } as const;
    const encodedPolicy = Buffer.from(JSON.stringify(policy)).toString('base64');
    const kDate = hmac(`AWS4${this.#client.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, this.#region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(encodedPolicy).digest('hex');
    return {
      url: `${this.#endpoint}/${this.#bucket}`,
      fields: {
        key,
        'Content-Type': options.contentType,
        policy: encodedPolicy,
        'x-amz-algorithm': 'AWS4-HMAC-SHA256',
        'x-amz-credential': credential,
        'x-amz-date': amzDate,
        'x-amz-signature': signature,
      },
    };
  }

  /**
   * A presigned GET. `response-content-disposition` (and content type) are
   * part of the signed query, so storage serves the header itself and a
   * browser download keeps its filename without any server round-trip.
   */
  async presignGet(key: string, options: PresignGetOptions = {}): Promise<string> {
    const url = new URL(this.objectUrl(key));
    url.searchParams.set('X-Amz-Expires', String(options.expiresIn ?? 600));
    if (options.responseContentDisposition)
      url.searchParams.set('response-content-disposition', options.responseContentDisposition);
    if (options.responseContentType)
      url.searchParams.set('response-content-type', options.responseContentType);
    const signed = await this.#client.sign(url, { aws: { signQuery: true } });
    return signed.url;
  }

  /** null when storage has no such object; other errors surface. */
  async headObject(key: string): Promise<HeadObjectResult | null> {
    const response = await this.#client.fetch(this.objectUrl(key), { method: 'HEAD' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`object storage head failed: HTTP ${response.status}`);
    const length = response.headers.get('content-length');
    return {
      size: length !== null ? Number(length) : 0,
      ...(response.headers.has('etag') ? { etag: response.headers.get('etag') ?? undefined } : {}),
    };
  }

  /** 404 is null; other errors surface. Used when promoting an upload into avatars. */
  async getObject(key: string): Promise<Uint8Array | null> {
    const response = await this.#client.fetch(this.objectUrl(key), { method: 'GET' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`object storage get failed: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  /** Deleting a missing object is success: the sweep is idempotent on reruns. */
  async deleteObject(key: string): Promise<void> {
    const response = await this.#client.fetch(this.objectUrl(key), { method: 'DELETE' });
    if (!response.ok && response.status !== 404)
      throw new Error(`object storage delete failed: HTTP ${response.status}`);
  }
}

/** The one env reading. Absent names mean no storage, never a half-configured one. */
export function objectStorageFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: ObjectStorageOptions = {},
): ObjectStorage | undefined {
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  const endpoint = env.AWS_ENDPOINT_URL_S3;
  const bucket = env.BUCKET_NAME;
  if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) return undefined;
  return new ObjectStorage({ accessKeyId, secretAccessKey, endpoint, bucket }, options);
}
