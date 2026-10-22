import assert from 'node:assert/strict';

// Longest-processing-time assignment keeps the slowest files on separate runners.
// New files use the measured median rather than disappearing from a static manifest.
export function balanceFiles(files, timings, count) {
  assert.ok(Number.isInteger(count) && count > 0, 'shard count must be positive');
  assert.equal(new Set(files).size, files.length, 'discovered files must be unique');
  const measured = Object.values(timings).filter((time) => Number.isFinite(time) && time > 0).sort((a, b) => a - b);
  const fallback = measured[Math.floor(measured.length / 2)] ?? 1000;
  const duration = (file) => timings[file] > 0 ? timings[file] : fallback;
  const shards = Array.from({ length: count }, () => ({ files: [], milliseconds: 0 }));
  for (const file of [...files].sort((a, b) => duration(b) - duration(a) || a.localeCompare(b, 'en'))) {
    const next = shards.reduce((best, shard) => shard.milliseconds < best.milliseconds ? shard : best);
    next.files.push(file);
    next.milliseconds += duration(file);
  }
  assert.deepEqual(shards.flatMap((shard) => shard.files).sort(), [...files].sort());
  return shards;
}
