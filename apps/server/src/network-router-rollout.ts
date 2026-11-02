/** One temporary server-first rollout setting. Protocol capabilities still
 * negotiate separately; a selected operation never falls back on failure.
 * Keep disabled until every required source/cohort proof passes. The router-only
 * removal change deletes this setting after all operation paths migrate. */
export const networkRouterEnabled = (): boolean => process.env.BEELINE_NETWORK_ROUTER_V1 === '1';
