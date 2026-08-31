/** Stable friendly fallback names for human identities. Presentation only; never authority. */
const FIRST_NAMES = [
  'Ada',
  'Alden',
  'Alice',
  'Alma',
  'Amos',
  'Ansel',
  'Arlo',
  'Aster',
  'Bea',
  'Bram',
  'Cato',
  'Celia',
  'Charles',
  'Clara',
  'Cleo',
  'Cora',
  'Dara',
  'Della',
  'Eli',
  'Elio',
  'Elsa',
  'Emil',
  'Esme',
  'Ezra',
  'Felix',
  'Flora',
  'Freya',
  'Galen',
  'Gemma',
  'Greta',
  'Hana',
  'Hazel',
  'Hugo',
  'Ida',
  'Inez',
  'Iris',
  'Ivan',
  'Jasper',
  'Juno',
  'Kai',
  'Kit',
  'Lena',
  'Leo',
  'Lina',
  'Luca',
  'Mara',
  'Milo',
  'Mira',
  'Nico',
  'Nina',
  'Noa',
  'Nora',
  'Oren',
  'Orla',
  'Otis',
  'Pia',
  'Quinn',
  'Remy',
  'Rhea',
  'Romy',
  'Sage',
  'Silas',
  'Tess',
  'Theo',
  'Una',
  'Vera',
  'Willa',
  'Xanthe',
  'Yara',
  'Zane',
  'Zara',
  'Zora',
] as const;

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function fallbackAgentName(pubkey: string): string {
  const normalized = pubkey.trim().toLowerCase();
  const publicKeyPrefix = /^[0-9a-f]{8}/u.exec(normalized)?.[0];
  const syntheticId =
    publicKeyPrefix ?? stableHash(normalized).toString(16).padStart(8, '0').slice(0, 8);
  return `Agent ${syntheticId}`;
}

/** Human identities keep a stable, friendly first-name fallback. */
export function fallbackPersonName(pubkey: string): string {
  return FIRST_NAMES[stableHash(pubkey.toLowerCase()) % FIRST_NAMES.length]!;
}

export const PERSON_NAME_MAX_LENGTH = 60;
export const PERSON_HANDLE_MAX_LENGTH = 30;

/** Normalize authored human display names before publishing or showing them. */
export function normalizePersonName(value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (
    !normalized ||
    normalized.length > PERSON_NAME_MAX_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

/** Normalize the authored global handle shown with a leading @ in the UI. */
export function normalizePersonHandle(value: string): string | null {
  const normalized = value.trim().replace(/^@+/, '').toLowerCase();
  if (
    !normalized ||
    normalized.length > PERSON_HANDLE_MAX_LENGTH ||
    !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

export function isSingleWordAgentName(value: string): boolean {
  return /^\p{L}[\p{L}\p{M}'’]*$/u.test(value.trim());
}

export const AGENT_NAME_MAX_LENGTH = 32;

/** Neutral default identity name for a freshly minted agent (no soul set). */
export const DEFAULT_AGENT_IDENTITY_NAME = 'beeline-agent';

/** Neutral default identity name for the daemon's operator-side body key. */
export const DEFAULT_BODY_IDENTITY_NAME = 'beeline-body';

/**
 * Generic identity names the system itself mints (`newIdentity(
 * DEFAULT_AGENT_IDENTITY_NAME)`, the daemon's `|| 'Agent'` guard), including
 * the pre-Beeline-rebrand marker kept so identities paired before the rename
 * are still classified as system placeholders rather than authored names.
 * They are placeholders, never operator choices and never SHARED: each one
 * resolves to a visibly synthetic label derived from that agent's own pubkey
 * (`Agent 54f4d261`), so a resolver miss cannot masquerade as an authored
 * human name and a Workspace of soul-less agents still shows distinct identities.
 * A human-authored soul overlay overrides wherever one exists. See
 * `deriveAgentDisplayName`.
 */
const SYSTEM_AGENT_NAMES = new Set(['agent', 'beeline-agent', 'buzzy-agent']);

/**
 * A reasonable authored agent name: spoken words separated by spaces or
 * hyphens, with apostrophes, bounded in length. Deliberately wider than
 * `isSingleWordAgentName` so an operator-chosen compound name survives
 * registration and display instead of being swapped for a placeholder.
 */
export function isReasonableAgentName(value: string): boolean {
  const normalized = normalizeAuthoredAgentName(value);
  return (
    normalized.length > 0 &&
    normalized.length <= AGENT_NAME_MAX_LENGTH &&
    /^\p{L}[\p{L}\p{M}'’ -]*$/u.test(normalized)
  );

}

function normalizeAuthoredAgentName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * Preserve a reasonable authored agent name — one spoken word ("Ada") or a
 * compound an operator actually chose ("Quiet Keeper", "ox-prime"). A
 * system-generic marker or a genuinely unusable value falls back to the
 * deterministic, visibly synthetic pubkey label, which keeps every agent's
 * default identity DISTINCT.
 */
export function resolveAgentName(value: string | undefined, pubkey: string): string {
  const authored = value?.trim();
  if (
    authored &&
    !SYSTEM_AGENT_NAMES.has(authored.toLowerCase()) &&
    isReasonableAgentName(authored)
  ) {
    return normalizeAuthoredAgentName(authored);
  }
  return fallbackAgentName(pubkey);
}

/**
 * Display name for a freshly registered agent identity.
 *
 * - an authored, reasonable name passes through untouched;
 * - any system-generic marker (`beeline-agent`, the pre-rebrand
 *   `buzzy-agent`, the bare `"Agent"` guard) resolves to the stable,
 *   pubkey-derived synthetic label — distinct per agent, never one shared label;
 * - no name at all takes that same deterministic form.
 */
export function deriveAgentDisplayName(value: string | undefined | null, pubkey: string): string {
  return resolveAgentName(value ?? undefined, pubkey);
}

export function agentHandle(name: string, pubkey: string): string {
  const handle = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return handle || fallbackAgentName(pubkey).toLowerCase();
}

export function personHandle(name: string, pubkey: string): string {
  const handle = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return handle || fallbackPersonName(pubkey).toLowerCase();
}
