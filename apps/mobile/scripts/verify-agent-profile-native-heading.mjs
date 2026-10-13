import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Check actual Android layout, rather than a React tree which cannot expose Yoga collapse.
const xml = readFileSync(process.argv[2], 'utf8');
function bounds(label) {
  const node = xml.match(new RegExp(`<node\\b[^>]*\\btext="${label}"[^>]*>`))?.[0];
  assert(node, `Android did not expose the visible ${label} heading`);
  const rect = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  assert(rect, `${label} has no Android bounds`);
  const [left, top, right, bottom] = rect.slice(1).map(Number);
  assert(right > left && bottom > top, `${label} collapsed to zero size`);
  return { left, top, right, bottom };
}
const title = bounds('RECENT WORK');
const metadata = bounds('Merged PRs');
assert(title.right <= metadata.left, 'Recent work overlaps its trailing metadata');
assert(Math.max(title.top, metadata.top) < Math.min(title.bottom, metadata.bottom),
  'Recent work and Merged PRs are not on the same row');
console.log('Android Recent work heading visible beside Merged PRs:', { title, metadata });
