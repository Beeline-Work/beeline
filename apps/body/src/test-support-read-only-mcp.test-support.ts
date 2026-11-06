import { describe, it, expect } from 'vitest';

import { cornerCallText } from './read-only-mcp.js';


import { Check } from 'typebox/value';

import { agentToolsFor, callAgentTool } from './read-only-mcp.js';

import { CAPABILITY_TOOLS, toolValidationSchema } from './minimal-tool-surface.js';


import { describe as m7_describe, expect as m7_expect, it as m7_it } from 'vitest';


import { agentToolsFor as m7_agentToolsFor, askChoice as m7_askChoice, openPoll as m7_openPoll, type AgentGrantDeps as m7_AgentGrantDeps } from "./read-only-mcp.js";

import { describe as mergedDescribe7 } from 'vitest';


import { describe as m8_describe, expect as m8_expect, it as m8_it } from 'vitest';


import { agentToolsFor as m8_agentToolsFor, emitEvent as m8_emitEvent, listEventSubscriptions as m8_listEventSubscriptions, subscribeEvents as m8_subscribeEvents, type AgentScheduleDeps as m8_AgentScheduleDeps, } from "./read-only-mcp.js";

import { describe as mergedDescribe8 } from 'vitest';


import type { createHash as m9_createHash } from 'node:crypto';


import { mkdtempSync as m9_mkdtempSync, rmSync as m9_rmSync, writeFileSync as m9_writeFileSync } from 'node:fs';


import { tmpdir as m9_tmpdir } from 'node:os';


import { join as m9_join } from 'node:path';


import { afterEach as m9_afterEach, describe as m9_describe, expect as m9_expect, it as m9_it } from 'vitest';


import { REQUESTABLE_AGENT_GRANT_KINDS as m9_REQUESTABLE_AGENT_GRANT_KINDS } from '@beeline/api-contract/agent-grants';


import { agentToolsFor as m9_agentToolsFor, listGrants as m9_listGrants, requestGrant as m9_requestGrant, requestSharedAssetIsolation as m9_requestSharedAssetIsolation, runGrantedCommand as m9_runGrantedCommand, storeSecret as m9_storeSecret, type AgentGrantDeps as m9_AgentGrantDeps, type GrantRunDeps as m9_GrantRunDeps, } from "./read-only-mcp.js";


import { resolveGrantCommand as m9_resolveGrantCommand } from "./grant-script.js";


import { approvedDeviceGrant as m9_approvedDeviceGrant } from "./monolith-room-turn.js";

import { describe as mergedDescribe9 } from 'vitest';


import { describe as m10_describe, expect as m10_expect, it as m10_it } from 'vitest';


import { MESSAGE_REACTION_EMOJIS as m10_MESSAGE_REACTION_EMOJIS } from '@beeline/api-contract/phone';


import { agentToolsFor as m10_agentToolsFor, reactToMessage as m10_reactToMessage, type AgentScheduleDeps as m10_AgentScheduleDeps } from "./read-only-mcp.js";

import { describe as mergedDescribe10 } from 'vitest';


import { describe as m11_describe, expect as m11_expect, it as m11_it } from 'vitest';


import { createSchedule as m11_createSchedule, deleteSchedule as m11_deleteSchedule, listSchedules as m11_listSchedules, updateSchedule as m11_updateSchedule, type AgentScheduleDeps as m11_AgentScheduleDeps, } from "./read-only-mcp.js";

import { describe as mergedDescribe11 } from 'vitest';


import { describe as m14_describe, expect as m14_expect, it as m14_it, vi as m14_vi } from 'vitest';


import { agentToolsFor as m14_agentToolsFor, connectorOfferDepsFromEnv as m14_connectorOfferDepsFromEnv, offerConnector as m14_offerConnector, workbenchStatus as m14_workbenchStatus, type ConnectorOfferDeps as m14_ConnectorOfferDeps, } from "./read-only-mcp.js";


import { pendingGrantToolCall as m14_pendingGrantToolCall, resumePrompt as m14_resumePrompt } from "./monolith-room-turn.js";

import { describe as mergedDescribe14 } from 'vitest';


import { mkdtempSync as m24_mkdtempSync, writeFileSync as m24_writeFileSync } from 'node:fs';


import { join as m24_join } from 'node:path';


import { tmpdir as m24_tmpdir } from 'node:os';


import { afterEach as m24_afterEach, beforeEach as m24_beforeEach, describe as m24_describe, expect as m24_expect, it as m24_it, vi as m24_vi } from 'vitest';


import { agentToolsFor as m24_agentToolsFor, callAgentTool as m24_callAgentTool } from "./read-only-mcp.js";


import { CAPABILITY_ROUTES as m24_CAPABILITY_ROUTES } from "./minimal-tool-surface.js";


