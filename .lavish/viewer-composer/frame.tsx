import React from 'react';
// @ts-expect-error Standalone visual proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { ArtifactViewerScreen } from '../../apps/mobile/sources/components/buzz/ArtifactViewer';
import { ComputerSessionViewer } from '../../apps/mobile/sources/components/buzz/ComputerSession';
import { beelineThemes } from '../../apps/mobile/sources/buzz/groknight';

// @ts-expect-error esbuild embeds app fonts as data URLs.
import regular from '../../apps/mobile/sources/assets/fonts/SpaceGrotesk-Regular.ttf';
// @ts-expect-error esbuild embeds app fonts as data URLs.
import medium from '../../apps/mobile/sources/assets/fonts/SpaceGrotesk-Medium.ttf';
// @ts-expect-error esbuild embeds app fonts as data URLs.
import semibold from '../../apps/mobile/sources/assets/fonts/SpaceGrotesk-SemiBold.ttf';
// @ts-expect-error esbuild embeds app fonts as data URLs.
import mono from '../../apps/mobile/sources/assets/fonts/IBMPlexMono-Regular.ttf';

const frame = new URLSearchParams(location.search).get('frame') ?? 'artifact-idle';
const isComputer = frame.includes('computer') || frame.startsWith('desktop');
const desktop = frame.startsWith('desktop');
const theme = beelineThemes[new URLSearchParams(location.search).get('theme') === 'bone' ? 'bone' : 'obsidian'];
const session = {
  id: 'viewer-composer-mock',
  url: `${location.origin}/browser.html`,
  title: 'Checkout · Chrome',
  status: 'live' as const,
  access: 'mock-viewer-access',
};

