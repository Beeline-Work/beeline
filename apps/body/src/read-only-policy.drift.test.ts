// R-SURFACE-DRIFT: the legacy auto-allow list behind isBeelineAgentMcpPermissionRequest is written by hand and has
// drifted from the advertised beeline-agent tools. This ratchet pins today's drift so it can only shrink: a new
// advertised tool missing from the list, or a new list name nothing advertises, fails here. It changes no permission.
import { describe, expect, it } from 'vitest';
import { CAPABILITY_ROUTES, REPOSITORY_ROUTES, RUNNER_TOOL, SCRATCH_ROUTES, SILENT_TOOL, minimalTools, repositoryTools, scratchTools } from './minimal-tool-surface.js';
import { BEELINE_AGENT_MCP_SERVER_NAME, isBeelineAgentMcpPermissionRequest } from './read-only-policy.js';

const listed = (tool: string) => isBeelineAgentMcpPermissionRequest({ toolCall: { title: '', rawInput: { server: BEELINE_AGENT_MCP_SERVER_NAME, tool } } } as never);

describe('R-SURFACE-DRIFT: AGENT_SURFACE_TOOL_NAMES vs the advertised tools', () => {
  const advertised = [...new Set([...minimalTools(true), ...minimalTools(false), RUNNER_TOOL, SILENT_TOOL, ...scratchTools(true), ...repositoryTools()]
    .map(tool => tool.name))].sort();
  const aliases = new Set([...Object.values(REPOSITORY_ROUTES), ...Object.values(SCRATCH_ROUTES),
    ...Object.values(CAPABILITY_ROUTES).flatMap(routes => Object.values(routes))]);
  it('lists no new advertised tool as missing', () => {
    expect(advertised.filter(name => !listed(name))).toEqual([
      'close_corner_pr', 'dispatch_release', 'notify_feedback_fixed', 'read_operator_system_dm', 'record_merge_yes', 'report_feedback',
      'repository_io', 'send_operator_system_dm',
    ]);
  });
  it('keeps no new name that nothing advertises', () => {
    const legacy = ['get_avatar', 'set_avatar', 'pr_checks_status', 'write_scratch_file', 'scratch_status', 'fetch_image', 'connect_app', 'find_connectors'];
    expect(legacy.filter(listed)).toEqual(legacy);
    // Each legacy name is at most an internal alias, never a bare advertised tool.
    expect(legacy.filter(name => advertised.includes(name))).toEqual([]);
    expect(legacy.filter(name => !aliases.has(name)).sort()).toEqual(['connect_app', 'find_connectors', 'pr_checks_status']);
  });
});
