/**
 * Per-client Trusty Squire façade. Spawned from a rewritten isolated-home
 * declaration. Connects to the host broker socket; never elects.
 */
import { runSquireFacade } from './squire-host.js';
import { runSquireTaskProxy } from './squire-task-relay.js';

const entry = process.argv[1]?.replace(/\\/g, '/');
if (entry && /squire-facade\.(c?js|ts)$/.test(entry)) {
  if (process.env.BEELINE_SQUIRE_RELAY_URL) runSquireTaskProxy(process.env);
  else await runSquireFacade(process.env);
}