const sheet = document.createElement('style');
sheet.textContent = `@font-face{font-family:SpaceGrotesk-Regular;src:url(${regular})}
@font-face{font-family:SpaceGrotesk-Medium;src:url(${medium})}
@font-face{font-family:SpaceGrotesk-SemiBold;src:url(${semibold})}
@font-face{font-family:IBMPlexMono-Regular;src:url(${mono})}
*{box-sizing:border-box}html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}
body{background:${theme.bgBase};color:${theme.textPrimary};font-family:SpaceGrotesk-Regular,sans-serif}
button{font:inherit;cursor:pointer}.phone{height:100%;display:flex;flex-direction:column;background:${theme.bgBase};position:relative}
.status{height:24px;flex:none;position:absolute;top:0;left:0;right:0;z-index:5;display:flex;justify-content:space-between;align-items:center;padding:0 16px;color:${theme.textPrimary};font:11px SpaceGrotesk-SemiBold;pointer-events:none}
.status.computer{color:#716b70}
.viewer-area{flex:1;min-height:0;position:relative;overflow:hidden}.viewer-area>div:first-child{height:100%}
.viewer-area .mock-artifact{position:absolute;top:85px;left:0;right:0;bottom:0;background:#f3eee4;color:#171310;overflow:hidden;padding:28px 21px;font-family:SpaceGrotesk-Regular}
.mock-artifact .eyebrow{font:10px IBMPlexMono-Regular;letter-spacing:2px;color:#8a6323;text-transform:uppercase}
.mock-artifact h1{font:22px/32px SpaceGrotesk-Medium;margin:18px 0 8px}.mock-artifact p{font:16px/23px SpaceGrotesk-Regular;color:#4a4038;margin:0 0 24px}
.mock-artifact .mock-card{background:#fff;border:1px solid #ded2bc;border-radius:14px;padding:20px 18px;box-shadow:0 10px 28px #3d24100c}
.mock-artifact .mock-card b{display:block;font:10px IBMPlexMono-Regular;letter-spacing:1px;text-transform:uppercase;margin:0 0 9px}.mock-artifact .field{height:47px;border:1px solid #c9bba0;border-radius:8px;padding:12px 13px;color:#8b7f6e;margin-bottom:18px;font-size:14px}.mock-artifact .primary{height:45px;border-radius:8px;background:#171310;color:#f3eee4;display:grid;place-items:center;font:16px SpaceGrotesk-SemiBold}.mock-artifact .hint{font:13px/19px SpaceGrotesk-Regular;color:#8b7f6e;text-align:center;margin-top:15px}
.dock{height:68px;flex:none;position:relative;background:${theme.bgBase};border-top:1px solid ${theme.border};display:flex;align-items:center;justify-content:flex-end;padding:0 16px}
.nav{height:24px;flex:none;background:${theme.bgBase};display:flex;align-items:center;justify-content:space-around;padding:0 64px}.nav span{width:20px;height:2px;background:${theme.textPrimary};opacity:.75}.nav span:first-child{width:16px;height:16px;border:2px solid ${theme.textPrimary};background:none}.nav span:last-child{width:0;height:0;border-top:9px solid transparent;border-bottom:9px solid transparent;border-right:14px solid ${theme.textPrimary};background:none}
.summon{width:44px;height:44px;border:1px solid ${theme.borderStrong};border-radius:14px;background:${theme.bgRaised};color:${theme.textPrimary};font:23px SpaceGrotesk-Regular;display:grid;place-items:center;box-shadow:0 2px 12px #0004}.dock-note{margin-right:auto;font:13px SpaceGrotesk-Regular;color:${theme.ledgerQuiet}}
.shade{position:absolute;inset:0;background:linear-gradient(180deg,transparent 48%,#14091a55 100%);pointer-events:none}
.composer-sheet{position:absolute;left:0;right:0;bottom:24px;z-index:10;background:${theme.bgBase};border-top:1px solid ${theme.borderStrong};border-radius:16px 16px 0 0;padding:12px 16px 16px;box-shadow:0 -16px 42px #0006}
.sheet-head{display:flex;align-items:center;justify-content:space-between;color:${theme.ledgerQuiet};font:13px SpaceGrotesk-Regular;margin-bottom:13px}.sheet-head strong{color:${theme.textPrimary};font:13px SpaceGrotesk-SemiBold}.sheet-head button,.transcript-head button{border:0;background:none;color:${theme.ledgerQuiet};font-size:20px;padding:2px 6px}
.context{display:flex;gap:9px;align-items:center;min-height:42px;border:1px solid ${theme.border};border-radius:10px;background:${theme.bgRaised};padding:7px 10px;margin-bottom:10px;color:${theme.textSecondary};font:13px SpaceGrotesk-Regular}.context .icon{color:${theme.accent};font-size:17px}.context .label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.context small{font:10px IBMPlexMono-Regular;color:${theme.ledgerQuiet};display:block;margin-bottom:2px;text-transform:uppercase;letter-spacing:.6px}
.composer{min-height:44px;border-radius:10px;border:1px solid ${theme.border};background:${theme.bgRaised};display:flex;align-items:center;padding:8px;gap:10px;color:${theme.textPrimary};font:16px SpaceGrotesk-Regular}.composer .plus{font-size:25px;line-height:26px}.composer .entry{flex:1;line-height:26px}.composer .mic{width:26px;height:26px;display:grid;place-items:center;font-size:22px}.composer .send{width:26px;height:26px;display:grid;place-items:center;font-size:22px}
.sheet-footer{font:11px IBMPlexMono-Regular;color:${theme.ledgerQuiet};margin-top:10px}.ticker{position:absolute;left:16px;right:16px;bottom:93px;z-index:8;padding:10px 13px;border:1px solid #f0f0f322;border-radius:12px;background:#190e2190;backdrop-filter:blur(8px);color:${theme.textPrimary};box-shadow:0 8px 28px #0002}.ticker .byline{font:11px IBMPlexMono-Regular;color:${theme.ledgerQuiet};margin-bottom:4px}.ticker .reply{font:13px/19px SpaceGrotesk-Regular;opacity:.88}.ticker .expand{font:11px IBMPlexMono-Regular;color:${theme.accent};margin-top:5px}
.transcript-sheet{position:absolute;left:0;right:0;bottom:24px;height:350px;z-index:10;background:${theme.bgBase};border-top:1px solid ${theme.borderStrong};border-radius:16px 16px 0 0;padding:16px 18px;box-shadow:0 -16px 42px #0007}.transcript-head{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid ${theme.border};padding-bottom:12px;font:16px SpaceGrotesk-SemiBold}.msg{margin-top:16px;font:14px/21px SpaceGrotesk-Regular}.msg .who{font:11px IBMPlexMono-Regular;color:${theme.ledgerQuiet};margin-bottom:5px}.msg p{margin:0}.sent-context{display:flex;gap:8px;align-items:center;margin-top:8px;color:${theme.ledgerQuiet};border:1px solid ${theme.border};border-radius:8px;width:max-content;max-width:100%;padding:5px 8px;font:11px IBMPlexMono-Regular}.sent-context .thumb{width:23px;height:21px;background:#f3eee4;border-radius:3px;border:1px solid #c9bba0}.sent-context .thumb.computer{background:#f3eee4 url('/computer-idle.png') center top / cover}.transcript-compose{position:absolute;bottom:14px;left:16px;right:16px;color:${theme.ledgerQuiet};font:13px SpaceGrotesk-Regular;border:1px solid ${theme.border};border-radius:10px;padding:11px}
.desktop{height:100%;display:flex}.rail{width:70px;border-right:1px solid ${theme.border};padding:18px;color:${theme.accent};font-size:28px}.rooms{width:260px;border-right:1px solid ${theme.border};padding:24px 18px}.rooms .word{font:24px SpaceGrotesk-SemiBold;margin-bottom:30px}.room-item{background:${theme.bgRaised};border-radius:11px;padding:13px;margin-bottom:8px;font-size:14px}.room-main{flex:1;min-width:0;border-right:1px solid ${theme.border};padding:26px 24px}.room-main h2{font:22px SpaceGrotesk-SemiBold;border-bottom:1px solid ${theme.border};padding-bottom:20px;margin:0}.room-main .body{max-width:520px;margin:38px auto;font:16px/23px SpaceGrotesk-Regular}.room-main .agent{font:13px SpaceGrotesk-Regular;color:${theme.ledgerQuiet};margin-bottom:8px}.desktop-pane{width:400px;display:flex;flex-direction:column;position:relative}.pane-head{height:55px;padding:17px 18px;border-bottom:1px solid ${theme.border};font:15px SpaceGrotesk-SemiBold}.desktop-pane .viewer-area{height:calc(100% - 123px);flex:none}.desktop-pane .dock{height:68px}.desktop-pane .composer-sheet{bottom:0}.desktop-pane .ticker{bottom:78px}
`;
document.head.appendChild(sheet);

