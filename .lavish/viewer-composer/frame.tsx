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
.viewer-area{flex:1;min-height:0;position:relative;overflow:hidden}.viewer-area>div:first-child{height:100%}
.viewer-area .mock-artifact{position:absolute;top:85px;left:0;right:0;bottom:0;background:#f3eee4;color:#171310;overflow:hidden;padding:28px 21px;font-family:SpaceGrotesk-Regular}
.mock-artifact .eyebrow{font:10px IBMPlexMono-Regular;letter-spacing:2px;color:#8a6323;text-transform:uppercase}
.mock-artifact h1{font:22px/32px SpaceGrotesk-Medium;margin:18px 0 8px}.mock-artifact p{font:16px/23px SpaceGrotesk-Regular;color:#4a4038;margin:0 0 24px}
.mock-artifact .mock-card{background:#fff;border:1px solid #ded2bc;border-radius:14px;padding:20px 18px;box-shadow:0 10px 28px #3d24100c}
.mock-artifact .mock-card b{display:block;font:10px IBMPlexMono-Regular;letter-spacing:1px;text-transform:uppercase;margin:0 0 9px}.mock-artifact .field{height:47px;border:1px solid #c9bba0;border-radius:8px;padding:12px 13px;color:#8b7f6e;margin-bottom:18px;font-size:14px}.mock-artifact .primary{height:45px;border-radius:8px;background:#171310;color:#f3eee4;display:grid;place-items:center;font:16px SpaceGrotesk-SemiBold}.mock-artifact .hint{font:13px/19px SpaceGrotesk-Regular;color:#8b7f6e;text-align:center;margin-top:15px}
.dock{height:68px;flex:none;position:relative;background:${theme.bgBase};border-top:1px solid ${theme.border};display:flex;align-items:center;justify-content:flex-end;padding:0 16px}
.nav{height:24px;flex:none;background:${theme.bgBase};display:flex;align-items:center;justify-content:space-around;padding:0 64px}.nav span{width:20px;height:2px;background:${theme.textPrimary};opacity:.75}.nav span:first-child{width:16px;height:16px;border:2px solid ${theme.textPrimary};background:none}.nav span:last-child{width:0;height:0;border-top:9px solid transparent;border-bottom:9px solid transparent;border-right:14px solid ${theme.textPrimary};background:none}
.desktop{height:100%;display:flex}.rail{width:70px;border-right:1px solid ${theme.border};padding:18px;color:${theme.accent};font-size:28px}.rooms{width:260px;border-right:1px solid ${theme.border};padding:24px 18px}.rooms .word{font:24px SpaceGrotesk-SemiBold;margin-bottom:30px}.room-item{background:${theme.bgRaised};border-radius:11px;padding:13px;margin-bottom:8px;font-size:14px}.room-main{flex:1;min-width:0;border-right:1px solid ${theme.border};padding:26px 24px}.room-main h2{font:22px SpaceGrotesk-SemiBold;border-bottom:1px solid ${theme.border};padding-bottom:20px;margin:0}.room-main .body{max-width:520px;margin:38px auto;font:16px/23px SpaceGrotesk-Regular}.room-main .agent{font:13px SpaceGrotesk-Regular;color:${theme.ledgerQuiet};margin-bottom:8px}.desktop-pane{width:400px;display:flex;flex-direction:column;position:relative}.pane-head{height:55px;padding:17px 18px;border-bottom:1px solid ${theme.border};font:15px SpaceGrotesk-SemiBold}.desktop-pane .viewer-area{height:calc(100% - 123px);flex:none}.desktop-pane .dock{height:68px}
/* The 42 × 42 viewer control becomes the left cap of one composer pill. */
.v2-dock{justify-content:flex-end;padding:0 12px;border-top:1px solid ${theme.border}}
.attention-button{width:42px;height:42px;flex:none;border:1px solid ${theme.borderStrong};border-radius:14px;background:${theme.bgBase};display:grid;place-items:center;color:${theme.accent};padding:0}
.attention-mark{width:14px;height:14px;border:1px solid ${theme.accent};border-radius:7px;display:grid;place-items:center}.attention-mark span{width:8px;height:8px;border-radius:4px;background:${theme.accent}}
.expanding-pill{height:44px;width:100%;border:1px solid ${theme.borderStrong};border-radius:22px;background:${theme.bgRaised};display:flex;align-items:center;overflow:hidden;box-shadow:0 2px 12px #0003;transition:width 240ms ease}
.expanding-pill.partway{width:204px}.expanding-pill .attention-button{border:0;border-right:1px solid ${theme.border};background:transparent;border-radius:0 14px 14px 0}
.pill-copy{min-width:0;flex:1;border:0;outline:0;background:none;color:${theme.textPrimary};font:16px/23px SpaceGrotesk-Regular;padding:0 11px}.pill-copy::placeholder{color:${theme.ledgerQuiet}}
.pill-trailing{width:42px;height:42px;border:0;background:transparent;color:${theme.textPrimary};display:grid;place-items:center;font:22px SpaceGrotesk-Regular;padding:0}
.voice-copy{display:flex;align-items:center;gap:8px;white-space:nowrap;color:${theme.textSecondary};font:13px SpaceGrotesk-Regular}.waveform{color:${theme.accent};font:16px IBMPlexMono-Regular;letter-spacing:-2px}
.floating-transcript{position:absolute;z-index:8;left:16px;right:16px;bottom:88px;min-height:104px;border:1px solid ${theme.borderStrong};border-radius:12px;background:${new URLSearchParams(location.search).get('theme') === 'bone' ? '#ece4d5db' : '#190e21bf'};backdrop-filter:blur(12px);padding:12px 14px;box-shadow:0 8px 24px #0002}
.floating-transcript.arriving{opacity:.42;transform:translateY(4px)}.transcript-label{font:11px IBMPlexMono-Regular;color:${theme.ledgerQuiet};margin-bottom:8px}.transcript-line{font:13px/19px SpaceGrotesk-Regular;color:${theme.textPrimary};margin-top:5px}.transcript-line span{font:11px IBMPlexMono-Regular;color:${theme.accent};margin-right:6px}
.desktop-pane .floating-transcript{bottom:60px}.desktop-pane .v2-dock{height:68px}
`;
document.head.appendChild(sheet);

function Viewer() {
  return <div className="viewer-area">
    {isComputer ? <ComputerSessionViewer session={session} onClose={() => undefined} /> :
      <ArtifactViewerScreen markdown={{ title: 'Checkout flow · mock', text: '## Checkout flow\nReview the mock and leave feedback.' }} onClose={() => undefined} />}
    {!isComputer && <div className="mock-artifact"><div className="eyebrow">MONARCH / CHECKOUT</div><h1>Almost there.</h1><p>Review your details and finish your order.</p><div className="mock-card"><b>Contact</b><div className="field">Email address</div><b>Payment</b><div className="field">Card number</div><div className="primary">Continue</div><div className="hint">A calm, secure final step.</div></div></div>}
  </div>;
}
type DockStage = 'collapsed' | 'expanding' | 'typing' | 'voice' | 'reply' | 'collapsed-again';
const queryStage = (frame.split('-').slice(1).join('-') || 'collapsed') as DockStage;

/** The mark matches ConversationRow's 14 px needsRing and 8 px brass dot. */
function AttentionMark() {
  return <span className="attention-mark"><span /></span>;
}

function RecentTranscript({ stage, computer }: { stage: DockStage; computer: boolean }) {
  if (stage === 'collapsed' || stage === 'collapsed-again') return null;
  const reply = stage === 'reply';
  return <div className={`floating-transcript ${stage === 'expanding' ? 'arriving' : ''}`}>
    <div className="transcript-label">Recent conversation · Moth</div>
    {reply ? <>
      <div className="transcript-line"><span>You</span> {computer ? 'What do I do on this screen?' : 'Could we simplify this step?'}</div>
      <div className="transcript-line"><span>Moth</span> {computer ? 'Use the test card, then tap Continue. I’ll watch for the next screen.' : 'Yes. I’d collapse payment details until the buyer chooses Continue.'}</div>
    </> : <div className="transcript-line"><span>Moth</span> {computer ? 'I reached the checkout screen. Ask me about this step.' : 'I’ve opened the checkout mock. Tell me what to change.'}</div>}
  </div>;
}

function ConversationDock({ stage, computer, onStage }: { stage: DockStage; computer: boolean; onStage: (stage: DockStage) => void }) {
  const collapsed = stage === 'collapsed' || stage === 'collapsed-again';
  const voice = stage === 'voice';
  return <div className="dock v2-dock">
    {collapsed ? <button className="attention-button" aria-label="Talk to Moth" onClick={() => onStage('expanding')}><AttentionMark /></button> :
      <div className={`expanding-pill ${stage === 'expanding' ? 'partway' : ''}`}>
        <button className="attention-button in-pill" aria-label="Collapse conversation" onClick={() => onStage('collapsed-again')}><AttentionMark /></button>
        {voice ? <div className="pill-copy voice-copy"><span className="waveform">▂ ▅ ▃ ▇ ▄ ▆ ▂</span><span>Listening…</span></div> :
          <input className="pill-copy" aria-label="Message Moth" placeholder="Ask Moth…" defaultValue={stage === 'typing' ? (computer ? 'What do I do on this screen?' : 'Could we simplify this step?') : ''} onFocus={() => onStage('typing')} />}
        <button className="pill-trailing" aria-label={voice ? 'Send voice message' : stage === 'typing' ? 'Send message' : 'Start voice message'} onClick={() => onStage(stage === 'typing' || voice ? 'reply' : 'voice')}>
          {stage === 'typing' || voice ? '↑' : <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><rect x="7.5" y="2" width="5" height="9.5" rx="2.5" /><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0" /><path d="M10 15v3" /></svg>}
        </button>
      </div>}
  </div>;
}

function Phone() {
  const [stage, setStage] = React.useState<DockStage>(queryStage);
  return <div className="phone">{!isComputer && <div className="status"><span>9:41</span><span>◆ ▰</span></div>}
    <Viewer /><RecentTranscript stage={stage} computer={isComputer} /><ConversationDock stage={stage} computer={isComputer} onStage={setStage} />
    <div className="nav"><span /><span /><span /></div>
  </div>;
}

function Desktop() {
  const [stage, setStage] = React.useState<DockStage>(queryStage);
  return <div className="desktop"><div className="rail">✦</div><div className="rooms"><div className="word">beeline</div><div className="room-item">⌕ &nbsp; Search</div><div className="room-item">✦ &nbsp; Design Room</div><div className="room-item"># &nbsp; General</div></div>
    <div className="room-main"><h2>Design Room</h2><div className="body"><div className="agent">Moth · agent</div>I reached the sign in step. The browser is ready for you to finish it.</div></div>
    <div className="desktop-pane"><div className="pane-head">Browser</div><Viewer /><RecentTranscript stage={stage} computer /><ConversationDock stage={stage} computer onStage={setStage} /></div>
  </div>;
}

async function main() {
  await Promise.all(['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium', 'SpaceGrotesk-SemiBold', 'IBMPlexMono-Regular'].map((family) => document.fonts.load(`16px ${family}`)));
  createRoot(document.getElementById('root')!).render(desktop ? <Desktop /> : <Phone />);
}
void main();
