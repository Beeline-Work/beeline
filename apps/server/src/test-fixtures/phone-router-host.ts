import { build } from 'esbuild';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Node host seams only: production navigation owner and router lanes are bundled from source. */
export async function phoneRouterHost(principal: string) {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const mobile = path.join(root, 'apps/mobile/sources');
  const proof = path.join(root, '.beeline-proof');
  await mkdir(proof, { recursive: true });
  const directory = await mkdtemp(path.join(proof, 'phone-router-'));
  const stubs: Record<string, string> = {
    'phone-proof-host': `export const host={origin:'https://synthetic.test',groups:new Map()};`,
    'react-native': `export const AppState={currentState:'active',addEventListener:()=>({remove(){}})};export const Platform={OS:'android'};`,
    'auth/buzz-identity-storage': `export const loadBuzzIdentity=async()=>({publicKey:${JSON.stringify(principal)}});export const getEffectiveRelayUrl=async()=>host.origin;`,
    'buzz/surface-storage': `export const routerAuthorityStorageReady=()=>true,routerCommandStorageReady=()=>true;
      export const routerLaneStorage=()=>({write:async(key,value)=>host.groups.set(key,value),remove:async key=>host.groups.delete(key),
        fence:async()=>{},floor:async()=>{},subscribeFloors:()=>()=>{},subscribeFences:()=>()=>{}});`,

  };
  const outfile = path.join(directory, 'phone.mjs');
  try {
    const result = await build({
      stdin: { contents: `export { host } from 'phone-proof-host';
        export * from './apps/mobile/sources/buzz/router-owner';`, resolveDir: root },
      outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', metafile: true,
      plugins: [{ name: 'phone-native-host', setup(context) {
        context.onResolve({ filter: /.*/ }, args => {
          let name = args.path;
          if (name.startsWith('@/')) name = name.slice(2);
          else if (name.startsWith('.')) name = path.relative(mobile, path.resolve(args.resolveDir, name)).replace(/\.ts$/, '');
          if (Object.hasOwn(stubs, name)) return { path: name, namespace: 'host' };
          if (args.path.startsWith('@/')) return { path: path.join(mobile, `${name}.ts`) };
          if (args.path === '@beeline/net/owner') return { path: path.join(root, 'packages/net/src/private/phone-owner.ts') };
        });
        context.onLoad({ filter: /.*/, namespace: 'host' }, args => ({ contents: (args.path === 'phone-proof-host' ? '' : "import {host} from 'phone-proof-host';\n") + stubs[args.path]!, loader: 'js' }));
      } }],
    });
    const inputs = Object.keys(result.metafile!.inputs);
    for (const name of ['router-owner.ts', 'batch-assembly.ts'])
      if (!inputs.some(input => input.endsWith(`/` + name))) throw new Error(`Missing production source ${name}`);
    // Host functions close over this module's exported host without a global namespace.
    const phone = await import(/* @vite-ignore */ pathToFileURL(outfile).href);
    return { phone, close: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
