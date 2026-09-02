const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '../sources/app');
const outputDir = path.resolve(__dirname, '../.expo/types');

// Expo creates this declaration while Metro starts. Typechecking must not rely
// on a developer having started Metro (or on a previous CI step) first.
process.env.EXPO_ROUTER_APP_ROOT = appRoot;
fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

const { regenerateDeclarations } = require('@expo/router-server/build/typed-routes');
regenerateDeclarations(outputDir);

// Expo debounces generation to coalesce Metro filesystem events. Keep this
// process alive until the debounced write completes, then fail closed if it did
// not produce the declaration TypeScript consumes.
setTimeout(() => {
  const declaration = path.join(outputDir, 'router.d.ts');
  if (!fs.statSync(declaration, { throwIfNoEntry: false })?.size) {
    throw new Error(`Expo Router did not generate ${declaration}`);
  }
}, 1_100);
