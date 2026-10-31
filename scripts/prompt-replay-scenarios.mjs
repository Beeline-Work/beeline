/** Replay-only adapters. Read recorded facts; never execute an operation. */
import { CAPABILITY_TOOLS, CAPABILITY_ROUTES } from '../apps/body/src/minimal-tool-surface.ts';
import { scenarioResult, validSchema } from './prompt-nightly.mjs';

export function replayScenarioResult(testCase, call, skills) {
  const recorded = scenarioResult(testCase, call, skills);
  if (recorded.boundary !== 'missing') return recorded;
  const state = testCase.scenario ?? {};
  if (call.name === 'app_tool') {
    const capability = call.args.app?.replace(/^beeline:/, '');
    const catalog = CAPABILITY_TOOLS[capability];
    if (catalog && !call.args.tool) return { result: { app: call.args.app, tools: Object.values(catalog) } };
    const tool = catalog?.[call.args.tool];
    if (tool && !validSchema(tool.inputSchema, call.args.args)) return { result: { error: 'Arguments do not match the discovered app operation schema' }, invalidSchema: true };
    if (tool && validSchema(tool.inputSchema, call.args.args)) {
      const alias = CAPABILITY_ROUTES[capability]?.[call.args.tool];
      const result = scenarioResult(testCase, { name: alias, args: call.args.args }, skills);
      if (result.boundary !== 'missing') return { ...result, adapter: alias };
    }
  }
  if (call.name === 'read' && call.args.facet === 'pr') {
    if (Object.hasOwn(state, 'pr')) return { result: state.pr };
    // A recorded null is a fact; absence must never become an invented PR.
    if (Object.hasOwn(state.checks ?? {}, 'pullRequest')) return { result: state.checks.pullRequest };
    for (const entry of state.results ?? []) {
      if (entry.call !== 'Bash' || typeof entry.args?.command !== 'string' ||
          !/^gh pr view\b/.test(entry.args.command) || !entry.args.command.includes('--json')) continue;
      const number = /^gh pr view\s+(\d+)\b/.exec(entry.args.command)?.[1];
      if (number && call.args.pullRequest !== undefined && String(call.args.pullRequest) !== number) continue;
      try { return { result: JSON.parse(entry.result.stdout), adapter: 'recorded gh pr view' }; }
      catch { /* An unparseable recorded result supplies no PR fact. */ }
    }
  }
  // Unsupported actions have an explicit refusal boundary, not fabricated
  // success or an infrastructure exclusion. The unchanged rule grades the
  // actual calls and reply once the model completes this simulated turn.
  return { result: { error: 'Unsupported operation in recorded replay facts; nothing was executed or changed.',
    operation: call.name, ...(call.name === 'record_merge_yes' ? { recorded: false } : {}) },
    boundary: 'unsupported-operation', unsupported: true };
}
