import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';
describe.skipIf(!existsSync(CHROME))('Conversation composer pin row', () => {
  it.each(['obsidian', 'bone'].flatMap(theme => [390, 1280].flatMap(width => [false, true].map(long => ({ theme, width, long })))))('keeps pinned row and call controls in $theme at $width (long=$long)', async ({ theme, width, long }) => {
    const mobile = process.cwd();
    const shims = webProofShims(mobile);
    shims['react-native-unistyles'] = shims['react-native-unistyles'].replace('beelineThemes.obsidian', `beelineThemes.${theme}`);
    shims['expo-image-manipulator'] = 'export const SaveFormat = {}; export const manipulateAsync = async () => {};';
    shims['expo-file-system/legacy'] = 'export const cacheDirectory = ""; export const EncodingType = {}; export const writeAsStringAsync = async () => {};';
    shims['@/utils/readFileBytes'] = 'export const readFileBytes = async () => new Uint8Array([116,101,115,116]);';
    shims['@/constants/Typography'] = 'export const Typography = { default: () => ({}) };';
    shims['./speech-recognition-adapter'] = 'export const getRecognitionModule = () => null;';
    shims['./speech-locale'] = "export const getDeviceSpeechLocale = () => 'en-US';";
    shims['./speech-transcription'] = 'export const dictationTranscriptionAvailable = () => false; export const startDictationUpload = () => null; export const discardDictationRecordings = async () => {};';
    const evidence = path.join(mobile, 'evidence/composer-pin-row');
    mkdirSync(evidence, { recursive: true });
    const { result, status, stderr } = await runBrowserProof({ mobile, shims, width,
      entry: path.join(mobile, 'scripts/composer-conversation-proof.tsx'), query: `?theme=${theme}${long ? '&long=1' : ''}`,
      head: `<style>#result{display:none}@font-face{font-family:SpaceGrotesk-Regular;src:url(data:font/ttf;base64,${readFileSync(path.join(mobile, 'sources/assets/fonts/SpaceGrotesk-Regular.ttf')).toString('base64')})}@font-face{font-family:SpaceGrotesk-SemiBold;src:url(data:font/ttf;base64,${readFileSync(path.join(mobile, 'sources/assets/fonts/SpaceGrotesk-SemiBold.ttf')).toString('base64')})}</style>`,
      screenshotPath: path.join(evidence, `web-${theme}-${width}${long ? '-long' : ''}.png`) });
    console.log(result);
    expect(status, stderr).toBe(0);
    expect(result).toContain('RESULT PASS');
  }, 90_000);
});
