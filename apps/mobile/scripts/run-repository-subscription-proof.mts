import path from 'node:path';
import { runBrowserProof, webProofShims } from '../sources/test/browserProof';
const mobile = process.cwd();
const shims = webProofShims(mobile);
shims['expo-router'] = 'export const router = {}; export const useRouter = () => ({}); export const useLocalSearchParams = () => ({});';
shims['./HullActionSheet'] = 'export const HullActionSheetModal = () => null; export const HullActionSheetRow = () => null; export const HULL_SHEET_INSET = 22;';
const result = await runBrowserProof({ mobile, shims, width: 390,
  entry: path.join(mobile, 'scripts/repository-subscription-proof.tsx'),
  screenshotPath: path.join(mobile, 'evidence/repository-subscription/390-dark.png'),
});
console.log(result.result);
const { default: sharp } = await import('../../../node_modules/sharp/lib/index.js');
const image = path.join(mobile, 'evidence/repository-subscription/390-dark.png');
const cropped = await sharp(image).extract({ left: 0, top: 0, width: 390, height: 500 }).toBuffer();
await (await import('node:fs/promises')).writeFile(image, cropped);
if (result.status !== 0 || !result.result.startsWith('PASS')) throw Error(result.stderr || result.result);
