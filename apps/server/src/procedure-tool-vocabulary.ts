/** Present saved prose in the current tool vocabulary without changing its saved version.
 * This does not adapt executable calls: retired tools are refused by the MCP ingress.
 */
const calls: Record<string, string> = {
  workbench_status: 'connect(mode:status)',
  connectors_status: 'connect(mode:status)',
  connect_app: 'connect(mode:ensure,service,reason,continuation)',
  list_app_tools: 'app_tool(app)',
  execute_app_tool: 'app_tool(app,tool,args)',
  save_skill: 'remember(kind:procedure,action:save,slug,description,markdown)',
  delete_skill: 'remember(kind:procedure,action:delete,slug,version,source_message_ids)',
  save_memory: 'remember(kind:fact,action:save)',
  update_memory: 'remember(kind:fact,action:update)',
  delete_memory: 'remember(kind:fact,action:delete)',
  search_memory: 'search(scope:memory,query)',
  report_memory_used: 'remember(kind:fact,action:used)',
  save_workflow: 'app_tool(app:beeline:workflow,tool:save,args:{contract})',
  start_workflow: 'app_tool(app:beeline:workflow,tool:start,args:{name,roleBindings})',
  get_workflow_run: 'app_tool(app:beeline:workflow,tool:read,args:{runId})',
  cancel_workflow_run: 'app_tool(app:beeline:workflow,tool:cancel,args:{runId,reason})',
  list_schedules: 'wake(action:list)',
  create_schedule: 'wake(action:create,trigger:schedule,cadence,prompt,maxRuns)',
  update_schedule: 'wake(action:update,trigger:schedule,scheduleId)',
  delete_schedule: 'wake(action:delete,trigger:schedule,scheduleId)',
  revise_corner_brief: 'revise_corner(action:brief,address,brief,expectedRevision,change)',
};

export function procedureToolVocabulary(markdown: string): string {
  let changed = false;
  const lines = markdown.split('\n').map(line => {
    const original = line;
    if (/state_check|(?:invalid|nonexistent|non-existent).*\bhandoff\b/.test(line)) {
      changed = true;
      return 'Read current workflow state with app_tool(app:beeline:workflow,tool:read,args:{runId}); never probe state with a mutation.';
    }
    if (/start_workflow.*(?:not reliably|unreliable|does not.*wake)/i.test(line)) {
      changed = true;
      return 'Workflow start dispatches its first state. Read the returned run and attempt; advance only after completing the state you own.';
    }
    if (/grant_inbox_consent\s*[:=]\s*true/.test(line)) {
      changed = true;
      return 'Follow the mounted inbox tool’s actual needs_user or approval response and account scope. An unavailable human step is a blocker; a consent flag never grants another owner’s access.';
    }
    if (/(?:still blocked|hand off).*\bmachine/i.test(line)) {
      changed = true;
      return 'Report the verified capability gap to your commander; order another agent at an explicit address only when delegation is authorized or that gap is verified.';
    }
    line = line.replace(/\blist_credentials\b/g, 'when Squire is mounted and relevant, list_credentials');
    line = line.replace(/report\(kind:\s*feedback\s*,?/g, 'report_feedback(');
    let next = line.replace(/\b[a-z]+(?:_[a-z]+)+\b/g, name => calls[name] ?? name);
    next = next.replace(/\bhandoff(?=\s*\(|`|\s+on\b)|(?<=call\s)handoff\b/g, 'app_tool(app:beeline:workflow,tool:advance,args:{runId,outcome,contents,attempt})');
    if (next !== original) changed = true;
    return next;
  });
  if (!changed) return markdown;
  return [
    'Do assigned work yourself unless told to delegate or a verified capability gap requires it.',
    'Current tool schemas govern every call. Discover first-party operations with app_tool(app). Supply address for every addressed mutation; use headSha, app and args. An assignment owes report(status,text); product feedback uses report_feedback(category,summary).',
    'For browser work drive one session; on an explicit saved-login handback inspect the mounted login schema and supply every required load_saved field. Repair refused arguments instead of repeating them. Follow actual approval responses. Recheck connect after needs_squire.',
    ...lines,
  ].join('\n');
}