import { assembleTurnPrompt as m24_assembleTurnPrompt, type PromptSurface as m24_PromptSurface } from "./prompt-assembly.js";

import { describe as mergedDescribe24 } from 'vitest';


import { mkdtempSync as m25_mkdtempSync, rmSync as m25_rmSync, writeFileSync as m25_writeFileSync } from 'node:fs';


import { tmpdir as m25_tmpdir } from 'node:os';


import { join as m25_join } from 'node:path';


import { afterEach as m25_afterEach, beforeEach as m25_beforeEach, describe as m25_describe, expect as m25_expect, it as m25_it, vi as m25_vi } from 'vitest';


import { callAgentTool as m25_callAgentTool } from "./read-only-mcp.js";

import { describe as mergedDescribe25 } from 'vitest';


import { afterEach as m26_afterEach, beforeEach as m26_beforeEach, expect as m26_expect, it as m26_it, vi as m26_vi } from 'vitest';


import { mkdtempSync as m26_mkdtempSync } from 'node:fs';


import { tmpdir as m26_tmpdir } from 'node:os';


import { join as m26_join } from 'node:path';


import type { AgentCommand as m26_AgentCommand } from '@beeline/api-contract/daemon';


import { callAgentTool as m26_callAgentTool } from "./read-only-mcp.js";


import { CommandExecutionContext as m26_CommandExecutionContext } from "./server-command-intake.js";

import { describe as mergedDescribe26 } from 'vitest';


import { afterEach as m27_afterEach, beforeEach as m27_beforeEach, expect as m27_expect, it as m27_it, vi as m27_vi } from 'vitest';


import { agentToolsFor as m27_agentToolsFor, callAgentTool as m27_callAgentTool } from "./read-only-mcp.js";

import { describe as mergedDescribe27 } from 'vitest';


import { afterEach as m28_afterEach, beforeEach as m28_beforeEach, describe as m28_describe, expect as m28_expect, it as m28_it, vi as m28_vi } from 'vitest';


import { beelineManagedSkills as m28_beelineManagedSkills } from "./beeline-skill.js";


import { callAgentTool as m28_callAgentTool } from "./read-only-mcp.js";

import { describe as mergedDescribe28 } from 'vitest';


import { afterEach as m29_afterEach, beforeEach as m29_beforeEach, describe as m29_describe, expect as m29_expect, it as m29_it, vi as m29_vi } from 'vitest';


import { callAgentTool as m29_callAgentTool, daemonOperationIsSafeToRepeat as m29_daemonOperationIsSafeToRepeat, isDaemonNetworkFailure as m29_isDaemonNetworkFailure, } from "./read-only-mcp.js";

import { describe as mergedDescribe29 } from 'vitest';


import { mkdtempSync as m30_mkdtempSync, rmSync as m30_rmSync, writeFileSync as m30_writeFileSync } from 'node:fs';


import { tmpdir as m30_tmpdir } from 'node:os';


import { join as m30_join } from 'node:path';


import { afterEach as m30_afterEach, beforeEach as m30_beforeEach, describe as m30_describe, expect as m30_expect, it as m30_it, vi as m30_vi } from 'vitest';


import { callAgentTool as m30_callAgentTool } from "./read-only-mcp.js";

import { describe as mergedDescribe30 } from 'vitest';


import { afterEach as m31_afterEach, beforeEach as m31_beforeEach, expect as m31_expect, it as m31_it, vi as m31_vi } from 'vitest';


import { agentToolsFor as m31_agentToolsFor, callAgentTool as m31_callAgentTool } from "./read-only-mcp.js";

import { describe as mergedDescribe31 } from 'vitest';


import { afterEach as m32_afterEach, beforeEach as m32_beforeEach, describe as m32_describe, expect as m32_expect, it as m32_it, vi as m32_vi } from 'vitest';


import { mkdtempSync as m32_mkdtempSync } from 'node:fs';


import { tmpdir as m32_tmpdir } from 'node:os';


import { join as m32_join } from 'node:path';


import type { AgentCommand as m32_AgentCommand } from '@beeline/api-contract/daemon';


import { agentToolsFor as m32_agentToolsFor, callAgentTool as m32_callAgentTool } from "./read-only-mcp.js";


import { CommandExecutionContext as m32_CommandExecutionContext } from "./server-command-intake.js";

import { describe as mergedDescribe32 } from 'vitest';


import { afterEach as m33_afterEach, describe as m33_describe, expect as m33_expect, it as m33_it, vi as m33_vi } from 'vitest';


import { callAgentTool as m33_callAgentTool } from "./read-only-mcp.js";

import { describe as mergedDescribe33 } from 'vitest';


import { mkdtempSync as m34_mkdtempSync, mkdirSync as m34_mkdirSync, type realpathSync as m34_realpathSync, rmSync as m34_rmSync, type symlinkSync as m34_symlinkSync, writeFileSync as m34_writeFileSync } from 'node:fs';


