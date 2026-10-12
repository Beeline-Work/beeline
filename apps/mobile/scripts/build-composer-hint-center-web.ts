import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { webProofShims } from '../sources/test/browserProof';
async function buildProof() {
  const mobile = process.cwd();
  const directory = path.join(mobile, 'evidence/composer-hint-center/local/web');
  const shims: Record<string, string> = { ...webProofShims(mobile),
    '@/constants/Typography': 'export const Typography = { default: () => ({}) };',
    'expo-constants': 'export default { expoConfig: { extra: { app: {} } } };',
    './speech-transcription': 'export const dictationTranscriptionAvailable = () => false; export const discardDictationRecordings = async () => {}; export const startDictationUpload = () => undefined;',
    './speech-recognition-adapter': 'export const getRecognitionModule = () => null;',
    './speech-locale': "export const getDeviceSpeechLocale = () => 'en-US';",
    'react-native-unistyles': `import { beelineThemes } from '${path.join(mobile, 'sources/buzz/groknight')}';
      const theme = { buzz: beelineThemes.bone };
      export const StyleSheet = { create: factory => typeof factory === 'function' ? factory(theme) : factory, hairlineWidth: 1 };
      export const useUnistyles = () => ({ theme });`,
  };
  await build({ entryPoints: ['scripts/composer-hint-center-web.tsx'], outfile: directory+'/bundle.js',
    bundle: true, platform: 'browser', jsx: 'automatic', mainFields: ['browser','module','main'],
    resolveExtensions: ['.web.tsx','.web.ts','.web.js','.tsx','.ts','.js','.json'],
    loader: { '.js':'jsx','.ttf':'dataurl' }, define: { 'process.env.NODE_ENV':'"development"', 'process.env.EXPO_OS':'"web"', __DEV__:'true', global:'globalThis' },
    plugins: [{ name: 'proof', setup(api) {
      api.onResolve({filter:/.*/}, ({path: requested}) => {
        if (requested in shims) return {path:requested,namespace:'shim'};
        if (requested==='react-native') return {path:path.join(mobile,'node_modules/react-native-web/dist/index.js')};
        if (requested.startsWith('@/')) return {path:path.join(mobile,'sources',requested.slice(2)),namespace:'alias'};
      });
      api.onResolve({filter:/.*/,namespace:'alias'}, () => undefined);
      api.onLoad({filter:/.*/,namespace:'shim'}, ({path: requested}) => ({contents:shims[requested],loader:'tsx',resolveDir:mobile}));
      api.onLoad({filter:/.*/,namespace:'alias'}, ({path: requested}) => {
        for (const ext of ['','.web.ts','.web.tsx','.ts','.tsx','/index.ts','/index.tsx']) {
          try { return {contents:readFileSync(requested+ext,'utf8'),loader:'tsx',resolveDir:path.dirname(requested+ext)}; } catch {}
        }
      });
    }}] });
  const font = readFileSync('sources/assets/fonts/SpaceGrotesk-Regular.ttf').toString('base64');
  const mono = readFileSync('sources/assets/fonts/IBMPlexMono-Regular.ttf').toString('base64');
  writeFileSync(directory+'/index.html', `<!doctype html><meta charset="utf-8"><style>
  @font-face{font-family:SpaceGrotesk-Regular;src:url(data:font/ttf;base64,${font})}
  @font-face{font-family:IBMPlexMono-Regular;src:url(data:font/ttf;base64,${mono})}
  html,body{margin:0;background:#F3EEE4}</style><div id="root"></div><script src="bundle.js"></script>`);

}
void buildProof();
