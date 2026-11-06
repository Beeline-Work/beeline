import { build } from 'esbuild';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Production artifact byte path; Node supplies native disk, session and identity seams. */
export async function phoneArtifactHost(principal: string, origin: string) {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const mobile = path.join(root, 'apps/mobile/sources');
  const proof = path.join(root, '.beeline-proof');
  await mkdir(proof, { recursive: true });
  const directory = await mkdtemp(path.join(proof, 'phone-artifact-'));
  const stubs: Record<string, string> = {
    'phone-proof-host': `export const host={bytes:new Map(),requests:[],operation:async()=>{throw Error('Missing metadata operation')},fetch:async(url,options)=>{host.requests.push(url);return globalThis.fetch(url,options);}};`,
    'react-native': `export const Platform={OS:'android'};`,
    'auth/buzz-identity-storage': `export const loadBuzzIdentity=async()=>({publicKey:${JSON.stringify(principal)}});`,
    'auth/monolith-session': `export const monolithSession={fetch:(url,options)=>host.fetch(url,options)};`,
    'buzz/runtime-config': `export const getBuzzRuntimeConfig=()=>({monolithUrl:${JSON.stringify(origin)}});`,
    'sync/transport/monolith-operation': `export const monolithPhoneOperation=(name,args)=>host.operation(name,args);`,
    'buzz/artifact-byte-store': `export const createArtifactByteStore=()=>({get:async key=>host.bytes.get(key)??null,set:async(key,value)=>host.bytes.set(key,value),
      remove:async key=>host.bytes.delete(key),clear:async()=>host.bytes.clear(),revoke:async()=>[],localUri:async key=>host.bytes.has(key)?'file:///synthetic/image.png':null});`,
    'modal': `export const Modal={alert(){throw Error('Unexpected modal')}};`,
    'utils/open-external-url': `export const openExternalUrl=()=>{throw Error('Unexpected browser')};`,
  };
  const outfile = path.join(directory, 'phone.mjs');
  try {
    const result = await build({
      stdin: { contents: `export {host} from 'phone-proof-host';
        export {artifactImageSource,artifactLocalUri} from './apps/mobile/sources/buzz/artifact-link';;`, resolveDir: root },
      outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', metafile: true,
      plugins: [{ name: 'artifact-native-host', setup(context) {
        context.onResolve({ filter: /.*/ }, args => {
          let name = args.path;
          if (name.startsWith('@/')) name = name.slice(2);
          else if (name.startsWith('.')) name = path.relative(mobile, path.resolve(args.resolveDir, name)).replace(/\.ts$/, '');
          if (Object.hasOwn(stubs, name)) return { path: name, namespace: 'host' };
          if (args.path.startsWith('@/')) return { path: path.join(mobile, `${name}.ts`) };
        });
        context.onLoad({ filter: /.*/, namespace: 'host' }, args => ({ contents:
          (args.path === 'phone-proof-host' ? '' : "import {host} from 'phone-proof-host';\n") + stubs[args.path]!, loader: 'js' }));
      } }],
    });
    for (const name of ['immutable-byte-cache.ts', 'artifact-byte-owner.ts', 'artifact-link.ts', 'media-cache-connection.ts'])
      if (!Object.keys(result.metafile!.inputs).some(input => input.endsWith(`/` + name))) throw new Error(`Missing production source ${name}`);
    return { phone: await import(/* @vite-ignore */ pathToFileURL(outfile).href), close: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
