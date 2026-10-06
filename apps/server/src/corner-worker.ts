/**
 * The corner's CURRENT implementer: the agent a person last addressed in the
 * corner, or the agent the person asked the corner's agent to hand it to
 * (`corner_facts.worker_agent_id`, set by `routeHumanMessage` and
 * `routeAgentResult`), falling back to the opener for a corner nobody has
 * redirected.
 *
 * `owner_agent_id` is the historical opener and never moves, so every
 * worker-scoped read — a lifecycle wake, the merge gate's yolo mode — must go
 * through this expression instead of reading the opener directly. A person
 * tagging another agent in a corner is how the implementer role moves, and an
 * agent the person asked to hand the corner on moves it the same way by
 * tagging the other agent in its reply; the corner lifecycle's `implementer`
 * binding follows the same fact.
 *
 * `factAlias` names the `corner_facts` alias and `cornerAlias` the alias of
 * the corner's own `rooms` row.
 */
export function cornerImplementerSql(factAlias: string, cornerAlias: string): string {
  return `COALESCE(${factAlias}.worker_agent_id,${factAlias}.owner_agent_id,${cornerAlias}.created_by)`;
}
