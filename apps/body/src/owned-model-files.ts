import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, fchmodSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync,
  readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { readOwnedModelReceipt } from '@beeline/api-contract/helper-model-receipt';

/** Private generation files only. No transport, provider registration, local
 * retry, runtime activation or current-authority assertion lives in this leaf. */
export const OWNED_MODEL_FILE_MAX_BYTES = 32 * 1024;
export interface OwnedModelFileBinding {
  readonly agentId: string;
  readonly commandId: string;
  readonly generationId: string;
  readonly connectionId: string;
  readonly connectionEpoch: number;
  readonly provider: 'beeline';
  readonly model: string;
  readonly baseUrl: string;
}
export interface OwnedModelFileCredential { readonly v: 1; readonly token: string; readonly expiresAt: number }
interface CredentialFile { v: 1; binding: OwnedModelFileBinding; credential: OwnedModelFileCredential }
interface Journal { v: 1; bindingHash: string; requests: { id: string; state: 'unknown' | 'succeeded' | 'refused' }[]; active: string | null }
interface Owner { directory: string; authPath: string; journalPath: string; binding: OwnedModelFileBinding; digest: string; bindingHash: string }
export class OwnedModelFileRefusal extends Error {
  constructor() { super('Owned model local intent is unavailable or UNKNOWN; do not resubmit.'); }
}
const owners = new WeakMap<object, Owner>();
const hash = (value: string) => createHash('sha256').update('beeline:owned-model:private-file:v1\0').update(value).digest('hex');
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
function closed(value: unknown, fields: string): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.getOwnPropertySymbols(value).length || Object.getOwnPropertyNames(value).sort().join() !== fields) return false;
  return Object.getOwnPropertyNames(value).every(key => {
    const field = Object.getOwnPropertyDescriptor(value, key); return field?.enumerable === true && 'value' in field;
  });
}
function binding(value: OwnedModelFileBinding): OwnedModelFileBinding {
  if (!closed(value, 'agentId,baseUrl,commandId,connectionEpoch,connectionId,generationId,model,provider') ||
      ![value.agentId, value.commandId, value.generationId, value.connectionId, value.model].every(text) || value.provider !== 'beeline' ||
      !Number.isSafeInteger(value.connectionEpoch) || value.connectionEpoch <= 0 || typeof value.baseUrl !== 'string' || value.baseUrl.length > 2048)
    throw new OwnedModelFileRefusal();
  let url: URL;
  try { url = new URL(value.baseUrl); } catch { throw new OwnedModelFileRefusal(); }
  if (url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, '') !== '/v1/free-agents/model' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))))
    throw new OwnedModelFileRefusal();
  return Object.freeze({ agentId: value.agentId, commandId: value.commandId, generationId: value.generationId,
    connectionId: value.connectionId, connectionEpoch: value.connectionEpoch, provider: 'beeline', model: value.model,
    baseUrl: url.origin + '/v1/free-agents/model' });
}
function credential(value: OwnedModelFileCredential): OwnedModelFileCredential {
  if (!closed(value, 'expiresAt,token,v') || value.v !== 1 || typeof value.token !== 'string' ||
      !/^bfmc_v1\.[a-f0-9]{32}\.[a-f0-9]{64}$/.test(value.token) || !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= 0 || value.expiresAt > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) throw new OwnedModelFileRefusal();
  return Object.freeze({ v: 1, token: value.token, expiresAt: value.expiresAt });
}
function privateDirectory(path: string): void {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o700 ||
      typeof process.getuid === 'function' && stats.uid !== process.getuid()) throw new OwnedModelFileRefusal();
}
function directorySync(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
function writeNew(path: string, contents: string): void {
  if (Buffer.byteLength(contents) > OWNED_MODEL_FILE_MAX_BYTES) throw new OwnedModelFileRefusal();
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { fchmodSync(descriptor, 0o600); writeFileSync(descriptor, contents, 'utf8'); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}
function readPrivate(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.nlink !== 1 || stats.size > OWNED_MODEL_FILE_MAX_BYTES || (stats.mode & 0o777) !== 0o600 ||
        typeof process.getuid === 'function' && stats.uid !== process.getuid()) throw new OwnedModelFileRefusal();
    // Bound the read itself: an earlier stat is not a byte limit if another
    // process grows the file while this descriptor is open.
    const bytes = Buffer.alloc(OWNED_MODEL_FILE_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > OWNED_MODEL_FILE_MAX_BYTES) throw new OwnedModelFileRefusal();
    return bytes.subarray(0, length).toString('utf8');
  } finally { closeSync(descriptor); }
}
function readCredential(owner: Owner, now: number): CredentialFile {
  privateDirectory(owner.directory);
  if (existsSync(join(owner.directory, 'revoked'))) throw new OwnedModelFileRefusal();
  const bytes = readPrivate(owner.authPath);
  if (hash(bytes) !== owner.digest) throw new OwnedModelFileRefusal();
  const parsed: unknown = JSON.parse(bytes);
  if (!closed(parsed, 'binding,credential,v') || parsed.v !== 1 ||
      JSON.stringify(binding(parsed.binding as OwnedModelFileBinding)) !== JSON.stringify(owner.binding)) throw new OwnedModelFileRefusal();
  const authenticated = credential(parsed.credential as OwnedModelFileCredential);
  if (authenticated.expiresAt * 1000 <= now) throw new OwnedModelFileRefusal();
  return { v: 1, binding: owner.binding, credential: authenticated };
}
function readJournal(owner: Owner): Journal {
  const value: unknown = JSON.parse(readPrivate(owner.journalPath));
  if (!closed(value, 'active,bindingHash,requests,v') || value.v !== 1 || value.bindingHash !== owner.bindingHash ||
      !Array.isArray(value.requests) ||
      value.active !== null && typeof value.active !== 'string') throw new OwnedModelFileRefusal();
  const ids = new Set<string>();
  for (const entry of value.requests) {
    if (!closed(entry, 'id,state') || typeof entry.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry.id) ||
        !['unknown', 'succeeded', 'refused'].includes(String(entry.state)) || ids.has(entry.id))
      throw new OwnedModelFileRefusal();
    if (entry.state === 'unknown' && entry !== value.requests.at(-1)) throw new OwnedModelFileRefusal();
    ids.add(entry.id);
  }
  const latest = value.requests.at(-1);
  if (value.active !== (latest?.state === 'unknown' ? latest.id : null)) throw new OwnedModelFileRefusal();
  return value as unknown as Journal;
}
function saveJournal(owner: Owner, journal: Journal): void {
  const temporary = join(owner.directory, 'requests-' + randomBytes(16).toString('hex') + '.tmp');
  writeNew(temporary, JSON.stringify(journal)); renameSync(temporary, owner.journalPath); directorySync(owner.directory);
}

