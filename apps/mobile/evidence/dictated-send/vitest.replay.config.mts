import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import base from '../../vitest.config';
const source = process.env.DICTATION_SOURCE === 'main'
  ? process.env.DICTATION_BASELINE_SOURCE!
  : resolve('sources');
const regression = process.env.DICTATION_REGRESSIONS === '1';
const relativeAliases = regression ? Object.fromEntries(['speech-input', 'speech-transcription', 'speech-recognition-adapter', 'speech-locale', 'client-error-report', 'runtime-config', 'speech-correction', 'waveform-level'].map(name => [`./${name}`, resolve(source, `buzz/${name}.ts`)])) : {};
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: regression ? ['sources/buzz/speech-input.test.ts', 'sources/buzz/speech-transcription.test.ts'] : ['evidence/dictated-send/replay.proof.tsx'],
    testTimeout: 240_000,
    hookTimeout: 60_000,
    maxWorkers: 1,
  },
  resolve: { ...base.resolve, alias: { ...base.resolve?.alias, ...relativeAliases, '@': source, react: resolve('node_modules/react') } },
});
