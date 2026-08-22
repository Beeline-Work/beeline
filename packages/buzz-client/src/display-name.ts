/** Stable spoken names for agent identities. Presentation only; never authority. */
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
  return FIRST_NAMES[stableHash(pubkey.toLowerCase()) % FIRST_NAMES.length]!;
}

/** Human identities use the same stable, friendly first-name pool as Agents. */
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

/**
 * Generic identity names the system itself mints (`newIdentity('buzzy-agent')`,
 * the daemon's `|| 'Agent'` guard). They are placeholders, never operator
 * choices: publishing them verbatim or masking them with a pubkey-derived
 * first name both misrepresent the agent. See `deriveAgentDisplayName`.
 */
const SYSTEM_AGENT_NAMES = new Set(['agent', 'buzzy-agent']);

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
 * compound an operator actually chose ("Quiet Keeper", "ox-prime"). Only a
 * system-generic marker or a genuinely unusable value falls back to the
 * deterministic pubkey-derived first name.
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
 * Writer-side display name for a freshly registered agent identity.
 *
 * The daemon mints its identities as `buzzy-agent`; registering that verbatim
 * used to fail the old single-word rule and be silently replaced by a
 * random-looking first name from the fallback pool ("Pia"), with nothing on
 * any surface signalling it was generated. This resolves the base name
 * deliberately instead:
 * - an authored, reasonable name passes through untouched;
 * - the generic `buzzy-agent` marker becomes "Buzzy" — stable, traceable to
 *   the actual base name, and clearly not a human first name;
 * - no name at all (or the bare "Agent" guard) falls back explicitly to the
 *   deterministic pool, which then is the intended choice rather than masking.
 */
export function deriveAgentDisplayName(value: string | undefined | null, pubkey: string): string {
  const authored = value?.trim();
  if (!authored) return fallbackAgentName(pubkey);
  const lower = authored.toLowerCase();
  if (lower === 'buzzy-agent') return 'Buzzy';
  return resolveAgentName(authored, pubkey);
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
