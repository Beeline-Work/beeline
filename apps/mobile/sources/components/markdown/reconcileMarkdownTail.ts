import { parseMarkdownWithOffsets, type MarkdownBlock } from './parseMarkdown';

export type IncrementalMarkdownState = {
  readonly markdown: string;
  readonly blocks: readonly MarkdownBlock[];
  readonly stableBlocks: readonly MarkdownBlock[];
  /** Fixed-size memo boundaries; completed chunks never change identity. */
  readonly stableBlockChunks: readonly (readonly MarkdownBlock[])[];
  readonly tailBlocks: readonly MarkdownBlock[];
  readonly stableBlockCount: number;
  readonly tailStart: number;
};

export const STABLE_MARKDOWN_CHUNK_SIZE = 8;

function chunkStableBlocks(blocks: readonly MarkdownBlock[]): readonly (readonly MarkdownBlock[])[] {
  const chunks: MarkdownBlock[][] = [];
  for (let index = 0; index < blocks.length; index += STABLE_MARKDOWN_CHUNK_SIZE) {
    chunks.push(blocks.slice(index, index + STABLE_MARKDOWN_CHUNK_SIZE));
  }
  return chunks;
}

function appendStableBlocks(
  chunks: readonly (readonly MarkdownBlock[])[],
  blocks: readonly MarkdownBlock[],
): readonly (readonly MarkdownBlock[])[] {
  if (blocks.length === 0) return chunks;
  const next = [...chunks];
  let remaining = [...blocks];
  const last = next.at(-1);
  if (last && last.length < STABLE_MARKDOWN_CHUNK_SIZE) {
    const take = Math.min(STABLE_MARKDOWN_CHUNK_SIZE - last.length, remaining.length);
    next[next.length - 1] = [...last, ...remaining.slice(0, take)];
    remaining = remaining.slice(take);
  }
  for (let index = 0; index < remaining.length; index += STABLE_MARKDOWN_CHUNK_SIZE) {
    next.push(remaining.slice(index, index + STABLE_MARKDOWN_CHUNK_SIZE));
  }
  return next;
}

function sameBlock(left: MarkdownBlock, right: MarkdownBlock): boolean {
  if (left === right) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseWhole(markdown: string): IncrementalMarkdownState {
  const parsed = parseMarkdownWithOffsets(markdown);
  const stableBlocks = parsed.blocks.slice(0, parsed.mutableBlockIndex);
  const tailBlocks = parsed.blocks.slice(parsed.mutableBlockIndex);
  return {
    markdown,
    blocks: parsed.blocks,
    stableBlocks,
    stableBlockChunks: chunkStableBlocks(stableBlocks),
    tailBlocks,
    stableBlockCount: parsed.mutableBlockIndex,
    tailStart: parsed.tailStart,
  };
}

/**
 * Reconcile an append-only streaming document from the final mutable parser
 * block. Every block before that boundary keeps its object identity, so its
 * memoized React subtree also stays untouched. Rewrites intentionally fall
 * back to a whole parse because no prefix remains trustworthy.
 */
export function reconcileMarkdownTail(
  previous: IncrementalMarkdownState | undefined,
  markdown: string,
): IncrementalMarkdownState {
  if (!previous || !markdown.startsWith(previous.markdown)) return parseWhole(markdown);
  if (markdown === previous.markdown) return previous;

  const parsed = parseMarkdownWithOffsets(markdown.slice(previous.tailStart));
  const priorTail = previous.tailBlocks;
  const tail = parsed.blocks.map((block, index) => {
    const prior = priorTail[index];
    return prior && sameBlock(prior, block) ? prior : block;
  });
  const promoted = tail.slice(0, parsed.mutableBlockIndex);
  const stableBlocks =
    promoted.length > 0 ? [...previous.stableBlocks, ...promoted] : previous.stableBlocks;
  const tailBlocks = tail.slice(parsed.mutableBlockIndex);
  const blocks = [...stableBlocks, ...tailBlocks];

  return {
    markdown,
    blocks,
    stableBlocks,
    stableBlockChunks: appendStableBlocks(previous.stableBlockChunks, promoted),
    tailBlocks,
    stableBlockCount: stableBlocks.length,
    tailStart: previous.tailStart + parsed.tailStart,
  };
}
