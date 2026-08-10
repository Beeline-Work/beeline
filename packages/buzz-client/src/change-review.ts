/** Signed change-review metadata published into an agent change channel. */
export const CHANGE_REVIEW_EVENT_KIND = 30078;
export const CHANGE_REVIEW_MANIFEST_TAG = 'change-review-manifest';
export const CHANGE_REVIEW_FILE_TAG = 'change-review-file';
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
}

export interface ChangeReviewManifest {
  version: typeof CHANGE_REVIEW_VERSION;
  base: string;
  tip: string;
  files: ChangeReviewFile[];
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
        !CHANGE_REVIEW_STATUSES.has(file.status as ChangeReviewStatus)
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
