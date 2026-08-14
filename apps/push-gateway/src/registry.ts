import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const PUBKEY_RE = /^[0-9a-f]{64}$/;
const TOKEN_RE = /^[A-Za-z0-9:_-]{20,4096}$/;

interface RegistryFile {
  version: 1;
  registrations: Array<{ pubkey: string; tokens: string[] }>;
}

export class TokenRegistry {
  private readonly byPubkey = new Map<string, Set<string>>();

  private constructor(private readonly filePath?: string) {}

  static async load(filePath?: string): Promise<TokenRegistry> {
    const registry = new TokenRegistry(filePath);
    if (!filePath) return registry;

    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as RegistryFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.registrations)) {
        throw new Error('unsupported registry format');
      }
      for (const entry of parsed.registrations) {
        if (!TokenRegistry.validPubkey(entry.pubkey) || !Array.isArray(entry.tokens)) continue;
        for (const token of entry.tokens) {
          if (TokenRegistry.validToken(token)) registry.registerInMemory(entry.pubkey, token);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return registry;
  }

  static validPubkey(pubkey: string): boolean {
    return PUBKEY_RE.test(pubkey);
  }

  static validToken(token: string): boolean {
    return TOKEN_RE.test(token);
  }

  get pubkeyCount(): number {
    return this.byPubkey.size;
  }

  get tokenCount(): number {
    let count = 0;
    for (const tokens of this.byPubkey.values()) count += tokens.size;
    return count;
  }

  pubkeys(): string[] {
    return [...this.byPubkey.keys()];
  }

  tokensForPubkeys(pubkeys: Iterable<string>): string[] {
    const tokens = new Set<string>();
    for (const pubkey of pubkeys) {
      for (const token of this.byPubkey.get(pubkey) ?? []) tokens.add(token);
    }
    return [...tokens];
  }

  async register(pubkey: string, token: string): Promise<void> {
    if (!TokenRegistry.validPubkey(pubkey)) throw new Error('invalid pubkey');
    if (!TokenRegistry.validToken(token)) throw new Error('invalid FCM token');
    this.registerInMemory(pubkey, token);
    await this.persist();
  }

  async removeTokens(tokensToRemove: Iterable<string>): Promise<void> {
    const removals = new Set(tokensToRemove);
    let changed = false;
    for (const [pubkey, tokens] of this.byPubkey) {
      for (const token of removals) changed = tokens.delete(token) || changed;
      if (tokens.size === 0) this.byPubkey.delete(pubkey);
    }
    if (changed) await this.persist();
  }

  async unregister(pubkey: string, token: string): Promise<void> {
    if (!TokenRegistry.validPubkey(pubkey)) throw new Error('invalid pubkey');
    if (!TokenRegistry.validToken(token)) throw new Error('invalid FCM token');
    const tokens = this.byPubkey.get(pubkey);
    if (!tokens?.delete(token)) return;
    if (tokens.size === 0) this.byPubkey.delete(pubkey);
    await this.persist();
  }

  private registerInMemory(pubkey: string, token: string): void {
    // An FCM installation belongs to exactly one signed-in identity. Rebinding
    // removes the old identity so logout/key switches cannot receive stale pushes.
    for (const [existingPubkey, tokens] of this.byPubkey) {
      if (existingPubkey === pubkey) continue;
      tokens.delete(token);
      if (tokens.size === 0) this.byPubkey.delete(existingPubkey);
    }
    const tokens = this.byPubkey.get(pubkey) ?? new Set<string>();
    tokens.add(token);
    this.byPubkey.set(pubkey, tokens);
  }

  private async persist(): Promise<void> {
    if (!this.filePath) return;
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const value: RegistryFile = {
      version: 1,
      registrations: [...this.byPubkey].map(([pubkey, tokens]) => ({
        pubkey,
        tokens: [...tokens],
      })),
    };
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, this.filePath);
  }
}
