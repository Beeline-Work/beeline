import { git, publishEvent, type Identity } from '@beeline/gate';
import {
  CHANGE_REVIEW_EVENT_KIND,
  type ChangeReviewFile,
  type ChangeReviewStatus,
} from '@beeline/buzz-client';
import { signEvent } from '@beeline/nostr';

const PATCH_CHUNK_CHARACTERS = 32_000;

function statusName(code: string): ChangeReviewStatus {
  switch (code.charAt(0)) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'type-changed';
    case 'U':
      return 'unmerged';
    default:
      return 'modified';
  }
}

export function resolveReviewBaseTip(worktreePath: string, targetBranch: string): string {
  const branchName = targetBranch.replace(/^refs\/heads\//, '');
  const candidates = [
    `refs/remotes/origin/${branchName}`,
    targetBranch,
    `refs/heads/${branchName}`,
    branchName,
  ];
  for (const candidate of candidates) {
    const result = git(worktreePath, ['merge-base', 'HEAD', candidate]);
    const tip = result.stdout.trim();
    if (result.ok && /^[0-9a-f]{40}$/.test(tip)) return tip;
  }
  throw new Error(`cannot resolve review base for ${targetBranch}`);
}

function parseNameStatus(output: string): Array<{
  path: string;
  previousPath?: string;
  status: ChangeReviewStatus;
}> {
  return output.split('\n').flatMap((line) => {
    if (!line) return [];
    const [code = '', firstPath, secondPath] = line.split('\t');
    if (!firstPath) return [];
    if ((code.startsWith('R') || code.startsWith('C')) && secondPath) {
      return [{ path: secondPath, previousPath: firstPath, status: statusName(code) }];
    }
    return [{ path: firstPath, status: statusName(code) }];
  });
}

function fileStats(
  worktreePath: string,
  base: string,
  tip: string,
  path: string,
  previousPath?: string,
): Pick<ChangeReviewFile, 'linesAdded' | 'linesRemoved' | 'isBinary'> {
  const paths = previousPath ? [previousPath, path] : [path];
  const result = git(worktreePath, ['diff', '--numstat', base, tip, '--', ...paths]);
  if (!result.ok) throw new Error(`git diff --numstat failed for ${path}: ${result.stderr}`);
  let linesAdded = 0;
  let linesRemoved = 0;
  let isBinary = false;
  for (const line of result.stdout.split('\n')) {
    if (!line) continue;
    const [added, removed] = line.split('\t');
    if (added === '-' || removed === '-') {
      isBinary = true;
      continue;
    }
    linesAdded += Number.parseInt(added ?? '0', 10) || 0;
    linesRemoved += Number.parseInt(removed ?? '0', 10) || 0;
  }
  return { linesAdded, linesRemoved, ...(isBinary ? { isBinary: true } : {}) };
}

export function listChangeReviewFiles(
  worktreePath: string,
  base: string,
  tip: string,
): ChangeReviewFile[] {
  const result = git(worktreePath, [
    '-c',
    'core.quotePath=false',
    'diff',
    '--name-status',
    '--find-renames',
    base,
    tip,
  ]);
  if (!result.ok) throw new Error(`git diff --name-status failed: ${result.stderr}`);
  return parseNameStatus(result.stdout).map((file) => ({
    ...file,
    ...fileStats(worktreePath, base, tip, file.path, file.previousPath),
  }));
}

export function readChangeReviewPatch(
  worktreePath: string,
  base: string,
  tip: string,
  file: Pick<ChangeReviewFile, 'path' | 'previousPath'>,
): string {
  const paths = file.previousPath ? [file.previousPath, file.path] : [file.path];
  const result = git(worktreePath, [
    '-c',
    'core.quotePath=false',
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--unified=3',
    base,
    tip,
    '--',
    ...paths,
  ]);
  if (!result.ok) throw new Error(`git diff failed for ${file.path}: ${result.stderr}`);
  return result.stdout;
}

/** Bound each signed relay event while retaining the full patch. */
export function chunkChangeReviewPatch(patch: string): string[] {
  if (!patch) return [''];
  const chunks: string[] = [];
  for (let offset = 0; offset < patch.length; offset += PATCH_CHUNK_CHARACTERS) {
    chunks.push(patch.slice(offset, offset + PATCH_CHUNK_CHARACTERS));
  }
  return chunks;
}

/** Persist review payloads outside kind-9 chat history so reads stay lazy. */
export async function postChangeReviewMetadata(
  channelId: string,
  owner: Identity,
  coordinate: string,
  content: string,
  extraTags: string[][],
): Promise<void> {
  await publishEvent(
    signEvent(
      {
        pubkey: owner.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: CHANGE_REVIEW_EVENT_KIND,
        tags: [['h', channelId], ['d', coordinate], ...extraTags],
        content,
      },
      owner.secretKey,
    ),
    owner,
  );
}
