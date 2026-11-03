import { rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CHROME, createBrowserProofDirectory, runBrowserProof } from './browserProof';

it('keeps simultaneous generated proof entries outside the compiler source tree', async () => {
  const directories = await Promise.all([
    createBrowserProofDirectory('browser-proof-entry-'),
    createBrowserProofDirectory('browser-proof-entry-'),
  ]);
  try {
    expect(new Set(directories).size).toBe(2);
    for (const directory of directories) {
      const relative = path.relative(path.join(process.cwd(), 'sources'), directory);
      expect(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)).toBe(true);
      await writeFile(path.join(directory, 'proof.tsx'), 'export const proof = true;');
    }
  } finally {
    await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })));
  }
});

it.skipIf(!existsSync(CHROME))('resolves app dependencies and source aliases from an external proof entry', async () => {
  const directory = await createBrowserProofDirectory('browser-proof-resolution-');
  try {
    const entry = path.join(directory, 'proof.tsx');
    await writeFile(entry, `import React from 'react';
import { createRoot } from 'react-dom/client';
import { beelineThemes } from '@/buzz/groknight';
createRoot(document.getElementById('root')).render(<span>resolved</span>);
document.getElementById('result').textContent = typeof beelineThemes.obsidian;
`);
    const proof = await runBrowserProof({ entry, mobile: process.cwd(), shims: {}, width: 600 });
    expect(proof.status).toBe(0);
    expect(proof.result).toBe('object');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
