import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBrowserProof, webProofShims } from '../sources/test/browserProof.ts';

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(mobile, 'evidence/store-update'));
await mkdir(out, { recursive: true });
let fonts = '';
for (const font of ['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium', 'SpaceGrotesk-SemiBold', 'IBMPlexMono-Regular']) {
  const bytes = await readFile(path.join(mobile, 'sources/assets/fonts', `${font}.ttf`));
  fonts += `@font-face{font-family:'${font}';src:url(data:font/ttf;base64,${bytes.toString('base64')})}`;
}
for (const theme of ['bone', 'obsidian']) {
  for (const platform of ['android', 'ios']) {
    const shims = webProofShims(mobile);
    shims['react-native-unistyles'] = shims['react-native-unistyles'].replace('beelineThemes.obsidian', `beelineThemes.${theme}`)
      .replace('const theme = { buzz:', `const theme = { dark: ${theme === 'obsidian'}, buzz:`);
    shims['expo-application'] = 'export const nativeApplicationVersion = "0.2.22";';
    shims['@/buzz/runtime-config'] = 'export const getBuzzRuntimeConfig = () => ({monolithUrl:"https://unused.test"});';
    shims['react-native-safe-area-context'] = `import React from 'react'; import { View } from 'react-native';
      export const SafeAreaView = props => <View {...props} />;
      export const useSafeAreaInsets = () => ({top:0,bottom:0,left:0,right:0});`;
    const result = await runBrowserProof({ mobile, entry: path.join(mobile, 'scripts/store-update-web-entry.tsx'),
      shims, width: platform === 'ios' ? 393 : 412, height: platform === 'ios' ? 852 : 915,
      query: `?platform=${platform}`, screenshotPath: path.join(out, `${platform}-${theme}-web-standin.png`),
      head: `<meta name="viewport" content="width=device-width,initial-scale=1"><style>${fonts}html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}#result{display:none}</style>`,
    });
    if (result.result !== 'rendered' || result.status !== 0) throw new Error(JSON.stringify(result));
    console.log(`${platform} ${theme}: rendered`);
  }
}
