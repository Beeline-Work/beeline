import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { it, expect } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from './browserProof';
// Exercise the private production swipe wrapper and byline together without
// importing the Room's unrelated server and navigation dependencies. Keep the
// third-party swipe style props on the real Unistyles web implementation:
// plain-object test styles conceal its non-enumerable property boundary.
it.skipIf(!existsSync(CHROME))(
  'R-onb-18: the live identity fits the production compact swipe clip',
  async () => {
    const mobile = process.cwd(),
      source = readFileSync(
        path.join(mobile, 'sources/app/(app)/beeline/chat/RoomMessageVariants.tsx'),
        'utf8',
      );
    const file = ts.createSourceFile(
      'row.tsx',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const swipe = file.statements.find(
      (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'SwipeToReply',
    )!;
    const names = new Set([...swipe.getText(file).matchAll(/styles\.(\w+)/g)].map((m) => m[1]));
    let properties: ts.ObjectLiteralElementLike[] = [];
    function visit(n: ts.Node) {
      if (
        ts.isVariableDeclaration(n) &&
        n.name.getText(file) === 'styles' &&
        n.initializer &&
        ts.isCallExpression(n.initializer)
      ) {
        const arrow = n.initializer.arguments[0];
        if (
          ts.isArrowFunction(arrow) &&
          ts.isParenthesizedExpression(arrow.body) &&
          ts.isObjectLiteralExpression(arrow.body.expression)
        )
          properties = [...arrow.body.expression.properties];
      }
      ts.forEachChild(n, visit);
    }
    visit(file);
    const style = properties
      .filter((p) => p.name && names.has(p.name.getText(file)))
      .map((p) => p.getText(file))
      .join(',');
    const dir = await mkdtemp(path.join(mobile, 'sources/test/onboarding-edge-proof-'));
    try {
      const entry = path.join(dir, 'entry.tsx');
      await writeFile(
        entry,
        `import React,{useCallback,useEffect,useRef,useState} from 'react';import{createRoot}from'react-dom/client';import{View,Text,Pressable,Platform}from'react-native';import{LedgerBylineView as Byline}from'@/components/buzz/Ledger';import{GestureHandlerRootView}from'react-native-gesture-handler';import ReanimatedSwipeable from'react-native-gesture-handler/ReanimatedSwipeable';import{StyleSheet}from'react-native-unistyles';import{TurnProgressLine}from'@/components/buzz/TurnProgressLine';import{IdentityMark}from'@/components/buzz/IdentityMark';import{ALIVE_RING_PAD}from'@/buzz/identity-mark';import{CornerGlyph}from'@/components/buzz/CornerGlyph';import{emojiTextStyle}from'@/buzz/emoji-text';import{Typography}from'@/constants/Typography';const CORNER_LABEL='corner';const MESSAGE_REACTION_EMOJIS=[];const DesktopMessageAction=()=>null;import{identityPalette,isGeneratedAgentAvatarUrl}from'@/buzz/identity-mark';const LEDGER_MARK_SIZE=26;const BYLINE_DOT_SIZE=5;const Ionicons=()=>null;const styles=StyleSheet.create(theme=>({${style}}));${swipe.getText(file)}
 createRoot(document.getElementById('root')!,{onUncaughtError:error=>{window.__console.push(String(error)+error.stack)}}).render(<GestureHandlerRootView style={{width:412,padding:16,backgroundColor:'#14091A'}}><SwipeToReply messageId="edge" isDesktop={false} onReply={()=>{}} onLongPress={()=>{}} onReact={()=>{}} onForward={()=>{}} onSwipeCorner={()=>{}}><View style={{paddingVertical:24}}><Byline byline={{name:'Beebee',role:'deepseek-v4.1',stamp:'20:12',onOpenProfile:()=>{},mark:{seed:'a'.repeat(64),kind:'agent',alive:true}}}/><Text style={{color:'#eee',fontFamily:'SpaceGrotesk-Regular',marginTop:12}}>Choose a repository to start working together.</Text></View></SwipeToReply><TurnProgressLine label="Beebee Mulling…" startedAt={Date.now()/1000-1} onStop={()=>{}} /></GestureHandlerRootView>);
 setTimeout(()=>{try{const tile=document.querySelector('[data-testid="chat-byline-mark"]')!;const ring=tile.lastElementChild!;const clip=document.querySelector('[data-testid="swipe-reply-edge"]')!.firstElementChild!;document.getElementById('result')!.textContent=JSON.stringify({tile:tile.getBoundingClientRect().left,ring:ring.getBoundingClientRect().left,clip:clip.getBoundingClientRect().left,overflow:getComputedStyle(clip).overflow,ancestors:(()=>{let n=tile.parentElement;const a=[];while(n){a.push({tag:n.tagName,left:n.getBoundingClientRect().left,overflow:getComputedStyle(n).overflow});n=n.parentElement;}return a;})()});}catch(error){document.getElementById('result')!.textContent=JSON.stringify({error:String(error),console:window.__console,html:document.getElementById('root')!.innerHTML});}},1000);`,
      );
      if (process.env.ONBOARDING_EDGE_ENTRY)
        await writeFile(
          process.env.ONBOARDING_EDGE_ENTRY,
          await import('node:fs/promises').then((fs) => fs.readFile(entry, 'utf8')),
        );
      const fontCss = ['SpaceGrotesk-Regular', 'SpaceGrotesk-SemiBold', 'IBMPlexMono-Regular']
        .map(
          (name) =>
            `@font-face{font-family:'${name}';src:url(data:font/ttf;base64,${readFileSync(path.join(mobile, 'sources/assets/fonts', name + '.ttf')).toString('base64')})}`,
        )
        .join('');
      const output = process.env.ONBOARDING_EDGE_EVIDENCE ?? '/tmp/onboarding-edge';
      mkdirSync(output, { recursive: true });
      const r = await runBrowserProof({
        entry,
        mobile,
        width: 412,
        height: 800,
        budgetMs: 5000,
        screenshotPath: path.join(output, 'edge.png'),
        head: `<script>window.addEventListener('error',e=>document.getElementById('result').textContent=JSON.stringify({crash:e.message}));</script><style>${fontCss}html,body,#root{width:412px;margin:0;background:#14091A}#result{display:none}</style>`,
        shims: {
          ...webProofShims(mobile),
          './MonoMarkdown': 'export const MonoMarkdown = () => null;',
          'react-native-unistyles': `import { beelineThemes } from '${path.join(mobile, 'sources/buzz/groknight')}'; import {StyleSheet as RealStyleSheet} from '${path.join(mobile, 'node_modules/react-native-unistyles/src/web/index.ts')}';const theme={buzz:beelineThemes.obsidian};RealStyleSheet.configure({themes:{proof:theme},settings:{initialTheme:'proof'}});export const StyleSheet={create:factory=>{const styles=typeof factory==='function'?factory(theme):factory;for(const key of Object.keys(styles)){if(key.startsWith('replySwipe'))styles[key]=RealStyleSheet.create({[key]:styles[key]})[key];}return styles;},hairlineWidth:1,absoluteFillObject:{position:'absolute',left:0,right:0,top:0,bottom:0}};export const useUnistyles=()=>({theme});`,
        },
      });
      expect(r.status, r.stderr).toBe(0);
      const p = JSON.parse(r.result);
      expect(p.error ?? p.crash, r.result).toBeUndefined();
      expect(p.ring).toBeGreaterThanOrEqual(p.clip);
      expect(p.tile).toBe(16);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  120_000,
);
