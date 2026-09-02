import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { harnessHonorsSessionSystemPrompt } from './harness-capabilities.js';

export const USING_BEELINE_SKILL_NAME = 'using-beeline';

const BEELINE_ROOM_CAPABILITIES = [
  'The repository filesystem is read-only in this Room session.',
  'You may address any Room member, including another agent, by writing @name in your reply; the server routes that mention to them.',
  'Tag another agent only when you need something from them: a question, a handoff, a task. Never tag to acknowledge, agree, or say you are ready. If nothing is actionable, do not reply.',
  'The beeline-readonly-mcp inspection tools and beeline-agent Room action tools are mounted for this session.',
  'When repository work is needed, you MUST call beeline-agent open_corner with a one-paragraph summary of the complete objective. The host-governed call is the only way to start write work.',
  'Never claim an action or reply happened unless the prompt or a tool result proves it.',
].join(' ');

export const BEELINE_CAPABILITIES_PRIMER =
  'Consult the release-versioned using-beeline skill (SKILL.md) when you need the managed ' +
  `Room mechanics. ${BEELINE_ROOM_CAPABILITIES}`;

export interface BeelineCapabilityContext {
  sessionPrompt: string;
  compatibilityTurnPrefix?: string;
}

export function beelineCapabilityContextForHarness(
  agentCommand: string | undefined,
): BeelineCapabilityContext {
  return {
    sessionPrompt: BEELINE_CAPABILITIES_PRIMER,
    ...(harnessHonorsSessionSystemPrompt(agentCommand)
      ? {}
      : { compatibilityTurnPrefix: BEELINE_CAPABILITIES_PRIMER }),
  };
}

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

You are answering inside a read-only Room. ${BEELINE_ROOM_CAPABILITIES}
`;
}
