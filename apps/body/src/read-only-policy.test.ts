
// R-SURFACE-DRIFT: the legacy auto-allow list behind isBeelineAgentMcpPermissionRequest is written by hand and has
// drifted from the advertised beeline-agent tools. This ratchet pins today's drift so it can only shrink: a new
// advertised tool missing from the list, or a new list name nothing advertises, fails here. It changes no permission.
import { describe as move3_describe, expect as move3_expect, it as move3_it } from 'vitest';

import { CAPABILITY_ROUTES as move3_CAPABILITY_ROUTES, REPOSITORY_ROUTES as move3_REPOSITORY_ROUTES, RUNNER_TOOL as move3_RUNNER_TOOL, SCRATCH_ROUTES as move3_SCRATCH_ROUTES, SILENT_TOOL as move3_SILENT_TOOL, minimalTools as move3_minimalTools, repositoryTools as move3_repositoryTools, scratchTools as move3_scratchTools } from "./minimal-tool-surface.js";

import { BEELINE_AGENT_MCP_SERVER_NAME as move3_BEELINE_AGENT_MCP_SERVER_NAME, isBeelineAgentMcpPermissionRequest as move3_isBeelineAgentMcpPermissionRequest } from "./read-only-policy.js";
import { describe as movedDescribe3 } from 'vitest';
movedDescribe3("read-only-policy.drift.test.ts", () => {


const listed = (tool: string) => move3_isBeelineAgentMcpPermissionRequest({ toolCall: { title: '', rawInput: { server: move3_BEELINE_AGENT_MCP_SERVER_NAME, tool } } } as never);


move3_describe('R-SURFACE-DRIFT: AGENT_SURFACE_TOOL_NAMES vs the advertised tools', () => {
  const advertised = [...new Set([...move3_minimalTools(true), ...move3_minimalTools(false), move3_RUNNER_TOOL, move3_SILENT_TOOL, ...move3_scratchTools(true), ...move3_repositoryTools()]
    .map(tool => tool.name))].sort();
  const aliases = new Set([...Object.values(move3_REPOSITORY_ROUTES), ...Object.values(move3_SCRATCH_ROUTES),
    ...Object.values(move3_CAPABILITY_ROUTES).flatMap(routes => Object.values(routes))]);
  move3_it('lists no new advertised tool as missing', () => {
    move3_expect(advertised.filter(name => !listed(name))).toEqual([
      'close_corner_pr', 'dispatch_release', 'notify_feedback_fixed', 'read_operator_system_dm', 'record_merge_yes', 'report_feedback',
      'repository_io', 'send_operator_system_dm',
    ]);
  });
  move3_it('keeps no new name that nothing advertises', () => {
    const legacy = ['get_avatar', 'set_avatar', 'pr_checks_status', 'write_scratch_file', 'scratch_status', 'fetch_image', 'connect_app', 'find_connectors'];
    move3_expect(legacy.filter(listed)).toEqual(legacy);
    // Each legacy name is at most an internal alias, never a bare advertised tool.
    move3_expect(legacy.filter(name => advertised.includes(name))).toEqual([]);
    move3_expect(legacy.filter(name => !aliases.has(name)).sort()).toEqual(['connect_app', 'find_connectors', 'pr_checks_status']);
  });
});
});