function Viewer() {
  return <div className="viewer-area">
    {isComputer ? <ComputerSessionViewer session={session} onClose={() => undefined} /> :
      <ArtifactViewerScreen markdown={{ title: 'Checkout flow · mock', text: '## Checkout flow\nReview the mock and leave feedback.' }} onClose={() => undefined} />}
    {!isComputer && <div className="mock-artifact"><div className="eyebrow">MONARCH / CHECKOUT</div><h1>Almost there.</h1><p>Review your details and finish your order.</p><div className="mock-card"><b>Contact</b><div className="field">Email address</div><b>Payment</b><div className="field">Card number</div><div className="primary">Continue</div><div className="hint">A calm, secure final step.</div></div></div>}
  </div>;
}
function Context({ computer = isComputer }: { computer?: boolean }) {
  return <div className="context"><span className="icon">{computer ? '▣' : '◇'}</span><span className="label"><small>Looking at now · attached automatically</small>{computer ? 'Checkout · Chrome · screen snapshot' : 'Checkout flow · mock'}</span></div>;
}
function ComposerSheet() {
  return <div className="composer-sheet"><div className="sheet-head"><strong>Message Moth</strong><button aria-label="Dismiss composer">×</button></div><Context /><div className="composer"><span className="plus">＋</span><span className="entry">{isComputer ? 'What do I do on this screen?' : 'Message about this mock'}</span>{isComputer ? <span className="send">↑</span> : <span className="mic"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><rect x="7.5" y="2" width="5" height="9.5" rx="2.5" /><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0" /><path d="M10 15v3" /></svg></span>}</div><div className="sheet-footer">{isComputer ? 'Voice returns when the field is empty' : 'Tap the mic to dictate · send tucks the composer away'}</div></div>;
}
function Dock() {
  return <div className="dock"><span className="dock-note">{isComputer ? 'Browser remains touchable above' : 'Viewing artifact'}</span><button className="summon" aria-label="Message agent">✎</button></div>;
}
function Ticker() {
  return <div className="ticker"><div className="byline">Moth · just now</div><div className="reply">Use the test card, then tap Continue. I’ll watch for the next screen.</div><div className="expand">Tap to read recent conversation ↑</div></div>;
}
function Transcript() {
  return <div className="transcript-sheet"><div className="transcript-head">Recent conversation <button aria-label="Close transcript">×</button></div><div className="msg"><div className="who">You · 9:42</div><p>{isComputer ? 'What do I do on this screen?' : 'Could we simplify this step?'}</p><div className="sent-context"><span className={`thumb ${isComputer ? 'computer' : ''}`} />{isComputer ? 'Checkout · Chrome · snapshot' : 'Checkout flow · mock'}</div></div><div className="msg"><div className="who">Moth · 9:42</div><p>{isComputer ? 'Use the test card, then tap Continue. I’ll watch for the next screen.' : 'Yes. I’d collapse the payment details until the buyer chooses Continue.'}</p></div><div className="transcript-compose">＋ &nbsp; Message Moth <span style={{ float: 'right' }}>♩</span></div></div>;
}
function Phone() {
  return <div className="phone">{!isComputer && <div className="status"><span>9:41</span><span>◆ ▰</span></div>}<Viewer />{frame === 'computer-ticker' && <Ticker />}{frame === 'expanded-transcript' || frame.includes('sent-context') ? <Transcript /> : null}<Dock /><div className="nav"><span /><span /><span /></div>{frame.endsWith('composer') && <><div className="shade" /><ComposerSheet /></>}</div>;
}
function Desktop() {
  return <div className="desktop"><div className="rail">✦</div><div className="rooms"><div className="word">beeline</div><div className="room-item">⌕ &nbsp; Search</div><div className="room-item">✦ &nbsp; Design Room</div><div className="room-item"># &nbsp; General</div></div><div className="room-main"><h2>Design Room</h2><div className="body"><div className="agent">Moth · agent</div>I reached the sign in step. The browser is ready for you to finish it.</div></div><div className="desktop-pane"><div className="pane-head">Browser</div><Viewer /><Dock /><ComposerSheet /></div></div>;
}
async function main() {
  await Promise.all(['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium', 'SpaceGrotesk-SemiBold', 'IBMPlexMono-Regular'].map((family) => document.fonts.load(`16px ${family}`)));
  createRoot(document.getElementById('root')!).render(desktop ? <Desktop /> : <Phone />);
}
void main();
