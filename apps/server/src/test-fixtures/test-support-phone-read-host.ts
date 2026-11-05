import { build } from 'esbuild';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Bundle the production socket client; stub only the native host and UI caches. */
export async function phoneReadHost() {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const mobile = path.join(root, 'apps/mobile/sources');
  const proof = path.join(root, '.beeline-proof');
  await mkdir(proof, { recursive: true });
  const directory = await mkdtemp(path.join(proof, 'phone-read-'));
  const stubs: Record<string, string> = {
    'react': `export const useSyncExternalStore=()=>{throw Error('UI hook outside proof host');};`,
    'react-native': `export const AppState={currentState:'active',addEventListener:()=>({remove(){}})};
      export const Platform={OS:'web'},NativeModules={};`,
    'auth/monolith-session': `export class MonolithRequestTimeoutError extends Error{constructor(){super('Read timed out');this.name='MonolithRequestTimeoutError';}}
      export class MonolithSessionChangedError extends Error{}
      export const monolithSession={authorization:async()=>{throw Error('Use the proof connection');},invalidateAuthorization(){}};`,
    'buzz/runtime-config': `export const getBuzzRuntimeConfig=()=>({monolithUrl:'http://localhost'});`,
    'buzz/room-corner-store': `export const acceptCornerStatusFrame=()=>true,noteCornerLaneReleased=()=>{},
      noteCornerLaneSubscribed=()=>{},noteCornerSocketDropped=()=>{},noteRoomCornersChanged=()=>{};`,
    'buzz/room-draw-barrier': `export const waitForRoomDraw=()=>undefined;`,
    'buzz/room-open-trace': `export const markRoomOpen=()=>{};`,
  };
  const outfile = path.join(directory, 'phone.mjs');
  try {
    const result = await build({
      stdin: { contents: `export {LiveConnection} from './apps/mobile/sources/sync/transport/live-connection';`, resolveDir: root },
      outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', metafile: true,
      plugins: [{ name: 'phone-native-host', setup(context) {
        context.onResolve({ filter: /.*/ }, args => {
          let name = args.path;
          if (name.startsWith('@/')) name = name.slice(2);
          else if (name.startsWith('.')) name = path.relative(mobile, path.resolve(args.resolveDir, name)).replace(/\.ts$/, '');
          if (Object.hasOwn(stubs, name)) return { path: name, namespace: 'host' };
          if (args.path.startsWith('@/')) return { path: path.join(mobile, `${name}.ts`) };
        });
        context.onLoad({ filter: /.*/, namespace: 'host' }, args => ({ contents: stubs[args.path]!, loader: 'js' }));
      } }],
    });
    if (!Object.keys(result.metafile!.inputs).some(input => input.endsWith('/live-connection.ts')))
      throw new Error('Missing production socket client');
    return { phone: await import(/* @vite-ignore */ pathToFileURL(outfile).href),
      close: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
