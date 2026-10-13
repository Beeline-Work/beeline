// Render the shipped waveform with injected input levels. This is a component
// proof, not a production microphone or authentication test.
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(mobile, '../../.scratch/waveform-proof');
await mkdir(output, { recursive: true });
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { DictationWaveform } from '${mobile}/sources/components/buzz/DictationWaveform';
import { dictationWaveformLevel, voiceWaveformLevel } from '${mobile}/sources/buzz/waveform-level';
const inputs = [
  ['Silence', -2, 0], ['Quiet', 12, 0.01], ['Normal', 20, 0.1], ['Loud', 30, 0.562341325],
];
createRoot(document.getElementById('root')).render(<main style={{padding:32,color:'#f0f0f3',fontFamily:'sans-serif'}}>
  <h1>Beeline waveform — injected volume proof</h1>
  <p>Actual shared component; fixed input values, no physical microphone.</p>
  {['dictation', 'voice'].map(source => <section key={source}><h2>{source}</h2>
    {inputs.map(([label, rms, amplitude]) => <div key={label} style={{marginBottom:20}}>
      <div>{label} · raw {source === 'dictation' ? rms + ' Android RMS dB' : amplitude + ' linear amplitude'}</div>
      <View style={{width:300,flexDirection:'row'}}><DictationWaveform live level={source === 'dictation' ? dictationWaveformLevel(rms, 'android') : voiceWaveformLevel(amplitude)} testID={source + '-' + label}/></View>
    </div>)}
  </section>)}
</main>);
`;
const result = await build({
  stdin: { contents: entry, loader: 'tsx', resolveDir: mobile },
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'waveform-proof', setup(api) {
    api.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(mobile, 'node_modules/react-native-web/dist/index.js') }));
    api.onResolve({ filter: /^react-native-unistyles$/ }, () => ({ path: 'theme', namespace: 'proof' }));
    api.onLoad({ filter: /.*/, namespace: 'proof' }, () => ({ contents: `export const StyleSheet = {create: fn => fn({buzz:{accent:'#b08a4a',textMuted:'#83838d'}})};`, loader: 'js' }));
    api.onResolve({ filter: /^@\// }, args => ({ path: path.join(mobile, 'sources', args.path.slice(2) + '.ts') }));
  }}],
});
const bundle = result.outputFiles[0].text;
await writeFile(path.join(output, 'bundle.js'), bundle);
const html = '<!doctype html><html><head><meta charset="utf-8"><title>Waveform volume proof</title></head><body style="background:#14091A;margin:0"><div id="root"></div><script src="/bundle.js"></script></body></html>';
await writeFile(path.join(output, 'index.html'), html);
createServer((request, response) => {
  response.setHeader('Content-Type', request.url === '/bundle.js' ? 'text/javascript' : 'text/html');
  response.end(request.url === '/bundle.js' ? bundle : html);
}).listen(4189, '127.0.0.1', () => console.info('Waveform proof: http://127.0.0.1:4189'));
