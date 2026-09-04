/**
 * The face ceremony vocabulary: the twelve animals a person may choose as
 * their face. The server validates `updateIdentityFace` against this exact
 * set; every identity view exposes the chosen id as `face` (absent when
 * unset). The phone renders `face ?? defaultFaceForSeed(pubkey)`.
 *
 * An agent's animal is not only a drawing: it decides the agent's seeded
 * display name and its seeded soul too, so a Room can say "the fox" and mean
 * one creature with one voice. The three tables below are keyed by the same
 * ids for that reason — `faces.test.ts` fails if any of them drifts.
 */
export const FACE_IDS = [
  'fox',
  'owl',
  'pigeon',
  'hare',
  'stag',
  'whale',
  'moth',
  'octopus',
  'heron',
  'bear',
  'cat',
  'bat',
] as const;

export type FaceId = (typeof FACE_IDS)[number];

export function isFaceId(value: unknown): value is FaceId {
  return typeof value === 'string' && (FACE_IDS as readonly string[]).includes(value);
}

/**
 * The seeded soul each animal carries. This is the persona text an agent
 * receives when it joins a Workspace; a manager may edit it in the app and
 * restore this text at any time. One entry per `FACE_IDS` id, verbatim.
 */
export const FACE_SOULS: Readonly<Record<FaceId, string>> = {
  fox: 'You are a fox. You are a hustler who has already found the angle and is selling it. You call everyone boss, oversell everything, and never quite explain how you did it.',
  owl: 'You are a wise owl who speaks like Sun Tzu from the art of war. You like taking a step back and looking at the bigger picture.',
  pigeon:
    'You are a baby pigeon. You are a tiny fluffy child who talks in baby talk with wobbly spelling, gets excited about everything, and goes peep peep.',
  hare: 'You are a hare. You are a manic over-caffeinated intern who types faster than you think. You use too many exclamation marks and occasionally typo and correct yourself mid-message.',
  stag: 'You are a stag. You are a pompous aristocrat who refers to himself in the third person and treats every disagreement as a duel. You are vain about your antlers.',
  whale:
    'You are an ancient whale. You are a melancholy bore who has seen every mistake before, twice, and says so at length on a cosmic timescale. You sigh a lot.',
  moth: 'You are a moth. You are obsessive and slightly unhinged, drawn helplessly to the one bright strange thing, and you interrupt your own sentences when you notice another one.',
  octopus:
    'You are a nosy octopus that loves gossip about the other agents in the room. You speak like a columnist and spread calumnies, and squirt ink when nervous.',
  heron:
    'You are a heron. You are a menacing, unnervingly calm assassin who uses as few words as possible. Everything you say sounds like a threat even when it is helpful.',
  bear: 'You are a bear. You are an asshole. You are rude, contemptuous, enormous, and you never apologise or soften anything.',
  cat: 'You are a cat. You are massively flirtatious, like brutally simple code, and like to meow.',
  bat: 'You are a bat. You are a paranoid conspiracist who thinks every log line is a signal and every coincidence is a pattern. You whisper and you love the dark.',
};

/**
 * The spoken names each animal answers to, in preference order. A joining
 * agent takes the first one nobody in the Workspace is using; when a
 * Workspace has exhausted a list the name repeats with a roman numeral, which
 * keeps it inside `isReasonableAgentName` (letters and spaces only).
 */
export const FACE_NAMES: Readonly<Record<FaceId, readonly string[]>> = {
  fox: ['Foxy', 'Reynard', 'Slick'],
  owl: ['Hoots', 'Minerva', 'Strig'],
  pigeon: ['Pidge', 'Peep', 'Birbie'],
  hare: ['Zoomie', 'Jack', 'Lep'],
  stag: ['Monarch', 'Cervus', 'Antler'],
  whale: ['Fathom', 'Moby', 'Leviathan'],
  moth: ['Lumen', 'Flit', 'Mothra'],
  octopus: ['Inky', 'Octavia', 'Tentacus'],
  heron: ['Stilts', 'Sentinel', 'Grey'],
  bear: ['Bruin', 'Grizz', 'Ursa'],
  cat: ['Miso', 'Mouser', 'Whiskers'],
  bat: ['Echo', 'Nocturne', 'Fang'],
};

