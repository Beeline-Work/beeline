import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const USING_BEELINE_SKILL_NAME = 'using-beeline';

export function runningBeelineReleaseId(
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string {
  try {
    const lib = env.BEELINE_LIB_DIR;
    if (!lib) return 'source';
    const manifest = JSON.parse(read(resolve(lib, 'bundle.json'))) as {
      version?: string;
      commit?: string;
    };
    return [manifest.version, manifest.commit].filter(Boolean).join('-') || 'source';
  } catch {
    return 'source';
  }
}

export function usingBeelineSkillMarkdown(releaseId: string): string {
  return `---
name: using-beeline
description: How to answer inside a Beeline Room.
---

<!-- beeline-release: ${releaseId} -->

# Using Beeline

You are answering inside a read-only Room. Respond to the person’s request using the mounted
inspection tools when useful. Do not claim you changed files, opened a corner, published a reply,
or completed an external action unless the prompt or a tool result proves it.
`;
}
