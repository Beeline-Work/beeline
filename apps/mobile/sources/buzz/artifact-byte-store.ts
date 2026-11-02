import { Platform } from 'react-native';
import { cacheDirectory, deleteAsync, EncodingType, getInfoAsync, makeDirectoryAsync,
  moveAsync, readAsStringAsync, readDirectoryAsync, writeAsStringAsync } from 'expo-file-system/legacy';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { RouterAuthorityCertificate } from '@beeline/api-contract/router-protocol';
import type { ImmutableByteStore } from './immutable-byte-cache';
import { base64ToBytes, bytesToBase64 } from './byte-base64';
const DISK_LIMIT = 126 * 1024 * 1024; // Reserve index/atomic-write overhead below the 128 MiB ceiling.
const OBJECT_LIMIT = 25 * 1024 * 1024;
type Meta = { name: string; size: number; used: number; authority?: RouterAuthorityCertificate };
type Details = { format: string; authority?: RouterAuthorityCertificate };
const removedBy = (authority: RouterAuthorityCertificate | undefined, scope: string, epoch: string) =>
  !authority || !Array.isArray(authority.scopes) || authority.scopes.some(domain => !domain ||
    typeof domain.authorityScope !== 'string' || !/^\d+$/.test(domain.epoch) ||
    domain.authorityScope === scope && BigInt(domain.epoch) <= BigInt(epoch));
export type ArtifactByteStore = ImmutableByteStore & { localUri(key: string): Promise<string | null>; revoke(scope: string, epoch: string): Promise<readonly string[]> };