/** Opens an exact generation, never a mutable shared credential path. JSON
 * serialization of this owner exposes neither bearer nor private state. */
export class OwnedModelFiles {
  private constructor() {}
  static create(input: { root: string; binding: OwnedModelFileBinding; credential: OwnedModelFileCredential }): OwnedModelFiles {
    try {
      if (!isAbsolute(input.root)) throw new OwnedModelFileRefusal();
      const selected = binding(input.binding), granted = credential(input.credential), root = resolve(input.root);
      mkdirSync(root, { recursive: true, mode: 0o700 }); privateDirectory(root);
      // Source/model changes cannot create another file for the same claimed
      // generation. Origin partitions the same principal at distinct servers.
      const identity = hash(JSON.stringify([new URL(selected.baseUrl).origin, selected.agentId, selected.commandId, selected.generationId]));
      const directory = join(root, 'model-' + identity), authPath = join(directory, 'credential.json'), journalPath = join(directory, 'requests.json');
      const contents = JSON.stringify({ v: 1, binding: selected, credential: granted } satisfies CredentialFile);
      const owner: Owner = { directory, authPath, journalPath, binding: selected, digest: hash(contents), bindingHash: hash(JSON.stringify(selected)) };
      let created = false;
      try { mkdirSync(directory, { mode: 0o700 }); created = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if (created) {
        writeNew(authPath, contents); writeNew(journalPath, JSON.stringify({ v: 1, bindingHash: owner.bindingHash, requests: [], active: null } satisfies Journal));
        directorySync(directory); directorySync(root);
      }
      readCredential(owner, Date.now()); readJournal(owner);
      const value = new OwnedModelFiles(); owners.set(value, owner); return value;
    } catch { throw new OwnedModelFileRefusal(); }
  }
  /** Exact files for the private sandbox/extension installer. Paths are not
   * credentials and never carry request/local admission metadata to a server. */
  paths(): Readonly<{ directory: string; credential: string; journal: string }> {
    const owner = owners.get(this); if (!owner) throw new OwnedModelFileRefusal();
    return Object.freeze({ directory: owner.directory, credential: owner.authPath, journal: owner.journalPath });
  }
  binding(): OwnedModelFileBinding {
    const owner = owners.get(this); if (!owner) throw new OwnedModelFileRefusal(); return owner.binding;
  }
  snapshot(): Readonly<{ state: 'idle' | 'unknown'; requests: readonly string[] }> {
    try {
      const owner = owners.get(this); if (!owner) throw new OwnedModelFileRefusal(); privateDirectory(owner.directory);
      const journal = readJournal(owner);
      return Object.freeze({ state: journal.active === null ? 'idle' : 'unknown', requests: Object.freeze(journal.requests.map(entry => entry.id)) });
    } catch { throw new OwnedModelFileRefusal(); }
  }
  /** Synchronous owner admission. The UUID is durably UNKNOWN before returning
   * usable authorization. Header-only/SDK events cannot clear this latch. */
  prepareHeaders(): Readonly<{ requestId: string; authorization: string }> {
    try {
      const owner = owners.get(this); if (!owner) throw new OwnedModelFileRefusal();
      const current = readCredential(owner, Date.now());
      if (readJournal(owner).active !== null) throw new OwnedModelFileRefusal();
      const lock = join(owner.directory, 'requests.lock'); writeNew(lock, 'owned model request admission'); directorySync(owner.directory);
      // Keep any failed/uncertain lock. Never guess that another process died
      // and unlink its replacement, or recreate an absent journal after crash.
      const journal = readJournal(owner);
      if (journal.active !== null) throw new OwnedModelFileRefusal();
      // Settled history does not consume the generation's next request. Only
      // the active UUID can authenticate a receipt; old receipts stay inert.
      journal.requests = [];
      const requestId = randomUUID(); journal.requests.push({ id: requestId, state: 'unknown' }); journal.active = requestId;
      saveJournal(owner, journal);
      unlinkSync(lock); directorySync(owner.directory);
      return Object.freeze({ requestId, authorization: 'Bearer ' + current.credential.token });
    } catch { throw new OwnedModelFileRefusal(); }
  }
  /** A response/header/SDK event alone cannot clear UNKNOWN. The only clearing
   * evidence is a request-and-credential-bound authenticated server outcome. */
  confirmReceipt(value: unknown): boolean { return this.confirmOutcome(value, false); }
  confirmRetryableRefusal(value: unknown): boolean { return this.confirmOutcome(value, true); }
  private confirmOutcome(value: unknown, refusal: boolean): boolean {
    try {
      const owner = owners.get(this); if (!owner) return false;
      const current = readCredential(owner, Date.now()), journal = readJournal(owner), latest = journal.requests.at(-1);
      if (!latest) return false;
      const receipt = readOwnedModelReceipt(value, current.credential.token, latest.id);
      const retryable = receipt?.state === 'refused' &&
        (receipt.evidence?.kind === 'provider-refused' && receipt.evidence.status === 429 ||
         receipt.evidence?.kind === 'not-dispatched' && receipt.evidence.reason === 'queue');
      if (refusal ? !retryable : receipt?.state !== 'succeeded' || receipt.evidence?.kind !== 'usage') return false;
      const settled = refusal ? 'refused' : 'succeeded';
      if (latest.state === settled) return true;
      const lock = join(owner.directory, 'requests.lock'); writeNew(lock, 'owned model terminal receipt'); directorySync(owner.directory);
      const locked = readJournal(owner), active = locked.requests.at(-1);
      if (!active || active.id !== latest.id || active.state !== 'unknown' || locked.active !== active.id) return false;
      active.state = settled; locked.active = null; saveJournal(owner, locked);
      unlinkSync(lock); directorySync(owner.directory); return true;
    } catch { return false; }
  }
  /** Call only after the originating task/child drains. Unknown request IDs
   * remain durable; no network cancellation or known-refusal is invented. */
  revoke(): void {
    try {
      const owner = owners.get(this); if (!owner) throw new OwnedModelFileRefusal(); privateDirectory(owner.directory);
      const tombstone = join(owner.directory, 'revoked');
      if (!existsSync(tombstone)) { writeNew(tombstone, 'ended'); directorySync(owner.directory); }
      if (existsSync(owner.authPath)) unlinkSync(owner.authPath);
      directorySync(owner.directory);
    } catch { throw new OwnedModelFileRefusal(); }
  }
}
