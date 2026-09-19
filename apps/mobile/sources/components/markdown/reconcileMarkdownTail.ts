import { parseMarkdownWithOffsets, type MarkdownBlock } from './parseMarkdown';

export type IncrementalMarkdownState = {
  readonly markdown: string;
  readonly blocks: readonly MarkdownBlock[];
  readonly stableBlocks: readonly MarkdownBlock[];
  readonly tailBlocks: readonly MarkdownBlock[];
  readonly stableBlockCount: number;
  readonly tailStart: number;
};

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
    tailBlocks,
    stableBlockCount: stableBlocks.length,
    tailStart: previous.tailStart + parsed.tailStart,
  };
}