import { tmpdir as m34_tmpdir } from 'node:os';


import { join as m34_join } from 'node:path';


import { afterEach as m34_afterEach, beforeEach as m34_beforeEach, describe as m34_describe, expect as m34_expect, it as m34_it, vi as m34_vi } from 'vitest';


import { bindBriefFiles as m34_bindBriefFiles, postArtifact as m34_postArtifact, resolveAttachPath as m34_resolveAttachPath, type PostArtifactDeps as m34_PostArtifactDeps } from "./read-only-mcp.js";

import { describe as mergedDescribe34 } from 'vitest';


import { afterEach as m43_afterEach, describe as m43_describe, expect as m43_expect, it as m43_it, vi as m43_vi } from 'vitest';


import { agentToolsFor as m43_agentToolsFor, callAgentTool as m43_callAgentTool, daemonOperationIsSafeToRepeat as m43_daemonOperationIsSafeToRepeat } from "./read-only-mcp.js";

import { describe as mergedDescribe43 } from 'vitest';


export const schema = (name: string) => toolValidationSchema(name)!;
export type Call = { name: string; input: Record<string, unknown> };
export function fixtureScope3() {



function deps(
  answer: Record<string, unknown>,
  ops: Array<{ name: string; input: Record<string, unknown> }> = [],
): m7_AgentGrantDeps {
  return {
    roomId: 'room-1',
    execute: async (name, input) => {
      ops.push({ name, input: input as Record<string, unknown> });
      return answer;
    },
  };
}



const options = [
  { label: 'Kraken paper', consequence: 'Works with plugin auth' },
  { label: 'Keep waiting', consequence: 'Blocked on CDP JWT', costly: true },
];
return {
deps,
options,
};
}
export function fixtureScope6() {



function deps(
  calls: Call[],
  answers: Record<string, Record<string, unknown> | Error> = {},
): m8_AgentScheduleDeps {
  return {
    roomId: 'room-1',
    execute: async (name, input) => {
      calls.push({ name, input: input as Record<string, unknown> });
      const answer = answers[name];
      if (answer instanceof Error) throw answer;
      return answer ?? { id: 'w', createdAt: 1 };
    },
  };
}
return {
deps,
};
}
export function fixtureScope8() {



function deps(
  answer: Record<string, unknown>,
  ops: Array<{ name: string; input: Record<string, unknown> }> = [],
  secrets: Record<string, string> = { FLY_TOKEN: 'fly-secret-value-123' },
): m9_AgentGrantDeps {
  return {
    roomId: 'room-1',
    execute: async (name, input) => {
      ops.push({ name, input: input as Record<string, unknown> });
      return answer;
    },
    resolveSecret: async (name) => secrets[name],
  };
}
return {
deps,
};
}
export function fixtureScope12(scope8: ReturnType<typeof fixtureScope8>) {

  const roots: string[] = [];

  m9_afterEach(() => {
    for (const root of roots.splice(0)) m9_rmSync(root, { recursive: true, force: true });
  });


  const checkout = (contents: string, name = 'fix.py') => {
    const root = m9_mkdtempSync(m9_join(m9_tmpdir(), 'beeline-grant-script-'));
    roots.push(root);
    m9_writeFileSync(m9_join(root, name), contents);
    return root;
  };
return {
roots,
checkout,
};
}
export function fixtureScope16() {



function deps(ops: Array<{ name: string; input: Record<string, unknown> }>): m11_AgentScheduleDeps {
  return {
    roomId: 'room-1',
    execute: async (name, input) => {
      ops.push({ name, input: input as Record<string, unknown> });
      if (name === 'createAgentSchedule') {
        return { scheduleId: 'sched-1', nextRunAt: 1_800_000_000 };
      }
      if (name === 'listAgentSchedules') {
        return {
          schedules: [
            {
              scheduleId: 'sched-1',
              agentId: 'agent-2',
              agentHandle: 'rival',
              prompt: 'message hello',
              cadence: { kind: 'interval', everyMinutes: 1 },
              maxRuns: 5,
              runCount: 2,
              nextRunAt: 1_800_000_000,
            },
          ],
        };
      }
      if (name === 'updateAgentSchedule') {
        return { scheduleId: 'sched-1', nextRunAt: 1_800_000_000 };
      }
      return { id: 'w', createdAt: 1 };
    },
  };
}
return {
deps,
};
}
export function fixtureScope18() {



function deps(
  answer: Record<string, unknown>,
  ops: Array<{ name: string; input: Record<string, unknown> }> = [],
  extra: Partial<m14_ConnectorOfferDeps> = {},
): m14_ConnectorOfferDeps {
  return {
    roomId: 'room-1',
    execute: async (name, input) => {
      ops.push({ name, input: input as Record<string, unknown> });
      return answer;
    },
    ...extra,
  };
}
return {
deps,
};
}
export function fixtureScope20() {



/** Each place an agent turn runs in, with the MCP environment and prompt facts it gets. */
const PLACES: ReadonlyArray<{ name: string; corner: boolean; surface: m24_PromptSurface; commandReason: string }> = [
  { name: 'Room', corner: false, surface: 'room', commandReason: 'human_tag' },
  { name: 'DM', corner: false, surface: 'dm', commandReason: 'direct_message' },
  { name: 'code corner', corner: true, surface: 'code-corner', commandReason: 'order' },
  { name: 'repo-less corner', corner: true, surface: 'repo-less-corner', commandReason: 'order' },
  { name: 'schedule run in a Room', corner: false, surface: 'room', commandReason: 'schedule' },
  { name: 'schedule run in a corner', corner: true, surface: 'code-corner', commandReason: 'schedule' },
];


const ALL_APPS = Object.keys(m24_CAPABILITY_ROUTES).map(capability => `beeline:${capability}`);


const appsIn = (text: string) => [...new Set(text.match(/beeline:[a-z_]+/g) ?? [])].sort();



function useEnvironment(corner: boolean) {
  const context = m24_join(m24_mkdtempSync(m24_join(m24_tmpdir(), 'place-capabilities-')), 'context.json');
  m24_writeFileSync(context, JSON.stringify({ roomId: corner ? 'corner' : 'room', requestId: 'request', generationId: 'generation' }));
  for (const [key, value] of Object.entries({
    BEELINE_DAEMON_ROOM_ID: corner ? 'corner' : 'room',
    BEELINE_DAEMON_CORNER_ID: corner ? 'corner' : '',
    BEELINE_DAEMON_AGENT_ID: 'self',
    BEELINE_DAEMON_BASE_URL: 'http://localhost',
    BEELINE_DAEMON_TOKEN: 'test',
    BEELINE_TURN_CONTEXT_FILE: context,
  })) m24_vi.stubEnv(key, value);
}



/** What discovery offers: app_tool's own list and connect's capabilities. */
async function discovered(corner: boolean): Promise<string[]> {
  const appTool = m24_agentToolsFor(true, false, corner).find(tool => tool.name === 'app_tool')!;
  const connect = JSON.parse(await m24_callAgentTool('connect', { mode: 'discover' }, 'discover')) as { capabilities: string[] };
  return [...new Set([...appsIn(appTool.description), ...connect.capabilities])].sort();
}



m24_afterEach(() => {
  m24_vi.unstubAllGlobals();
  m24_vi.unstubAllEnvs();
});
return {
PLACES,
ALL_APPS,
appsIn,
useEnvironment,
discovered,
};
}
export function fixtureScope21(scope20: ReturnType<typeof fixtureScope20>, { corner, surface, commandReason, repositoryOnboarding }: Pick<{ repositoryOnboarding: boolean; name: string; corner: boolean; surface: m24_PromptSurface; commandReason: string; }, "corner" | "surface" | "commandReason" | "repositoryOnboarding">) {

  m24_beforeEach(() => {
    m24_vi.stubGlobal('fetch', async () => Response.json({ repositoryOnboarding }));
  });
return {

};
}
export function fixtureScope23() {

  let home: string;

  let calls: Array<{ name: string; input: Record<string, unknown> }>;

  let answer: (name: string) => Response;


  m25_beforeEach(() => {
    home = m25_mkdtempSync(m25_join(m25_tmpdir(), 'beeline-corner-message-'));
    const context = m25_join(home, 'turn.json');
    // The active command lives in the corner; the session env still names the
    // parent Room, as a real corner session does.
    m25_writeFileSync(
      context,
      JSON.stringify({
        roomId: 'corner-room',
        requestId: 'request-1',
        generationId: 'generation-1',
      }),
    );
    m25_vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', context);
    m25_vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://daemon.test');
    m25_vi.stubEnv('BEELINE_DAEMON_TOKEN', 'daemon-only');
    m25_vi.stubEnv('BEELINE_DAEMON_AGENT_ID', 'agent-1');
    m25_vi.stubEnv('BEELINE_DAEMON_ROOM_ID', 'parent-room');
    m25_vi.stubEnv('BEELINE_DAEMON_CORNER_ID', 'corner-room');
    calls = [];
    answer = () => Response.json({});
    m25_vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      const name = String(url).split('/').at(-1)!;
      calls.push({ name, input: JSON.parse(String(init.body)) });
      return answer(name);
    });
  });


  m25_afterEach(() => {
    m25_vi.unstubAllGlobals();
    m25_vi.unstubAllEnvs();
    m25_rmSync(home, { recursive: true, force: true });
  });
