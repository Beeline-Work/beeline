import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(here, '../../apps/mobile');
const mobileNodeModules = process.env.MOBILE_NODE_MODULES ?? path.join(mobileRoot, 'node_modules');
const nodePaths = [mobileNodeModules];
const artifactServiceStubs = new Set([
  '@/buzz/artifact-preview-cache', '@/buzz/artifact-pdf', '@/buzz/artifact-link',
  '@/buzz/chat-attachment', '@/buzz/desktop-artifact-pane',
  '@/components/buzz/artifact-webview', '@/components/buzz/sandbox-webview',
  '@/components/buzz/ArtifactPdfView', '@/components/buzz/ArtifactViewer',
  '@/components/buzz/ChevronGlyph', '@/components/buzz/MonoMarkdown', '@/modal',
]);

await build({
  entryPoints: [path.join(here, 'app.tsx')],
  bundle: true,
  define: {
    'process.env.NODE_ENV': '"development"',
    'process.env.JEST_WORKER_ID': 'undefined',
    __DEV__: 'true',
    global: 'globalThis',
  },
  outfile: path.join(here, 'bundle.js'),
  platform: 'browser',
  conditions: ['browser', 'import', 'default'],
  mainFields: ['browser', 'module', 'main'],
  resolveExtensions: [
    '.web.tsx',
    '.web.ts',
    '.web.jsx',
    '.web.js',
    '.tsx',
    '.ts',
    '.jsx',
    '.js',
    '.json',
  ],
  format: 'iife',
  nodePaths,
  jsx: 'automatic',
  sourcemap: false,
  plugins: [
    {
      name: 'prior-web-entrance',
      setup(buildApi) {
        if (!process.env.PROOF_OLD_WEB_ENTRANCE) return;
        buildApi.onLoad({ filter: /MonoHull\.tsx$/ }, async (args) => {
          const source = await readFile(args.path, 'utf8');
          const current = "Platform.OS !== 'web' && enabled &&";
          if (!source.includes(current)) throw new Error('Web entrance guard changed');
          return {
            contents: source.replace(current, 'enabled &&'),
            loader: 'tsx',
            resolveDir: path.dirname(args.path),
          };
        });
      },
    },
    {
      name: 'production-photo-card',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^@proof\/photo-card$/ }, () => ({
          path: 'photo-card', namespace: 'production-photo-card',
        }));
        buildApi.onLoad({ filter: /.*/, namespace: 'production-photo-card' }, async () => {
          const source = await readFile(path.join(mobileRoot,
            'sources/app/(app)/beeline/chat/RoomMessageVariants.tsx'), 'utf8');
          const start = source.indexOf('function AttachmentCard({');
          const end = source.indexOf('\nfunction SwipeToReply(', start);
          const stylesStart = source.indexOf('  attachmentCard: {', end);
          const stylesEnd = source.indexOf('  // Notification lifecycle card accordion', stylesStart);
          if ([start, end, stylesStart, stylesEnd].some((index) => index < 0)) {
            throw new Error('The production AttachmentCard source changed; update the proof extraction');
          }
          const card = source.slice(start, end).replace('function AttachmentCard(', 'export function AttachmentCard(');
          const cardStyles = source.slice(stylesStart, stylesEnd);
          return {
            loader: 'tsx', resolveDir: here,
            contents: `import React, { useEffect, useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '../../apps/mobile/sources/constants/Typography';
import { formatAttachmentSize, openArtifactInDesktopWorkPane, ArtifactViewerScreen, Modal } from './artifact-proof-deps';
type AttachmentReference = any;
const getBuzzRuntimeConfig = () => ({ monolithEnabled: false });
const monolithSession = { authorization: async () => '' };
const openExternalUrl = async (_url: string) => {};
const attachmentOpenUrl = (_attachment: AttachmentReference) => '';
const showPictureActions = (_attachment: AttachmentReference) => {};
const styles = StyleSheet.create((theme) => ({
${cardStyles}
}));
${card}`,
          };
        });
      },
    },
    {
      name: 'rnw-shim',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^react-native-unistyles$/ }, () => ({
          path: path.join(here, 'unistyles-proof.ts'),
        }));
        buildApi.onResolve({ filter: /^@\// }, (args) => {
          if (artifactServiceStubs.has(args.path)) {
            return { path: path.join(here, 'artifact-proof-deps.tsx') };
          }
          const source = path.join(mobileRoot, 'sources', args.path.slice(2));
          return { path: existsSync(`${source}.tsx`) ? `${source}.tsx` : `${source}.ts` };
        });
        buildApi.onResolve({ filter: /^react-native$/ }, () => ({
          path: path.join(mobileNodeModules, 'react-native-web/dist/index.js'),
        }));
        buildApi.onResolve({ filter: /^react-native-svg$/ }, () => ({
          path: path.join(mobileNodeModules, 'react-native-svg/lib/module/ReactNativeSVG.web.js'),
        }));
      },
    },
  ],
});

await writeFile(
  path.join(here, 'index.html'),
  `<!doctype html><html><head><meta charset="utf-8"><title>desktop append overlap repro</title>
<style>html,body{margin:0;background:#0b0b10;}#root{padding:8px;}</style></head>
<body><div id="root"></div>
<pre id="log" style="color:#9fe29f;font:11px monospace;padding:8px;white-space:pre-wrap;"></pre>
<pre id="status" style="color:#e2b89f;font:11px monospace;padding:0 8px;"></pre>
<script src="bundle.js"></script></body></html>`,
);
console.log('built');
