import { MMKV } from 'react-native-mmkv';
import type { ChangedFile } from '@/sync/transport';

const INDEX_KEY = 'change-review-index-v1';
const RECORD_PREFIX = 'change-review-v1:';
const MAX_GENERATIONS = 60;

const storage = new MMKV({ id: 'buzz-change-reviews' });

export type CachedReviewPatch = { content: string; isBinary?: boolean };

export type CachedReviewGeneration = {
  sessionId: string;
  tip: string;
  files: ChangedFile[];
  patches: Record<string, CachedReviewPatch>;
  completedAt: number;
};

type ReviewIndexEntry = Pick<CachedReviewGeneration, 'sessionId' | 'tip' | 'completedAt'>;

function recordKey(sessionId: string, tip: string): string {
  return `${RECORD_PREFIX}${sessionId}:${tip}`;
}

function parseRecord(raw: string | undefined): CachedReviewGeneration | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<CachedReviewGeneration>;
    if (
      typeof value.sessionId !== 'string' ||
      typeof value.tip !== 'string' ||
      !Array.isArray(value.files) ||
      !value.patches ||
      typeof value.patches !== 'object' ||
      typeof value.completedAt !== 'number'
    ) {
      return undefined;
    }
    return value as CachedReviewGeneration;
  } catch {
    return undefined;
  }
}

function readIndex(): ReviewIndexEntry[] {
  try {
    const parsed = JSON.parse(storage.getString(INDEX_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is ReviewIndexEntry =>
        Boolean(entry) &&
        typeof entry.sessionId === 'string' &&
        typeof entry.tip === 'string' &&
        typeof entry.completedAt === 'number',
    );
  } catch {
    return [];
  }
}

export function readCachedReviewGeneration(
  sessionId: string,
  tip: string,
): CachedReviewGeneration | undefined {
  return parseRecord(storage.getString(recordKey(sessionId, tip)));
}

export function readLatestCachedReviewGeneration(
  sessionId: string,
  excludingTip?: string,
): CachedReviewGeneration | undefined {
  const candidate = readIndex()
    .filter((entry) => entry.sessionId === sessionId && entry.tip !== excludingTip)
    .sort((a, b) => b.completedAt - a.completedAt)[0];
  return candidate ? readCachedReviewGeneration(candidate.sessionId, candidate.tip) : undefined;
}

/** A manifest is cached only after the transport proved its generation complete. */
export function cacheCompleteReviewManifest(
  sessionId: string,
  tip: string,
  files: ChangedFile[],
): CachedReviewGeneration {
  const existing = readCachedReviewGeneration(sessionId, tip);
  const filePaths = new Set(files.map((file) => file.path));
  const patches = Object.fromEntries(
    Object.entries(existing?.patches ?? {}).filter(([path]) => filePaths.has(path)),
  );
  const generation: CachedReviewGeneration = {
    sessionId,
    tip,
    files,
    patches,
    completedAt: Date.now(),
  };
  storage.set(recordKey(sessionId, tip), JSON.stringify(generation));

  const nextIndex = [
    { sessionId, tip, completedAt: generation.completedAt },
    ...readIndex().filter((entry) => entry.sessionId !== sessionId || entry.tip !== tip),
  ].sort((a, b) => b.completedAt - a.completedAt);
  for (const expired of nextIndex.slice(MAX_GENERATIONS)) {
    storage.delete(recordKey(expired.sessionId, expired.tip));
  }
  storage.set(INDEX_KEY, JSON.stringify(nextIndex.slice(0, MAX_GENERATIONS)));
  return generation;
}

export function cacheReviewPatch(
  sessionId: string,
  tip: string,
  path: string,
  patch: CachedReviewPatch,
): void {
  const generation = readCachedReviewGeneration(sessionId, tip);
  if (!generation || !generation.files.some((file) => file.path === path)) return;
  storage.set(
    recordKey(sessionId, tip),
    JSON.stringify({
      ...generation,
      patches: { ...generation.patches, [path]: patch },
    } satisfies CachedReviewGeneration),
  );
}