return {
get home(){return home;}, set home(value: typeof home){home=value;},
get calls(){return calls;}, set calls(value: typeof calls){calls=value;},
get answer(){return answer;}, set answer(value: typeof answer){answer=value;},
};
}
export function fixtureScope24() {


const calls: Array<{ name: string; input: Record<string, unknown> }> = [];


let context: m26_CommandExecutionContext;


m26_beforeEach(async () => {
  calls.length=0;
  context=new m26_CommandExecutionContext(m26_mkdtempSync(m26_join(m26_tmpdir(),'onboarding-tools-')));
  await context.enter({roomId:'room-1',turnRequestId:'request-1',rootCommandId:'command-1'} as m26_AgentCommand);
  for (const [key,value] of Object.entries({BEELINE_DAEMON_AGENT_ID:'agent-1',BEELINE_DAEMON_ROOM_ID:'room-1',BEELINE_DAEMON_BASE_URL:'http://localhost:1234',BEELINE_DAEMON_TOKEN:'test-token',BEELINE_TURN_CONTEXT_FILE:context.path})) m26_vi.stubEnv(key,value);
  m26_vi.stubGlobal('fetch', async (url:URL,init:RequestInit) => {
    calls.push({name:new URL(url).pathname.split('/').pop()!,input:JSON.parse(String(init.body))});
    return Response.json({state:'no_repo_linked',repositoryOnboarding:true});
  });
});


m26_afterEach(() => {m26_vi.unstubAllEnvs();m26_vi.unstubAllGlobals();});
return {
calls,
get context(){return context;}, set context(value: typeof context){context=value;},
};
}
export function fixtureScope25() {



m27_beforeEach(() => {
  m27_vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://daemon.test');
  m27_vi.stubEnv('BEELINE_DAEMON_TOKEN', 'test-token');
  m27_vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', '');
});


m27_afterEach(() => {
  m27_vi.unstubAllGlobals();
  m27_vi.unstubAllEnvs();
});
return {

};
}
export function fixtureScope27() {

  m28_beforeEach(() => {
    m28_vi.stubEnv('BEELINE_DAEMON_AGENT_ID', 'agent');
    m28_vi.stubEnv('BEELINE_DAEMON_ROOM_ID', 'room');
    m28_vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://daemon.test');
    m28_vi.stubEnv('BEELINE_DAEMON_TOKEN', 'test-token');
    m28_vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', '');
    m28_vi.stubEnv('BEELINE_LIB_DIR', '');
    m28_vi.stubGlobal('fetch', m28_vi.fn(async () => Response.json({ error: 'workspace skill not found' }, { status: 404 })));
  });

  m28_afterEach(() => { m28_vi.unstubAllEnvs(); m28_vi.unstubAllGlobals(); });
return {

};
}
export function fixtureScope28() {



m29_beforeEach(() => {
  for (const [key, value] of Object.entries({
    BEELINE_DAEMON_ROOM_ID: 'room-1',
    BEELINE_DAEMON_BASE_URL: 'http://localhost:1234',
    BEELINE_DAEMON_TOKEN: 'test-token',
  }))
    m29_vi.stubEnv(key, value);
});



m29_afterEach(() => {
  m29_vi.unstubAllGlobals();
  m29_vi.unstubAllEnvs();
});



const bareFetchFailed = () => new TypeError('fetch failed');
return {
bareFetchFailed,
};
}
export function fixtureScope33() {

  let home: string;

  let calls: Array<{ name: string; input: Record<string, unknown> }>;

  let usage: unknown;


  m30_beforeEach(() => {
    home = m30_mkdtempSync(m30_join(m30_tmpdir(), 'beeline-usage-'));
    const context = m30_join(home, 'turn.json');
    m30_writeFileSync(context, JSON.stringify({ roomId: 'room-1', requestId: 'r', generationId: 'g' }));
    m30_vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', context);
    m30_vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://daemon.test');
    m30_vi.stubEnv('BEELINE_DAEMON_TOKEN', 'daemon-only');
    m30_vi.stubEnv('BEELINE_DAEMON_AGENT_ID', 'agent-self');
    m30_vi.stubEnv('BEELINE_DAEMON_ROOM_ID', 'room-1');
    calls = [];
    m30_vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      const name = String(url).split('/').at(-1)!;
      calls.push({ name, input: JSON.parse(String(init.body)) });
      return Response.json(usage);
    });
  });

  m30_afterEach(() => {
    m30_vi.unstubAllGlobals();
    m30_vi.unstubAllEnvs();
    m30_rmSync(home, { recursive: true, force: true });
  });


  const read = async (args: Record<string, unknown> = {}) =>
    JSON.parse(await m30_callAgentTool('read', { facet: 'usage', ...args }, 'call-1'));

  const now = Date.now() / 1000;