class NativeArtifactByteStore implements ArtifactByteStore {
  private readonly directory = cacheDirectory ? `${cacheDirectory}beeline-immutable-bytes-v1/` : '';
  private readonly index = new Map<string, Meta>();
  private serial: Promise<void> = Promise.resolve();
  private initialized = false;
  private sequence = 0;
  constructor(private readonly details: (key: string) => Details) {}
  private run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(work);
    this.serial = result.then(() => {}, () => {}); return result;
  }
  private async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.directory) throw new Error('File cache is unavailable.');
    await makeDirectoryAsync(this.directory, { intermediates: true });
    try {
      const encoded = await readAsStringAsync(`${this.directory}index.json`, { encoding: EncodingType.UTF8 });
      if (encoded.length > 1024 * 1024) throw new Error('File cache index exceeds budget.');
      const entries: unknown = JSON.parse(encoded);
      if (!Array.isArray(entries) || entries.length > 512) throw new Error('Invalid file cache index.');
      let total = 0;
      for (const row of entries) {
        if (!Array.isArray(row) || typeof row[0] !== 'string' || !row[1] || typeof row[1] !== 'object') continue;
        const entry = row[1] as Meta;
        if (!/^[a-f0-9]{64}\.(pdf|png|jpg|gif|webp|svg|txt|bin)$/.test(entry.name) ||
          !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > OBJECT_LIMIT || !Number.isSafeInteger(entry.used)) continue;
        total += entry.size;
        if (total > DISK_LIMIT) throw new Error('File cache disk budget exceeded.');
        this.index.set(row[0], entry); this.sequence = Math.max(this.sequence, entry.used);
      }
    } catch {
      // Owned cache only. A malformed or interrupted index never restores bytes.
      this.index.clear();
      await deleteAsync(this.directory, { idempotent: true });
      await makeDirectoryAsync(this.directory, { intermediates: true });
    }
    const held = new Set([...this.index.values()].map(entry => entry.name));
    for (const name of await readDirectoryAsync(this.directory)) {
      if (name === 'index.json' || held.has(name)) continue;
      // Crash leftovers in this owned cache never escape the disk budget.
      await deleteAsync(`${this.directory}${name}`, { idempotent: true });
    }
    for (const [key, entry] of this.index) {
      const info = await getInfoAsync(`${this.directory}${entry.name}`);
      if (info.exists && !info.isDirectory && 'size' in info && info.size === entry.size && info.size <= OBJECT_LIMIT) continue;
      this.index.delete(key);
      await deleteAsync(`${this.directory}${entry.name}`, { idempotent: true });
    }
    this.initialized = true;
    await this.saveIndex();
  }
  private async saveIndex(): Promise<void> {
    let encoded = JSON.stringify([...this.index]);
    while (utf8ToBytes(encoded).byteLength > 1024 * 1024) {
      const [key, value] = [...this.index].sort((a, b) => a[1].used - b[1].used)[0]!;
      this.index.delete(key);
      await deleteAsync(`${this.directory}${value.name}`, { idempotent: true });
      encoded = JSON.stringify([...this.index]);
    }
    const temp = `${this.directory}index.next`;
    await writeAsStringAsync(temp, encoded, { encoding: EncodingType.UTF8 });
    await moveAsync({ from: temp, to: `${this.directory}index.json` });
  }
  get(key: string): Promise<Uint8Array | null> { return this.run(async () => {
    await this.initialize(); const meta = this.index.get(key); if (!meta) return null;
    try {
      const info = await getInfoAsync(`${this.directory}${meta.name}`);
      if (!info.exists || info.isDirectory || !('size' in info) || info.size !== meta.size || info.size > OBJECT_LIMIT)
        throw new Error('Invalid cached object size.');
      const encoded = await readAsStringAsync(`${this.directory}${meta.name}`, { encoding: EncodingType.Base64 });
      if (encoded.length > Math.ceil(OBJECT_LIMIT / 3) * 4) throw new Error('File cache object exceeds budget.');
      const bytes = base64ToBytes(encoded);
      if (bytes.byteLength !== meta.size) throw new Error('Incomplete cached object.');
      meta.used = ++this.sequence; await this.saveIndex(); return bytes;
    } catch {
      this.index.delete(key);
      await deleteAsync(`${this.directory}${meta.name}`, { idempotent: true });
      await this.saveIndex(); return null;
    }
  }); }
  set(key: string, bytes: Uint8Array): Promise<void> { return this.run(async () => {
    if (bytes.byteLength > OBJECT_LIMIT) throw new Error('File cache object exceeds budget.');
    await this.initialize();
    const previous = this.index.get(key);
    this.index.delete(key);
    // Remove a superseded file before staging its replacement. Otherwise its
    // old bytes plus the atomic temporary file could exceed the disk ceiling.
    if (previous) await deleteAsync(`${this.directory}${previous.name}`, { idempotent: true });
    let total = [...this.index.values()].reduce((sum, value) => sum + value.size, 0);
    for (const [oldKey, value] of [...this.index].sort((a, b) => a[1].used - b[1].used)) {
      if (total + bytes.byteLength <= DISK_LIMIT && this.index.size < 512) break;
      this.index.delete(oldKey); total -= value.size;
      await deleteAsync(`${this.directory}${value.name}`, { idempotent: true });
    }
    const requested = this.details(key).format;
    const format = /^(pdf|png|jpg|gif|webp|svg|txt)$/.test(requested) ? requested : 'bin';
    const name = `${bytesToHex(sha256(utf8ToBytes(key)))}.${format}`;
    const temp = `${this.directory}${name}.next`;
    await writeAsStringAsync(temp, bytesToBase64(bytes), { encoding: EncodingType.Base64 });
    await moveAsync({ from: temp, to: `${this.directory}${name}` });
    this.index.set(key, { name, size: bytes.byteLength, used: ++this.sequence, authority: this.details(key).authority });
    await this.saveIndex();
  }); }
  remove(key: string): Promise<void> { return this.run(async () => {
    await this.initialize(); const value = this.index.get(key); this.index.delete(key);
    if (value) await deleteAsync(`${this.directory}${value.name}`, { idempotent: true });
    await this.saveIndex();
  }); }
  clear(): Promise<void> { return this.run(async () => {
    this.index.clear(); this.initialized = false;
    if (this.directory) await deleteAsync(this.directory, { idempotent: true });
  }); }
  revoke(scope: string, epoch: string): Promise<readonly string[]> { return this.run(async () => {
    await this.initialize(); const removed: string[] = [];
    for (const [key, entry] of this.index) if (removedBy(entry.authority, scope, epoch)) {
      removed.push(key); this.index.delete(key); await deleteAsync(`${this.directory}${entry.name}`, { idempotent: true });
    }
    await this.saveIndex(); return removed;
  }); }
  localUri(key: string): Promise<string | null> { return this.run(async () => {
    await this.initialize(); const value = this.index.get(key); if (!value) return null;
    const uri = `${this.directory}${value.name}`; return (await getInfoAsync(uri)).exists ? uri : null;
  }); }
}

