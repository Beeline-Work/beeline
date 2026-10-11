import React from 'react';
// @ts-expect-error Standalone visual proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { ComputerSessionCard, ComputerSessionViewer } from '../sources/components/buzz/ComputerSession';
import { beelineThemes } from '../sources/buzz/groknight';

// @ts-expect-error esbuild embeds the font as a data URL.
import regular from '../sources/assets/fonts/SpaceGrotesk-Regular.ttf';
// @ts-expect-error esbuild embeds the font as a data URL.
import medium from '../sources/assets/fonts/SpaceGrotesk-Medium.ttf';
// @ts-expect-error esbuild embeds the font as a data URL.
import semibold from '../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf';
// @ts-expect-error esbuild embeds the font as a data URL.
import mono from '../sources/assets/fonts/IBMPlexMono-Regular.ttf';

const query = new URLSearchParams(location.search);
const frame = query.get('frame') ?? 'card-live';
const light = query.get('theme') === 'light';
const theme = beelineThemes[light ? 'bone' : 'obsidian'];
const ended = frame.includes('ended');
const desktop = frame.startsWith('desktop');
const control = frame.includes('control');
const readOnly = frame.includes('read-only');
const session = {
  id: 'frame-share',
  url: `${location.origin}/browser.html${control ? '?control=1' : ''}`,
  title: 'Checkout · Chrome',
  status: ended ? 'ended' as const : 'live' as const,
  access: readOnly ? undefined : 'mock-viewer-access',
};

const sheet = document.createElement('style');
sheet.textContent = `@font-face{font-family:SpaceGrotesk-Regular;src:url(${regular})}
@font-face{font-family:SpaceGrotesk-Medium;src:url(${medium})}
@font-face{font-family:SpaceGrotesk-SemiBold;src:url(${semibold})}
@font-face{font-family:IBMPlexMono-Regular;src:url(${mono})}
*{box-sizing:border-box}html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}
body{background:${theme.bgBase};color:${theme.textPrimary};font-family:SpaceGrotesk-Regular,sans-serif}
.phone{height:100%;display:flex;flex-direction:column;background:${theme.bgBase}}
.phone-top{height:64px;display:flex;align-items:center;gap:12px;padding:0 18px;border-bottom:1px solid ${theme.border};font-family:SpaceGrotesk-SemiBold;font-size:18px}
.phone-top .back{font-size:24px;color:${theme.accent}}.phone-top .face{border-radius:50%;width:31px;height:31px;background:${theme.accent};color:${theme.bgBase};text-align:center;line-height:31px}
.room{flex:1;overflow:hidden;padding:16px 18px}.time{color:${theme.ledgerQuiet};font-family:IBMPlexMono-Regular;font-size:11px;text-align:center;margin:4px 0 24px}
.agent{font-size:13px;color:${theme.ledgerQuiet};margin-bottom:6px}.line{font-size:15px;line-height:1.5;margin-bottom:10px}.card-wrap{width:100%}
.composer{height:72px;border-top:1px solid ${theme.border};padding:14px 16px}.composer-inner{height:42px;border:1px solid ${theme.borderStrong};border-radius:24px;display:flex;align-items:center;padding:0 16px;color:${theme.ledgerQuiet};font-size:14px}
.viewer-wrap{height:100%;display:flex;flex-direction:column}
.desktop{height:100%;display:flex;background:${theme.bgBase}}.rail{width:70px;border-right:1px solid ${theme.border};padding:19px;color:${theme.accent};font-size:28px}
.rooms{width:260px;border-right:1px solid ${theme.border};padding:24px 18px}.rooms .word{font-family:SpaceGrotesk-SemiBold;font-size:24px;margin-bottom:28px}.room-item{border-radius:11px;padding:13px;background:${theme.bgRaised};margin-bottom:8px;font-size:14px}
.transcript{flex:1;min-width:0;border-right:1px solid ${theme.border};padding:25px 24px}.transcript .head{font-family:SpaceGrotesk-SemiBold;font-size:21px;padding-bottom:22px;border-bottom:1px solid ${theme.border};margin-bottom:35px}
.transcript .body{max-width:520px;margin:auto}.pane{width:400px;display:flex;flex-direction:column}.pane-head{height:55px;padding:16px 18px;border-bottom:1px solid ${theme.border};font-family:SpaceGrotesk-SemiBold;font-size:15px}.pane-stream{flex:1;min-height:0;display:flex}
.statusbar{height:34px;display:flex;align-items:center;justify-content:space-between;padding:0 22px;font:600 13px SpaceGrotesk-SemiBold}
.viewer-caption{position:absolute;bottom:20px;left:16px;font:12px IBMPlexMono-Regular;color:${theme.ledgerQuiet}}
`;
document.head.appendChild(sheet);

function CardRoom() {
  return <div className="phone"><div className="statusbar"><span>9:41</span><span>●●●  ▰</span></div>
    <div className="phone-top"><span className="back">‹</span><span className="face">✦</span><span>Design Room</span></div>
    <div className="room"><div className="time">TODAY · 9:41 AM</div><div className="agent">Moth · agent</div>
      <div className="line">{readOnly ? 'I reached the sign in step. An allowed member can finish it in the browser.' : 'I reached the sign in step. The browser is ready for you to finish it.'}</div>
      <div className="card-wrap"><ComputerSessionCard session={session} /></div></div>
    <div className="composer"><div className="composer-inner">Message Design Room</div></div></div>;
}

function PhoneViewer() {
  return <div className="viewer-wrap"><ComputerSessionViewer session={session} onClose={() => {}} /></div>;
}

function Desktop() {
  return <div className="desktop"><div className="rail">✦</div><div className="rooms"><div className="word">beeline</div>
    <div className="room-item">⌕ &nbsp; Search</div><div className="room-item">✦ &nbsp; Design Room</div><div className="room-item"># &nbsp; General</div></div>
    <div className="transcript"><div className="head">Design Room</div><div className="body"><div className="time">TODAY · 9:41 AM</div>
      <div className="agent">Moth · agent</div><div className="line">I reached the sign in step. The browser is ready for you to finish it.</div>
      <ComputerSessionCard session={session} isDesktop /></div></div>
    <div className="pane"><div className="pane-head">Browser</div><div className="pane-stream"><ComputerSessionViewer session={session} onClose={() => {}} /></div></div></div>;
}

async function main() {
  await Promise.all(['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium', 'SpaceGrotesk-SemiBold', 'IBMPlexMono-Regular']
    .map((family) => document.fonts.load(`16px ${family}`)));
  createRoot(document.getElementById('root')!).render(desktop ? <Desktop /> : frame.startsWith('viewer') ? <PhoneViewer /> : <CardRoom />);
  setTimeout(() => {
    const title = document.querySelector('[data-testid^="computer-session-card"] div[dir="auto"]') as HTMLElement | null;
    (globalThis as { __computerFrameFont?: string }).__computerFrameFont = title ? getComputedStyle(title).fontFamily : 'missing';
  }, 300);
}
void main();
