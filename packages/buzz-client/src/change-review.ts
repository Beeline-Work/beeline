/** Signed change-review metadata published into an agent change channel. */
export const CHANGE_REVIEW_EVENT_KIND = 30078;
export const CHANGE_REVIEW_MANIFEST_TAG = 'change-review-manifest';
export const CHANGE_REVIEW_FILE_TAG = 'change-review-file';
export const CHANGE_REVIEW_COMPLETE_TAG = 'change-review-complete';
/** Marks manifests whose transaction boundary is CHANGE_REVIEW_COMPLETE_TAG. */
export const CHANGE_REVIEW_GENERATION_TAG = 'transactional-v1';
export const CHANGE_REVIEW_VERSION = 1 as const;

export type ChangeReviewStatus =
  'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-changed' | 'unmerged';

export interface ChangeReviewFile {
  path: string;
  previousPath?: string;
  status: ChangeReviewStatus;
  linesAdded?: number;
  linesRemoved?: number;
  isBinary?: boolean;
  /** UTF-8 byte size of the generated patch when Body measured it. */
  patchBytes?: number;
  /** Why no per-file patch events exist for this manifest entry. */
  renderUnavailableReason?: 'too-large';
}

export interface ChangeReviewManifest {
  version: typeof CHANGE_REVIEW_VERSION;
  base: string;
  tip: string;
  files: ChangeReviewFile[];
}

/** Published last, after every file chunk and manifest shard is accepted. */
export interface ChangeReviewGenerationComplete {
  version: typeof CHANGE_REVIEW_VERSION;
  base: string;
  tip: string;
  patchId: string;
  summary: string;
  manifestChunks: number;
  fileCount: number;
}

const CHANGE_REVIEW_STATUSES = new Set<ChangeReviewStatus>([
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'type-changed',
  'unmerged',
]);

/** Parse untrusted relay content and reject malformed review manifests. */
export function parseChangeReviewManifest(content: string): ChangeReviewManifest | null {
  try {
    const value = JSON.parse(content) as Partial<ChangeReviewManifest>;
    if (
      value.version !== CHANGE_REVIEW_VERSION ||
      typeof value.base !== 'string' ||
      !/^[0-9a-f]{40}$/.test(value.base) ||
      typeof value.tip !== 'string' ||
      !/^[0-9a-f]{40}$/.test(value.tip) ||
      !Array.isArray(value.files)
    ) {
      return null;
    }
    const files: ChangeReviewFile[] = [];
    for (const file of value.files) {
      if (
        !file ||
        typeof file.path !== 'string' ||
        !file.path ||
        typeof file.status !== 'string' ||
        !CHANGE_REVIEW_STATUSES.has(file.status as ChangeReviewStatus) ||
        (file.patchBytes !== undefined &&
          (!Number.isSafeInteger(file.patchBytes) || file.patchBytes < 0)) ||
        (file.renderUnavailableReason !== undefined && file.renderUnavailableReason !== 'too-large')
      ) {
        return null;
      }
      files.push(file as ChangeReviewFile);
    }
    return { version: CHANGE_REVIEW_VERSION, base: value.base, tip: value.tip, files };
  } catch {
    return null;
  }
}

/** Parse the transaction boundary for one complete review generation. */
export function parseChangeReviewGenerationComplete(
  content: string,
): ChangeReviewGenerationComplete | null {
  try {
    const value = JSON.parse(content) as Partial<ChangeReviewGenerationComplete>;
    if (
      value.version !== CHANGE_REVIEW_VERSION ||
      typeof value.base !== 'string' ||
      !/^[0-9a-f]{40}$/.test(value.base) ||
      typeof value.tip !== 'string' ||
      !/^[0-9a-f]{40}$/.test(value.tip) ||
      typeof value.patchId !== 'string' ||
      !/^[0-9a-f]{40}$/.test(value.patchId) ||
      typeof value.summary !== 'string' ||
      !value.summary.trim() ||
      !Number.isSafeInteger(value.manifestChunks) ||
      value.manifestChunks! < 1 ||
      !Number.isSafeInteger(value.fileCount) ||
      value.fileCount! < 1
    ) {
      return null;
    }
    return {
      version: CHANGE_REVIEW_VERSION,
      base: value.base,
      tip: value.tip,
      patchId: value.patchId,
      summary: value.summary.trim(),
      manifestChunks: value.manifestChunks,
      fileCount: value.fileCount,
    } as ChangeReviewGenerationComplete;
  } catch {
    return null;
  }
}