return {
get home(){return home;}, set home(value: typeof home){home=value;},
get calls(){return calls;}, set calls(value: typeof calls){calls=value;},
get usage(){return usage;}, set usage(value: typeof usage){usage=value;},
read,
now,
};
}
export function fixtureScope34() {



const snapshot = {
  id: 'sibling',
  name: 'Ship widget',
  workflowState: 'review',
  pullRequestNumber: 42,
  pullRequestUrl: 'https://github.com/owner/widgets/pull/42',
  headSha: 'a'.repeat(40),
  checks: 'passing',
  mergeCommitSha: null,
};


let calls: { name: string; input: unknown }[];


m31_beforeEach(() => {
  m31_vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://daemon.test');
  m31_vi.stubEnv('BEELINE_DAEMON_TOKEN', 'test-token');
  m31_vi.stubEnv('BEELINE_DAEMON_ROOM_ID', 'parent');
  m31_vi.stubEnv('BEELINE_DAEMON_CORNER_ID', 'watcher');
  m31_vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', '');
  calls = [];
  m31_vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
    const input = JSON.parse(String(init.body));
    calls.push({ name: String(url).split('/').at(-1)!, input });
    return Response.json({ kinds: input.kinds, snapshot });
  });
});


m31_afterEach(() => {
  m31_vi.unstubAllGlobals();
  m31_vi.unstubAllEnvs();
});
return {
snapshot,
get calls(){return calls;}, set calls(value: typeof calls){calls=value;},
};
}
export function fixtureScope36() {

  const calls: { name: string; input: Record<string, unknown> }[] = [];

  let context: m32_CommandExecutionContext;

  m32_beforeEach(async () => {
    calls.length = 0;
    context = new m32_CommandExecutionContext(m32_mkdtempSync(m32_join(m32_tmpdir(), 'workflow-tools-')));
    await context.enter({ roomId: 'room-1', turnRequestId: 'request-1', rootCommandId: 'command-1' } as m32_AgentCommand);
    for (const [key, value] of Object.entries({
      BEELINE_DAEMON_AGENT_ID: 'agent-1', BEELINE_DAEMON_ROOM_ID: 'room-1',
      BEELINE_DAEMON_BASE_URL: 'http://localhost:1234', BEELINE_DAEMON_TOKEN: 'test-token',
      BEELINE_TURN_CONTEXT_FILE: context.path,
    })) m32_vi.stubEnv(key, value);
    m32_vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      calls.push({ name: new URL(url).pathname.split('/').pop()!, input: JSON.parse(String(init.body)) });
      return Response.json({ runId: 'run-1', state: 'draft' });
    });
  });

  m32_afterEach(() => { m32_vi.unstubAllEnvs(); m32_vi.unstubAllGlobals(); });
