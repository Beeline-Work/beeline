import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** Signed change-review metadata published into an agent change channel. */
export const CHANGE_REVIEW_EVENT_KIND = 30078;
export const CHANGE_REVIEW_ARTIFACT_TAG = 'change-review-artifact';
export const CHANGE_REVIEW_MANIFEST_TAG = 'change-review-manifest';
export const CHANGE_REVIEW_FILE_TAG = 'change-review-file';
export const CHANGE_REVIEW_COMPLETE_TAG = 'change-review-complete';
/** Marks manifests whose transaction boundary is CHANGE_REVIEW_COMPLETE_TAG. */
export const CHANGE_REVIEW_GENERATION_TAG = 'transactional-v1';
export const CHANGE_REVIEW_VERSION = 1 as const;
export const CHANGE_REVIEW_ARTIFACT_VERSION = 2 as const;

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

export interface ChangeReviewArtifactFile extends ChangeReviewFile {
  /** The complete unified patch. Absent only when rendering is unavailable. */
  diff?: string;
}

/** The one content-addressed object containing a complete review. */
export interface ChangeReviewArtifact {
  version: typeof CHANGE_REVIEW_ARTIFACT_VERSION;
  base: string;
  tip: string;
  patchId: string;
  summary: string;
  files: ChangeReviewArtifactFile[];
}

/** The one relay fact that makes a content-addressed review ready. */
export interface ChangeReviewArtifactDescriptor {
  version: typeof CHANGE_REVIEW_ARTIFACT_VERSION;
  base: string;
  tip: string;
  patchId: string;
  summary: string;
  fileCount: number;
  url: string;
  sha256: string;
  size: number;
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

function parseChangeReviewFile(value: unknown): ChangeReviewFile | null {
  const file = value as Partial<ChangeReviewFile> | null;
  if (
    !file ||
    typeof file.path !== 'string' ||
    !file.path ||
    typeof file.status !== 'string' ||
    !CHANGE_REVIEW_STATUSES.has(file.status as ChangeReviewStatus) ||
    (file.previousPath !== undefined && typeof file.previousPath !== 'string') ||
    (file.linesAdded !== undefined &&
      (!Number.isSafeInteger(file.linesAdded) || file.linesAdded < 0)) ||
    (file.linesRemoved !== undefined &&
      (!Number.isSafeInteger(file.linesRemoved) || file.linesRemoved < 0)) ||
    (file.isBinary !== undefined && typeof file.isBinary !== 'boolean') ||
    (file.patchBytes !== undefined &&
      (!Number.isSafeInteger(file.patchBytes) || file.patchBytes < 0)) ||
    (file.renderUnavailableReason !== undefined && file.renderUnavailableReason !== 'too-large')
  ) {
    return null;
  }
  return file as ChangeReviewFile;
}

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
    for (const candidate of value.files) {
      const file = parseChangeReviewFile(candidate);
      if (!file) return null;
      files.push(file);
    }
    return { version: CHANGE_REVIEW_VERSION, base: value.base, tip: value.tip, files };
  } catch {
    return null;
  }
}

/** Parse the small relay pointer without trusting its remote URL or hash. */
export function parseChangeReviewArtifactDescriptor(
  content: string,
): ChangeReviewArtifactDescriptor | null {
  try {
    const value = JSON.parse(content) as Partial<ChangeReviewArtifactDescriptor>;
    if (
      value.version !== CHANGE_REVIEW_ARTIFACT_VERSION ||
      typeof value.base !== 'string' ||
      !/^[0-9a-f]{40}$/.test(value.base) ||
      typeof value.tip !== 'string' ||
      !/^[0-9a-f]{40}$/.test(value.tip) ||
      typeof value.patchId !== 'string' ||
      !/^[0-9a-f]{40}$/.test(value.patchId) ||
      typeof value.summary !== 'string' ||
      !value.summary.trim() ||
      !Number.isSafeInteger(value.fileCount) ||
      value.fileCount! < 1 ||
      typeof value.url !== 'string' ||
      !/^https?:\/\/[^\s]+$/i.test(value.url) ||
      typeof value.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.sha256) ||
      !Number.isSafeInteger(value.size) ||
      value.size! < 1
    ) {
      return null;
    }
    return { ...value, summary: value.summary.trim() } as ChangeReviewArtifactDescriptor;
  } catch {
    return null;
  }
}

/** Verify and parse the content-addressed artifact named by one relay event. */
export function parseChangeReviewArtifact(
  bytes: Uint8Array,
  descriptor: ChangeReviewArtifactDescriptor,
): ChangeReviewArtifact | null {
  if (bytes.byteLength !== descriptor.size || bytesToHex(sha256(bytes)) !== descriptor.sha256) {
    return null;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<ChangeReviewArtifact>;
    if (
      value.version !== CHANGE_REVIEW_ARTIFACT_VERSION ||
      value.base !== descriptor.base ||
      value.tip !== descriptor.tip ||
      value.patchId !== descriptor.patchId ||
      value.summary !== descriptor.summary ||
      !Array.isArray(value.files) ||
      value.files.length !== descriptor.fileCount
    ) {
      return null;
    }
    const files: ChangeReviewArtifactFile[] = [];
    for (const candidate of value.files) {
      const file = parseChangeReviewFile(candidate);
      if (!file || ('diff' in candidate && typeof candidate.diff !== 'string')) return null;
      if (file.renderUnavailableReason === 'too-large' && candidate.diff !== undefined) return null;
      files.push(candidate);
    }
    return {
      version: CHANGE_REVIEW_ARTIFACT_VERSION,
      base: descriptor.base,
      tip: descriptor.tip,
      patchId: descriptor.patchId,
      summary: descriptor.summary,
      files,
    };
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
