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

/** Preserve a valid authored first name; legacy compound names fall back deterministically. */
export function resolveAgentName(value: string | undefined, pubkey: string): string {
  const authored = value?.trim();
  return authored && isSingleWordAgentName(authored) ? authored : fallbackAgentName(pubkey);
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