return {
calls,
get context(){return context;}, set context(value: typeof context){context=value;},
};
}
export function fixtureScope37() {

  const calls: { name: string; input: Record<string, unknown> }[] = [];

  let context: m32_CommandExecutionContext;

  m32_beforeEach(async () => {
    calls.length = 0;
    context = new m32_CommandExecutionContext(m32_mkdtempSync(m32_join(m32_tmpdir(), 'workflow-tools-corner-')));
    await context.enter({ roomId: 'corner-1', turnRequestId: 'request-1', rootCommandId: 'command-1' } as m32_AgentCommand);
    for (const [key, value] of Object.entries({
      BEELINE_DAEMON_AGENT_ID: 'agent-1', BEELINE_DAEMON_ROOM_ID: 'parent-room',
      BEELINE_DAEMON_CORNER_ID: 'corner-1',
      BEELINE_DAEMON_BASE_URL: 'http://localhost:1234', BEELINE_DAEMON_TOKEN: 'test-token',
      BEELINE_TURN_CONTEXT_FILE: context.path,
    })) m32_vi.stubEnv(key, value);
    m32_vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      calls.push({ name: new URL(url).pathname.split('/').pop()!, input: JSON.parse(String(init.body)) });
      return Response.json({ runId: 'run-1', state: 'draft' });
    });
  });

  m32_afterEach(() => { m32_vi.unstubAllEnvs(); m32_vi.unstubAllGlobals(); });
