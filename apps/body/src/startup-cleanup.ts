import {
  findObsoleteAssetCopies,
  removeObsoleteAssetCopiesAtStartup,
} from './obsolete-agent-assets.js';
import { defaultSupervisorRoot, runningHelperPid } from './runtime.js';

/** Maintenance is a separate explicit operation; normal helper startup never hashes old caches. */
export async function runCleanupSharedHomeCommand(
  env: NodeJS.ProcessEnv = process.env,
  apply = false,
): Promise<string> {
  const root = defaultSupervisorRoot(env);
  if (apply && (await runningHelperPid(root)))
    throw new Error('cleanup --apply requires an explicitly stopped native helper');
  const copies = apply
    ? await removeObsoleteAssetCopiesAtStartup(root)
    : await findObsoleteAssetCopies(root);
  return `${apply ? 'removed' : 'reclaimable'}: ${copies.length} exact cache copies; ${copies.reduce((sum, item) => sum + item.apparentBytes, 0)} apparent bytes; ${copies.reduce((sum, item) => sum + item.uniqueBytes, 0)} hardlink-aware unique bytes`;
}