type WebRow = { key: string; bytes: ArrayBuffer; size: number; used: number; authority?: RouterAuthorityCertificate };
class WebArtifactByteStore implements ArtifactByteStore {
  constructor(private readonly details: (key: string) => Details) {}
  private database?: Promise<IDBDatabase>;
  private open(): Promise<IDBDatabase> {
    return this.database ??= new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('File cache is unavailable.')); return; }
      const request = indexedDB.open('beeline-immutable-bytes-v1', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('objects', { keyPath: 'key' });
        request.result.createObjectStore('metadata', { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  }
  async get(key: string): Promise<Uint8Array | null> {
    const db = await this.open(); return new Promise((resolve, reject) => {
      const transaction = db.transaction(['objects', 'metadata'], 'readwrite');
      const request = transaction.objectStore('objects').get(key); let bytes: Uint8Array | null = null;
      request.onsuccess = () => {
        const row = request.result as WebRow | undefined;
        if (row && row.size <= OBJECT_LIMIT && row.bytes.byteLength === row.size) {
          bytes = new Uint8Array(row.bytes); transaction.objectStore('metadata').put({ key, size: row.size, used: Date.now(), authority: row.authority });
        }
      };
      transaction.oncomplete = () => resolve(bytes); transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
  async set(key: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength > OBJECT_LIMIT) throw new Error('File cache object exceeds budget.');
    const db = await this.open(); return new Promise((resolve, reject) => {
      const transaction = db.transaction(['objects', 'metadata'], 'readwrite');
      const metadata = transaction.objectStore('metadata');
      const used = Date.now();
      transaction.objectStore('objects').put({ key, bytes: bytes.slice().buffer, size: bytes.byteLength, used, authority: this.details(key).authority });
      metadata.put({ key, size: bytes.byteLength, used, authority: this.details(key).authority });
      const request = metadata.getAll();
      request.onsuccess = () => {
        const rows = request.result as Omit<WebRow, 'bytes'>[];
        let total = rows.reduce((sum, row) => sum + row.size, 0); let count = rows.length;
        for (const row of rows.sort((a, b) => a.used - b.used)) {
          if (total <= DISK_LIMIT && count <= 512) break;
          if (row.key === key) continue;
          total -= row.size; count--; metadata.delete(row.key); transaction.objectStore('objects').delete(row.key);
        }
      };
      transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
  async remove(key: string): Promise<void> {
    const db = await this.open(); return new Promise((resolve, reject) => {
      const transaction = db.transaction(['objects', 'metadata'], 'readwrite');
      transaction.objectStore('objects').delete(key); transaction.objectStore('metadata').delete(key);
      transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
    });
  }
  async clear(): Promise<void> {
    const db = await this.open(); return new Promise((resolve, reject) => {
      const transaction = db.transaction(['objects', 'metadata'], 'readwrite');
      transaction.objectStore('objects').clear(); transaction.objectStore('metadata').clear();
      transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
    });
  }
  async revoke(scope: string, epoch: string): Promise<readonly string[]> {
    const db = await this.open(); return new Promise((resolve, reject) => {
      const transaction = db.transaction(['objects', 'metadata'], 'readwrite');
      const metadata = transaction.objectStore('metadata'); const request = metadata.getAll(); const removed: string[] = [];
      request.onsuccess = () => { for (const row of request.result as WebRow[]) if (removedBy(row.authority, scope, epoch)) {
        removed.push(row.key); metadata.delete(row.key); transaction.objectStore('objects').delete(row.key);
      } };
      transaction.oncomplete = () => resolve(removed); transaction.onerror = () => reject(transaction.error);
    });
  }
  async localUri(): Promise<null> { return null; }
}
export function createArtifactByteStore(details: (key: string) => Details = () => ({ format: 'bin' })): ArtifactByteStore {
  return Platform.OS === 'web' ? new WebArtifactByteStore(details) : new NativeArtifactByteStore(details);
}