return {
calls,
get context(){return context;}, set context(value: typeof context){context=value;},
};
}
export function fixtureScope38() {



const valid = { action: 'request', kind: 'host', target: 'example.com', reason: 'Inspect service', purpose: 'Diagnose the service' };



m33_afterEach(() => {
  m33_vi.unstubAllGlobals();
  m33_vi.unstubAllEnvs();
});
return {
valid,
};
}
export function fixtureScope41() {

  let root: string;

  let home: string;

  let checkout: string;

  let roots: string[];

  m34_beforeEach(() => {
    root = m34_mkdtempSync(m34_join(m34_tmpdir(), 'attach-home-'));
    home = m34_join(root, 'home');
    checkout = m34_join(root, 'checkout');
    m34_mkdirSync(home);
    m34_mkdirSync(checkout);
    roots = [checkout, home];
    m34_vi.stubEnv('HOME', home);
    m34_writeFileSync(m34_join(home, 'notes.txt'), 'File for delivery');
    m34_writeFileSync(m34_join(root, 'outside.txt'), 'Private');
  });

  m34_afterEach(() => {
    m34_vi.unstubAllEnvs();
    m34_rmSync(root, { recursive: true, force: true });
  });
return {
get root(){return root;}, set root(value: typeof root){root=value;},
get home(){return home;}, set home(value: typeof home){home=value;},
get checkout(){return checkout;}, set checkout(value: typeof checkout){checkout=value;},
get roots(){return roots;}, set roots(value: typeof roots){roots=value;},
};
}
export function fixtureScope42() {



m43_afterEach(() => {
  m43_vi.unstubAllEnvs();
  m43_vi.unstubAllGlobals();
  m43_vi.useRealTimers();
});



const payload = {
  domain: {
    name: 'Exchange',
    version: '1',
    chainId: 1337,
    verifyingContract: '0x' + '0'.repeat(40),
  },
  types: { BeelineTest: [{ name: 'notice', type: 'string' }] },
  primaryType: 'BeelineTest',
  message: { notice: 'Harmless signing test; no order or transfer' },
};
return {
payload,
};
}
export { describe, it, expect, describe as m7_describe, expect as m7_expect, it as m7_it, describe as mergedDescribe7, describe as m8_describe, expect as m8_expect, it as m8_it, describe as mergedDescribe8, afterEach as m9_afterEach, describe as m9_describe, expect as m9_expect, it as m9_it, describe as mergedDescribe9, describe as m10_describe, expect as m10_expect, it as m10_it, describe as mergedDescribe10, describe as m11_describe, expect as m11_expect, it as m11_it, describe as mergedDescribe11, describe as m14_describe, expect as m14_expect, it as m14_it, vi as m14_vi, describe as mergedDescribe14, afterEach as m24_afterEach, beforeEach as m24_beforeEach, describe as m24_describe, expect as m24_expect, it as m24_it, vi as m24_vi, describe as mergedDescribe24, afterEach as m25_afterEach, beforeEach as m25_beforeEach, describe as m25_describe, expect as m25_expect, it as m25_it, vi as m25_vi, describe as mergedDescribe25, afterEach as m26_afterEach, beforeEach as m26_beforeEach, expect as m26_expect, it as m26_it, vi as m26_vi, describe as mergedDescribe26, afterEach as m27_afterEach, beforeEach as m27_beforeEach, expect as m27_expect, it as m27_it, vi as m27_vi, describe as mergedDescribe27, afterEach as m28_afterEach, beforeEach as m28_beforeEach, describe as m28_describe, expect as m28_expect, it as m28_it, vi as m28_vi, describe as mergedDescribe28, afterEach as m29_afterEach, beforeEach as m29_beforeEach, describe as m29_describe, expect as m29_expect, it as m29_it, vi as m29_vi, describe as mergedDescribe29, afterEach as m30_afterEach, beforeEach as m30_beforeEach, describe as m30_describe, expect as m30_expect, it as m30_it, vi as m30_vi, describe as mergedDescribe30, afterEach as m31_afterEach, beforeEach as m31_beforeEach, expect as m31_expect, it as m31_it, vi as m31_vi, describe as mergedDescribe31, afterEach as m32_afterEach, beforeEach as m32_beforeEach, describe as m32_describe, expect as m32_expect, it as m32_it, vi as m32_vi, describe as mergedDescribe32, afterEach as m33_afterEach, describe as m33_describe, expect as m33_expect, it as m33_it, vi as m33_vi, describe as mergedDescribe33, afterEach as m34_afterEach, beforeEach as m34_beforeEach, describe as m34_describe, expect as m34_expect, it as m34_it, vi as m34_vi, describe as mergedDescribe34, afterEach as m43_afterEach, describe as m43_describe, expect as m43_expect, it as m43_it, vi as m43_vi, describe as mergedDescribe43 } from 'vitest';
export { cornerCallText, agentToolsFor, callAgentTool, agentToolsFor as m7_agentToolsFor, askChoice as m7_askChoice, openPoll as m7_openPoll, agentToolsFor as m8_agentToolsFor, emitEvent as m8_emitEvent, listEventSubscriptions as m8_listEventSubscriptions, subscribeEvents as m8_subscribeEvents, agentToolsFor as m9_agentToolsFor, listGrants as m9_listGrants, requestGrant as m9_requestGrant, requestSharedAssetIsolation as m9_requestSharedAssetIsolation, runGrantedCommand as m9_runGrantedCommand, storeSecret as m9_storeSecret, agentToolsFor as m10_agentToolsFor, reactToMessage as m10_reactToMessage, createSchedule as m11_createSchedule, deleteSchedule as m11_deleteSchedule, listSchedules as m11_listSchedules, updateSchedule as m11_updateSchedule, agentToolsFor as m14_agentToolsFor, connectorOfferDepsFromEnv as m14_connectorOfferDepsFromEnv, offerConnector as m14_offerConnector, workbenchStatus as m14_workbenchStatus, agentToolsFor as m24_agentToolsFor, callAgentTool as m24_callAgentTool, callAgentTool as m25_callAgentTool, callAgentTool as m26_callAgentTool, agentToolsFor as m27_agentToolsFor, callAgentTool as m27_callAgentTool, callAgentTool as m28_callAgentTool, callAgentTool as m29_callAgentTool, daemonOperationIsSafeToRepeat as m29_daemonOperationIsSafeToRepeat, isDaemonNetworkFailure as m29_isDaemonNetworkFailure, callAgentTool as m30_callAgentTool, agentToolsFor as m31_agentToolsFor, callAgentTool as m31_callAgentTool, agentToolsFor as m32_agentToolsFor, callAgentTool as m32_callAgentTool, callAgentTool as m33_callAgentTool, bindBriefFiles as m34_bindBriefFiles, postArtifact as m34_postArtifact, resolveAttachPath as m34_resolveAttachPath, agentToolsFor as m43_agentToolsFor, callAgentTool as m43_callAgentTool, daemonOperationIsSafeToRepeat as m43_daemonOperationIsSafeToRepeat } from './read-only-mcp.js';
export { Check } from 'typebox/value';
export { CAPABILITY_TOOLS, toolValidationSchema, CAPABILITY_ROUTES as m24_CAPABILITY_ROUTES } from './minimal-tool-surface.js';
export { createHash as m9_createHash } from 'node:crypto';
export { mkdtempSync as m9_mkdtempSync, rmSync as m9_rmSync, writeFileSync as m9_writeFileSync, mkdtempSync as m24_mkdtempSync, writeFileSync as m24_writeFileSync, mkdtempSync as m25_mkdtempSync, rmSync as m25_rmSync, writeFileSync as m25_writeFileSync, mkdtempSync as m26_mkdtempSync, mkdtempSync as m30_mkdtempSync, rmSync as m30_rmSync, writeFileSync as m30_writeFileSync, mkdtempSync as m32_mkdtempSync, mkdtempSync as m34_mkdtempSync, mkdirSync as m34_mkdirSync, realpathSync as m34_realpathSync, rmSync as m34_rmSync, symlinkSync as m34_symlinkSync, writeFileSync as m34_writeFileSync } from 'node:fs';
export { tmpdir as m9_tmpdir, tmpdir as m24_tmpdir, tmpdir as m25_tmpdir, tmpdir as m26_tmpdir, tmpdir as m30_tmpdir, tmpdir as m32_tmpdir, tmpdir as m34_tmpdir } from 'node:os';
export { join as m9_join, join as m24_join, join as m25_join, join as m26_join, join as m30_join, join as m32_join, join as m34_join } from 'node:path';
export { REQUESTABLE_AGENT_GRANT_KINDS as m9_REQUESTABLE_AGENT_GRANT_KINDS } from '@beeline/api-contract/agent-grants';
export { resolveGrantCommand as m9_resolveGrantCommand } from './grant-script.js';
export { approvedDeviceGrant as m9_approvedDeviceGrant, pendingGrantToolCall as m14_pendingGrantToolCall, resumePrompt as m14_resumePrompt } from './monolith-room-turn.js';
export { MESSAGE_REACTION_EMOJIS as m10_MESSAGE_REACTION_EMOJIS } from '@beeline/api-contract/phone';
export { assembleTurnPrompt as m24_assembleTurnPrompt } from './prompt-assembly.js';
export { CommandExecutionContext as m26_CommandExecutionContext, CommandExecutionContext as m32_CommandExecutionContext } from './server-command-intake.js';
export { beelineManagedSkills as m28_beelineManagedSkills } from './beeline-skill.js';
export type { AgentGrantDeps as m7_AgentGrantDeps, AgentScheduleDeps as m8_AgentScheduleDeps, AgentGrantDeps as m9_AgentGrantDeps, GrantRunDeps as m9_GrantRunDeps, AgentScheduleDeps as m10_AgentScheduleDeps, AgentScheduleDeps as m11_AgentScheduleDeps, ConnectorOfferDeps as m14_ConnectorOfferDeps, PostArtifactDeps as m34_PostArtifactDeps } from './read-only-mcp.js';
export type { PromptSurface as m24_PromptSurface } from './prompt-assembly.js';
export type { AgentCommand as m26_AgentCommand, AgentCommand as m32_AgentCommand } from '@beeline/api-contract/daemon';