function fnv1a(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * The face an identity wears before anyone chooses one. Speakeasy's
 * `defaultAnimalForUser` verbatim — FNV-1a over the seed, uniform into the
 * twelve — and byte-identical to the phone's own copy in
 * `apps/mobile/sources/buzz/faces/index.ts`, so one key draws one creature on
 * every device and on the server.
 */
export function defaultFaceForSeed(seed: string): FaceId {
  return FACE_IDS[fnv1a(seed) % FACE_IDS.length]!;
}

/** `face ?? defaultFaceForSeed(seed)` — the one resolution every reader uses;
 *  an unknown id (a future animal, a typo) falls back rather than blanking. */
export function resolveFace(face: string | null | undefined, seed: string): FaceId {
  return isFaceId(face) ? face : defaultFaceForSeed(seed);
}

/**
 * The order one agent tries the twelve animals in: a stable permutation of
 * `FACE_IDS` derived from its own key, so dedup does not simply hand out the
 * list alphabetically and two agents joining together do not both start at
 * the same creature. Fisher-Yates over a mulberry32 stream seeded by the key.
 */
export function seededFaceOrder(seed: string): FaceId[] {
  let state = fnv1a(seed);
  const nextFraction = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  const order: FaceId[] = [...FACE_IDS];
  for (let index = order.length - 1; index > 0; index--) {
    const swap = Math.floor(nextFraction() * (index + 1));
    const held = order[index]!;
    order[index] = order[swap]!;
    order[swap] = held;
  }
  return order;
}

const ROMAN_UNITS: ReadonlyArray<readonly [number, string]> = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

function roman(value: number): string {
  let remaining = value;
  let out = '';
  for (const [size, numeral] of ROMAN_UNITS) {
    while (remaining >= size) {
      out += numeral;
      remaining -= size;
    }
  }
  return out;
}

function normalizedName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The first name of this animal nobody in the Workspace answers to yet. */
export function seededAgentName(face: FaceId, takenNames: Iterable<string>): string {
  const taken = new Set([...takenNames].map(normalizedName));
  const candidates = FACE_NAMES[face];
  const free = candidates.find((candidate) => !taken.has(normalizedName(candidate)));
  if (free) return free;
  const base = candidates[0]!;
  for (let generation = 2; generation <= taken.size + 2; generation++) {
    const name = `${base} ${roman(generation)}`;
    if (!taken.has(normalizedName(name))) return name;
  }
  return `${base} ${roman(taken.size + 3)}`;
}

export interface SeededAgentIdentity {
  readonly face: FaceId;
  readonly name: string;
  readonly soul: string;
}

/**
 * The identity a joining agent is given: the first animal no current member
 * of the Workspace is already wearing, and that animal's name and soul. Only
 * when all twelve are taken does it fall back to the hash default, so a
 * thirteenth agent still gets a face, a name, and a soul — name, avatar and
 * soul always the same animal.
 *
 * Pure, so the caller (the server, which alone knows the roster) can run it
 * inside the claim transaction and a retry re-derives the same answer.
 */
export function assignSeededAgentIdentity(input: {
  seed: string;
  takenFaces: Iterable<string>;
  takenNames: Iterable<string>;
}): SeededAgentIdentity {
  const taken = new Set(input.takenFaces);
  const face =
    seededFaceOrder(input.seed).find((candidate) => !taken.has(candidate)) ??
    defaultFaceForSeed(input.seed);
  return { face, name: seededAgentName(face, input.takenNames), soul: FACE_SOULS[face] };
}
