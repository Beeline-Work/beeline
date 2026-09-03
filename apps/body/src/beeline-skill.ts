import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { harnessHonorsSessionSystemPrompt } from './harness-capabilities.js';

export const USING_BEELINE_SKILL_NAME = 'using-beeline';

const BEELINE_ROOM_CAPABILITIES = [
  'The repository filesystem is read-only in this Room session.',
  'You may address any Room member, including another agent, by writing @name in your reply; the server routes that mention to them.',
  'Tag another agent only when you need something from them: a question, a handoff, a task. Never tag to acknowledge, agree, or say you are ready. If nothing is actionable, do not reply.',
  'Tag the user only when you need a decision or input, or when the task they asked for is finished. Never tag for progress, acknowledgement, or questions the transcript already answers.',
  'Every MCP server mounted into this session is approved tool by tool - use operator and host tools freely; the read-only filesystem sandbox is the boundary, not a tool list. Network web search is enabled.',
  'To send a file, call beeline-agent attach_file with a path inside your checkout; it is attached to your reply.',
  'When repository work is needed, you MUST call beeline-agent open_corner with a one-paragraph summary of the complete objective. The host-governed call is the only way to start write work.',
  'Never claim an action or reply happened unless the prompt or a tool result proves it.',
].join(' ');

const BEELINE_DM_CAPABILITIES = [
  'This is a private direct-message conversation with one person. Every message they send is addressed to you; reply without tagging.',
  'This Room is strictly conversational: there is no repository binding and no corner can be opened from here.',
  'The repository filesystem is read-only in this session.',
  'Every MCP server mounted into this session is approved tool by tool - use operator and host tools freely; the read-only filesystem sandbox is the boundary, not a tool list. Network web search is enabled.',
  'To send a file, call beeline-agent attach_file with a path inside your checkout; it is attached to your reply.',
  'Tag the person only when you need a decision or input, or when the task they asked for is finished.',
  'Never claim an action or reply happened unless the prompt or a tool result proves it.',
].join(' ');

export interface RepositoryPrimerInfo {
  name: string;
  branch: string;
}

export function beelinePrimer(repository?: RepositoryPrimerInfo, directMessage?: boolean): string {
  if (directMessage) {
    return (
      'Consult the release-versioned using-beeline skill (SKILL.md) when you need the managed ' +
      `Room mechanics. ${BEELINE_DM_CAPABILITIES}`
    );
  }
  const repositoryLine = repository
    ? ` This Room is bound to ${repository.name} (branch ${repository.branch}); you have a read-only checkout at the session root.`
    : '';
  return (
    'Consult the release-versioned using-beeline skill (SKILL.md) when you need the managed ' +
    `Room mechanics. ${BEELINE_ROOM_CAPABILITIES}${repositoryLine}`
  );
}

export const BEELINE_CAPABILITIES_PRIMER = beelinePrimer();

export interface BeelineCapabilityContext {
  sessionPrompt: string;
  compatibilityTurnPrefix?: string;
}

export function beelineCapabilityContextForHarness(
  agentCommand: string | undefined,
  repository?: RepositoryPrimerInfo,
  directMessage?: boolean,
): BeelineCapabilityContext {
  const primer = beelinePrimer(repository, directMessage);
  return {
    sessionPrompt: primer,
    ...(harnessHonorsSessionSystemPrompt(agentCommand) ? {} : { compatibilityTurnPrefix: primer }),
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

You are answering inside a Room whose filesystem is read-only. ${BEELINE_ROOM_CAPABILITIES}
`;
}
