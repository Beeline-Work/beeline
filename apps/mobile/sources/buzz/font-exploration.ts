/**
 * THROWAWAY TYPE EXPLORATION — not a shipping feature.
 *
 * Bundles several candidate type directions so the captain can feel each one in
 * the real UI on-device (room + corner) and pick a winner. The follow-up change
 * keeps ONLY the winning direction and deletes this module, the toggle screen,
 * and the losing font assets.
 *
 * Mechanics: every candidate family is loaded at startup (see `_layout.tsx`).
 * `constants/Typography.ts` resolves the ACTIVE direction once, at module load,
 * because every Buzz screen bakes `...Typography.default()` into a module-level
 * `StyleSheet.create` object — the family strings are copied by the spread, so
 * they cannot be reassigned after the fact. The toggle therefore persists the
 * choice synchronously and reloads the JS bundle; that is a reload, not a
 * rebuild, and takes about a second on-device.
 */

export type FontDirectionId = 'plex' | 'plex-mono' | 'commit' | 'jetbrains' | 'geist';

export interface FontFamilyTriple {
  regular: string;
  italic: string;
  semiBold: string;
}

export interface FontDirection {
  id: FontDirectionId;
  /** Short name shown in the toggle and in screenshots. */
  name: string;
  /** One line on what the direction is trying to be. */
  blurb: string;
  /** Families + licenses, for the PR write-up and the toggle screen footer. */
  licenses: string;
  /** Body / prose family — `Typography.default()`. */
  body: FontFamilyTriple;
  /** Machine-identifier family — `Typography.mono()`. */
  mono: FontFamilyTriple;
}

const PLEX_SANS: FontFamilyTriple = {
  regular: 'IBMPlexSans-Regular',
  italic: 'IBMPlexSans-Italic',
  semiBold: 'IBMPlexSans-SemiBold',
};

const PLEX_MONO: FontFamilyTriple = {
  regular: 'IBMPlexMono-Regular',
  italic: 'IBMPlexMono-Italic',
  semiBold: 'IBMPlexMono-SemiBold',
};

const COMMIT_MONO: FontFamilyTriple = {
  regular: 'CommitMono-Regular',
  italic: 'CommitMono-Italic',
  // Commit Mono ships 400 and 700 only; 700 stands in for the semiBold slot.
  semiBold: 'CommitMono-Bold',
};

const JETBRAINS_MONO: FontFamilyTriple = {
  regular: 'JetBrainsMono-Regular',
  italic: 'JetBrainsMono-Italic',
  semiBold: 'JetBrainsMono-SemiBold',
};

const GEIST: FontFamilyTriple = {
  regular: 'Geist-Regular',
  italic: 'Geist-Italic',
  semiBold: 'Geist-SemiBold',
};

export const FONT_DIRECTIONS: readonly FontDirection[] = [
  {
    id: 'plex',
    name: 'Plex Baseline',
    blurb: 'IBM Plex Sans prose, IBM Plex Mono machine labels — what ships today.',
    licenses: 'IBM Plex Sans + IBM Plex Mono — SIL OFL 1.1',
    body: PLEX_SANS,
    mono: PLEX_MONO,
  },
  {
    id: 'plex-mono',
    name: 'Plex Terminal Ledger',
    blurb: 'IBM Plex Mono everywhere — full terminal hull, prose included.',
    licenses: 'IBM Plex Mono — SIL OFL 1.1',
    body: PLEX_MONO,
    mono: PLEX_MONO,
  },
  {
    id: 'commit',
    name: 'Commit Ledger',
    blurb: 'Commit Mono everywhere — a warmer, less technical mono that reads calm.',
    licenses: 'Commit Mono 1.143 — SIL OFL 1.1',
    body: COMMIT_MONO,
    mono: COMMIT_MONO,
  },
  {
    id: 'jetbrains',
    name: 'JetBrains Ledger',
    blurb: 'JetBrains Mono everywhere — crisp, tall x-height coding mono.',
    licenses: 'JetBrains Mono 2.304 — SIL OFL 1.1',
    body: JETBRAINS_MONO,
    mono: JETBRAINS_MONO,
  },
  {
    id: 'geist',
    name: 'Geist + JetBrains',
    blurb: 'Geist prose, JetBrains Mono machine values — the Trusty Squire web pairing.',
    licenses: 'Geist 1.7.2 — SIL OFL 1.1 · JetBrains Mono 2.304 — SIL OFL 1.1',
    body: GEIST,
    mono: JETBRAINS_MONO,
  },
];

export const DEFAULT_FONT_DIRECTION_ID: FontDirectionId = 'plex';

export function fontDirection(id: FontDirectionId): FontDirection {
  return FONT_DIRECTIONS.find((direction) => direction.id === id) ?? FONT_DIRECTIONS[0];
}

function isFontDirectionId(value: unknown): value is FontDirectionId {
  return FONT_DIRECTIONS.some((direction) => direction.id === value);
}

const STORAGE_ID = 'buzz-font-exploration';
const STORAGE_KEY = 'active-direction';

type SyncStore = { getString(key: string): string | undefined; set(key: string, value: string): void };

let cachedStore: SyncStore | null | undefined;

/**
 * MMKV is synchronous, which is the whole point — the active direction has to be
 * readable while `Typography.ts` is still being imported. It is loaded through a
 * guarded `require` so unit tests (plain node, no native modules) fall back to
 * the default direction instead of failing to import the typography system.
 */
function store(): SyncStore | null {
  if (cachedStore === undefined) {
    try {
      const { MMKV } = require('react-native-mmkv');
      cachedStore = new MMKV({ id: STORAGE_ID }) as SyncStore;
    } catch {
      cachedStore = null;
    }
  }
  return cachedStore;
}

export function readActiveFontDirectionId(): FontDirectionId {
  const stored = store()?.getString(STORAGE_KEY);
  return isFontDirectionId(stored) ? stored : DEFAULT_FONT_DIRECTION_ID;
}

export function writeActiveFontDirectionId(id: FontDirectionId): void {
  store()?.set(STORAGE_KEY, id);
}
