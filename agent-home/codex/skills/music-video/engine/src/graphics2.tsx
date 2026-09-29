import React from 'react';
import {AbsoluteFill, random} from 'remotion';
import markData from './mark.json';
import {C, F} from './theme';
import {clamp01, easeInOut, easeOut} from './timingFull';

const glow = (px: number, a = 0.8) => `drop-shadow(0 0 ${px}px rgba(229,166,69,${a}))`;
const hexPts = (r: number) =>
  Array.from({length: 6}, (_, i) => {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    return `${(Math.cos(a) * r).toFixed(1)},${(Math.sin(a) * r).toFixed(1)}`;
  }).join(' ');

// ─── A 2:14 AM clock orbited by agents ───────────────────────────────────────

export const NightClock: React.FC<{t: number; start: number}> = ({t, start}) => {
  const a = t - start;
  const s = easeOut(a / 0.3);
  const minute = (a * 90) % 360;
  return (
    <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center'}}>
      <svg width={760} height={760} viewBox="-380 -380 760 760" style={{transform: `scale(${0.7 + 0.3 * s})`, filter: glow(20, 0.7), marginTop: 180}}>
        <polygon points={hexPts(330)} fill="rgba(20,9,26,0.6)" stroke={C.mark} strokeWidth={6} />
        {Array.from({length: 12}, (_, i) => {
          const ang = (i / 12) * Math.PI * 2;
          return <line key={i} x1={Math.cos(ang) * 250} y1={Math.sin(ang) * 250} x2={Math.cos(ang) * 290} y2={Math.sin(ang) * 290} stroke={C.brass} strokeWidth={i % 3 ? 4 : 10} />;
        })}
        <line x1={0} y1={0} x2={0} y2={-150} stroke={C.bright} strokeWidth={14} strokeLinecap="round" transform={`rotate(${60 + a * 7})`} />
        <line x1={0} y1={0} x2={0} y2={-230} stroke={C.mark} strokeWidth={8} strokeLinecap="round" transform={`rotate(${minute})`} />
        <circle r={18} fill={C.mark} />
      </svg>
      <div style={{position: 'absolute', top: 1420, fontFamily: F.mono, fontSize: 64, letterSpacing: 14, color: C.mark, opacity: s}}>02:14 AM</div>
    </AbsoluteFill>
  );
};

// ─── Brass code rain ─────────────────────────────────────────────────────────

const GLYPHS = 'const merge = await gate(tip); if (ok) land(); fn beeline() { return main } git push --force-with-lease';
export const CodeRain: React.FC<{t: number; start: number; density?: number}> = ({t, start, density = 1}) => {
  const a = t - start;
  const cols = Math.floor(26 * density);
  return (
    <AbsoluteFill style={{overflow: 'hidden'}}>
      {Array.from({length: cols}, (_, c) => {
        const x = (c / cols) * 1080 + random(`crx${c}`) * 20;
        const speed = 500 + random(`crs${c}`) * 900;
        const len = 10 + Math.floor(random(`crl${c}`) * 16);
        const head = ((a * speed + random(`cro${c}`) * 2400) % 2600) - 300;
        return (
          <div key={c} style={{position: 'absolute', left: x, top: head - len * 44, fontFamily: F.mono, fontSize: 36, lineHeight: '44px', width: 40, textAlign: 'center'}}>
            {Array.from({length: len}, (_, r) => {
              const ch = GLYPHS[Math.floor(random(`g${c}${r}${Math.floor(a * 12 + r)}`) * GLYPHS.length)];
              const isHead = r === len - 1;
              return (
                <div key={r} style={{color: isHead ? '#fff3d6' : C.mark, opacity: isHead ? 1 : 0.15 + (r / len) * 0.7, textShadow: isHead ? '0 0 16px #E5A645' : 'none'}}>
                  {ch}
                </div>
              );
            })}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

// ─── A facade of Rooms lighting up one by one ────────────────────────────────

export const RoomWindows: React.FC<{t: number; start: number; dur: number}> = ({t, start, dur}) => {
  const a = t - start;
  const cols = 6;
  const rows = 11;
  const n = cols * rows;
  return (
    <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center'}}>
      <div style={{display: 'grid', gridTemplateColumns: `repeat(${cols}, 130px)`, gap: 22, marginTop: 240, transform: `perspective(1400px) rotateY(-18deg) rotateX(6deg) scale(${1 + a * 0.05})`}}>
        {Array.from({length: n}, (_, i) => {
          const order = random(`win${i}`);
          const on = a > order * dur * 0.9;
          const age = a - order * dur * 0.9;
          return (
            <div
              key={i}
              style={{
                height: 100,
                borderRadius: 3,
                border: `2px solid ${on ? C.mark : C.border}`,
                backgroundColor: on ? `rgba(229,166,69,${0.35 + 0.5 * Math.exp(-age / 0.3)})` : 'rgba(20,9,26,0.7)',
                boxShadow: on ? '0 0 30px rgba(229,166,69,0.55)' : 'none',
                fontFamily: F.mono,
                fontSize: 16,
                color: C.slab,
                padding: 8,
              }}
            >
              {on ? '◆' : ''}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// ─── A plan checklist ticking itself off ─────────────────────────────────────

const ITEMS = ['fix flaky merge gate', 'retry on relay 429', 'update the land docs', 'green CI on main', 'ship the review card'];
export const Checklist: React.FC<{t: number; start: number; dur: number}> = ({t, start, dur}) => {
  const a = t - start;
  return (
    <AbsoluteFill style={{justifyContent: 'center', padding: '0 110px'}}>
      <div style={{marginTop: 260, fontFamily: F.mono, fontSize: 30, letterSpacing: 8, color: C.quiet, marginBottom: 30}}>OVERNIGHT · PLAN</div>
      {ITEMS.map((item, i) => {
        const at = (i / ITEMS.length) * dur * 0.85;
        const done = a >= at;
        const k = easeOut((a - at) / 0.15);
        return (
          <div key={i} style={{display: 'flex', alignItems: 'center', gap: 28, margin: '18px 0', transform: `translateX(${done ? 0 : 20}px)`}}>
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: 3,
                border: `4px solid ${done ? C.mark : C.peak}`,
                backgroundColor: done ? C.mark : 'transparent',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 44,
                color: C.slab,
                transform: `scale(${done ? 1 + 0.3 * Math.exp(-(a - at) / 0.1) : 1})`,
                boxShadow: done ? '0 0 30px rgba(229,166,69,0.7)' : 'none',
              }}
            >
              {done ? '✓' : ''}
            </div>
            <div style={{fontFamily: F.prose, fontSize: 50, color: done ? C.bright : C.ghost, textDecoration: done && k > 0.9 ? 'line-through' : 'none', textDecorationColor: C.brass}}>{item}</div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

// ─── Sunrise disc ────────────────────────────────────────────────────────────

export const Sunrise: React.FC<{t: number; start: number}> = ({t, start}) => {
  const a = t - start;
  const rise = easeOut(a / 1.4);
  return (
    <AbsoluteFill style={{mixBlendMode: 'screen'}}>
      <div
        style={{
          position: 'absolute',
          left: 540 - 300,
          top: 760 - rise * 360,
          width: 600,
          height: 600,
          borderRadius: '50%',
          background: 'radial-gradient(circle, #fff3d6 0%, #E5A645 35%, rgba(229,166,69,0.25) 60%, transparent 72%)',
        }}
      />
      {Array.from({length: 14}, (_, i) => {
        const ang = -90 + (i - 6.5) * 13;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: 540,
              top: 1060 - rise * 360,
              width: 1400,
              height: 6,
              transformOrigin: '0 50%',
              transform: `rotate(${ang}deg)`,
              background: 'linear-gradient(90deg, rgba(255,243,214,0.5), transparent)',
              opacity: rise * 0.7,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};

// ─── A torrent of diff lines ─────────────────────────────────────────────────

const DIFF_LINES = [
  '+ const approval = await findHumanApproval(tip)',
  '- const ok = await gate.check(tip)',
  '+ if (!approval) return refuse("needs a human")',
  '+ await ci.watch(tip, {timeout: 15 * MIN})',
  '  return push(tip, target)',
  '+ realignOpenCorners(repo, tip)',
  '- setTimeout(retry, 5000)',
  '+ await publishCritical(card)',
  '+ recapLandedCorner(info)',
  '  export async function land(tip) {',
];
export const DiffTorrent: React.FC<{t: number; start: number}> = ({t, start}) => {
  const a = t - start;
  const scroll = a * 900;
  return (
    <AbsoluteFill style={{overflow: 'hidden', transform: 'perspective(1200px) rotateX(24deg) scale(1.25)', transformOrigin: '50% 100%'}}>
      {Array.from({length: 60}, (_, i) => {
        const line = DIFF_LINES[i % DIFF_LINES.length];
        const y = 2000 - ((i * 56 + scroll) % 3400);
        const sign = line[0];
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: 60,
              right: 60,
              top: y,
              fontFamily: F.mono,
              fontSize: 34,
              whiteSpace: 'pre',
              color: sign === '+' ? C.added : sign === '-' ? C.removed : C.quiet,
              backgroundColor: sign === '+' ? 'rgba(63,185,80,0.14)' : sign === '-' ? 'rgba(248,81,73,0.14)' : 'transparent',
              padding: '4px 14px',
            }}
          >
            {line}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

// ─── Vault lock ──────────────────────────────────────────────────────────────

export const VaultLock: React.FC<{t: number; start: number; slamAt: number}> = ({t, start, slamAt}) => {
  const a = t - start;
  const slam = easeOut((t - slamAt) / 0.14);
  const closed = t >= slamAt;
  const spin = closed ? 0 : (1 - easeOut(a / (slamAt - start))) * 180;
  return (
    <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center'}}>
      <svg width={900} height={900} viewBox="-450 -450 900 900" style={{marginTop: 200, filter: glow(closed ? 40 : 14, 0.9)}}>
        <polygon points={hexPts(400)} fill="rgba(20,9,26,0.85)" stroke={C.mark} strokeWidth={10} />
        <g transform={`rotate(${spin + (closed ? 30 * (1 - slam) : 0)})`}>
          <polygon points={hexPts(300)} fill="none" stroke={C.brass} strokeWidth={6} />
          {Array.from({length: 6}, (_, i) => (
            <line key={i} x1={0} y1={0} x2={Math.cos((i * Math.PI) / 3) * 300} y2={Math.sin((i * Math.PI) / 3) * 300} stroke={C.brass} strokeWidth={5} />
          ))}
        </g>
        <rect x={-80} y={-40} width={160} height={140} rx={3} fill={closed ? C.mark : C.slab} stroke={C.mark} strokeWidth={8} />
        <path d={`M -50 -40 L -50 ${-100 + (closed ? 0 : 50)} A 50 50 0 0 1 50 ${-100 + (closed ? 0 : 50)} L 50 -40`} fill="none" stroke={C.mark} strokeWidth={14} />
      </svg>
      {closed && (
        <div style={{position: 'absolute', top: 1500, fontFamily: F.mono, fontWeight: 600, fontSize: 52, letterSpacing: 14, color: C.mark, opacity: slam}}>
          FAIL-CLOSED
        </div>
      )}
    </AbsoluteFill>
  );
};

// ─── Nested frames: Workspace ▢ → Room → Corner ◇ ────────────────────────────

export const NestedFrames: React.FC<{t: number; start: number}> = ({t, start}) => {
  const a = t - start;
  const labels = ['WORKSPACE', 'ROOM', 'CORNER'];
  return (
    <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center'}}>
      {Array.from({length: 7}, (_, i) => {
        const z = ((i / 7 + a * 0.55) % 1) ;
        const scale = Math.pow(4, z * 3) * 0.12;
        const label = labels[i % 3];
        const shape = i % 3 === 2 ? 'diamond' : 'square';
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              width: 700,
              height: 700,
              border: `${6 / Math.max(0.3, scale)}px solid ${i % 3 === 0 ? C.mark : C.brass}`,
              borderRadius: 3,
              transform: `scale(${scale}) rotate(${shape === 'diamond' ? 45 : 0}deg)`,
              opacity: clamp01(1.6 - z * 1.8) * clamp01(z * 6),
              boxShadow: '0 0 40px rgba(229,166,69,0.5)',
            }}
          >
            <div style={{position: 'absolute', top: 18, left: 26, fontFamily: F.mono, fontSize: 40, letterSpacing: 8, color: C.mark, transform: shape === 'diamond' ? 'rotate(-45deg)' : 'none'}}>
              {label}
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

// ─── Crystal hex borders ─────────────────────────────────────────────────────

export const CrystalBorders: React.FC<{t: number; start: number}> = ({t, start}) => {
  const a = t - start;
  const R = 110;
  const W = Math.sqrt(3) * R;
  const cells: Array<{x: number; y: number; i: number}> = [];
  let i = 0;
  for (let r = -1; r < 13; r++) for (let q = -1; q < 7; q++) cells.push({x: q * W + (r % 2 ? W / 2 : 0), y: r * R * 1.5, i: i++});
  return (
    <AbsoluteFill>
      <svg width={1080} height={1920} style={{filter: glow(10, 0.8)}}>
        {cells.map((c) => {
          const sweep = clamp01((a * 1400 - (c.y + c.x * 0.4)) / 300);
          const hot = Math.exp(-Math.abs(a * 1400 - (c.y + c.x * 0.4) - 150) / 120);
          return (
            <polygon
              key={c.i}
              points={hexPts(R * 0.96)}
              transform={`translate(${c.x},${c.y})`}
              fill={`rgba(229,166,69,${0.04 + 0.25 * hot})`}
              stroke={hot > 0.3 ? '#fff3d6' : C.brass}
              strokeWidth={2 + 5 * hot}
              opacity={0.15 + 0.85 * sweep}
            />
          );
        })}
      </svg>
    </AbsoluteFill>
  );
};

// ─── A storm of a million words, and one line that steers through it ─────────

const STORM = ['refactor', 'retry', 'patch', 'ship?', 'tests', 'PR', 'rebase', 'lint', 'deploy', 'hotfix', 'merge?', 'plan', 'docs', 'bump', 'CI', 'review'];
export const WordStorm: React.FC<{t: number; start: number; steer?: number; words?: string[]}> = ({t, start, steer, words = STORM}) => {
  const a = t - start;
  const n = 90;
  const steering = steer !== undefined && t >= steer;
  const sk = steering ? easeOut((t - (steer as number)) / 0.5) : 0;
  return (
    <AbsoluteFill style={{overflow: 'hidden'}}>
      {Array.from({length: n}, (_, i) => {
        const ang = random(`wa${i}`) * Math.PI * 2;
        const sp = 300 + random(`ws${i}`) * 700;
        const d = ((a * sp + random(`wd${i}`) * 900) % 1300);
        let x = 540 + Math.cos(ang + a * 0.6) * d;
        let y = 960 + Math.sin(ang + a * 0.6) * d * 1.3;
        // Once steered, words part away from the line down the middle.
        if (steering) {
          const side = x < 540 ? -1 : 1;
          x += side * 380 * sk * Math.exp(-Math.abs(x - 540) / 400);
        }
        const size = 22 + random(`wz${i}`) * 34;
        return (
          <div key={i} style={{position: 'absolute', left: x, top: y, fontFamily: F.mono, fontSize: size, color: i % 4 === 0 ? C.mark : C.body, opacity: 0.35 + 0.5 * random(`wo${i}`), transform: `rotate(${(random(`wr${i}`) - 0.5) * 40}deg)`}}>
            {words[i % words.length]}
          </div>
        );
      })}
      {steering && (
        <svg width={1080} height={1920} style={{position: 'absolute', filter: glow(30, 1)}}>
          <path
            d="M 540 1920 C 420 1500, 700 1200, 540 900 S 420 300, 540 0"
            fill="none"
            stroke={C.mark}
            strokeWidth={16}
            strokeLinecap="round"
            pathLength={1}
            strokeDasharray="1 1"
            strokeDashoffset={1 - sk}
          />
          <circle cx={540} cy={1920 - 1920 * sk} r={34} fill={C.bright} stroke={C.mark} strokeWidth={8} />
        </svg>
      )}
    </AbsoluteFill>
  );
};

// ─── Agents bouncing off a force-field gate ──────────────────────────────────

export const ForceGate: React.FC<{t: number; start: number}> = ({t, start}) => {
  const a = t - start;
  const gateY = 1100;
  return (
    <AbsoluteFill>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: gateY - 10,
          height: 20,
          background: 'linear-gradient(90deg, transparent, #E5A645, #fff3d6, #E5A645, transparent)',
          boxShadow: `0 0 ${60 + 30 * Math.sin(a * 20)}px rgba(229,166,69,0.9)`,
        }}
      />
      {Array.from({length: 7}, (_, i) => (
        <div key={`bar${i}`} style={{position: 'absolute', left: 80 + i * 150, top: gateY - 400, width: 6, height: 420, background: `linear-gradient(${C.brass}, transparent)`, opacity: 0.6}} />
      ))}
      <svg width={1080} height={1920} style={{position: 'absolute', filter: glow(12, 0.8)}}>
        {Array.from({length: 9}, (_, i) => {
          const period = 0.9 + random(`fp${i}`) * 0.5;
          const ph = ((a + random(`fo${i}`) * period) % period) / period;
          const x = 100 + random(`fx${i}`) * 880;
          // Falls toward the gate, hits it at ph=0.6, bounces back up.
          const y = ph < 0.6 ? 200 + (gateY - 240) * (ph / 0.6) : gateY - 40 - 500 * Math.sin(((ph - 0.6) / 0.4) * Math.PI * 0.5);
          const flash = ph >= 0.6 && ph < 0.66;
          return (
            <g key={i} transform={`translate(${x},${y}) rotate(${ph * 400})`}>
              <polygon points="0,-26 23,16 -23,16" fill={flash ? '#fff3d6' : ['#5f9e8f', '#c96f6a', '#9b86c9'][i % 3]} />
            </g>
          );
        })}
      </svg>
    </AbsoluteFill>
  );
};

// ─── One human among many agents, spotlighted ────────────────────────────────

export const OneHuman: React.FC<{t: number; start: number; humanAt: number; oneAt: number; approveAt: number}> = ({t, start, humanAt, oneAt, approveAt}) => {
  // ONE: the crowd of agents pops in; HUMAN: the spotlight finds the one human and
  // the agents fall back; ONE: a single approval ring draws around them; apPROval:
  // the check stamps.
  const crowd = (i: number) => easeOut((t - start - (i % 8) * 0.018 - Math.floor(i / 8) * 0.02) / 0.16);
  const spot = easeOut((t - humanAt) / 0.3);
  const ring = easeInOut(clamp01((t - oneAt) / 0.3));
  const approved = t >= approveAt;
  const ak = easeOut((t - approveAt) / 0.14);
  const stamp = approved ? Math.exp(-(t - approveAt) / 0.25) : 0;
  return (
    <AbsoluteFill>
      <svg width={1080} height={1920}>
        {Array.from({length: 40}, (_, i) => {
          const x = 90 + (i % 8) * 130 + (Math.floor(i / 8) % 2) * 65;
          const y = 560 + Math.floor(i / 8) * 200;
          if (i === 20) return null;
          const c = crowd(i);
          return <polygon key={i} points="0,-26 23,16 -23,16" transform={`translate(${x},${y + 40 * (1 - c) + 60 * spot}) scale(${c * (1 - 0.35 * spot)})`} fill={['#5f9e8f', '#c96f6a', '#9b86c9', '#c98a3a'][i % 4]} opacity={0.9 - 0.7 * spot} />;
        })}
      </svg>
      <div
        style={{
          position: 'absolute',
          left: 610 - 520,
          top: 960 - 520,
          width: 1040,
          height: 1040,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(255,243,214,0.35) 0%, rgba(229,166,69,0.12) 35%, transparent 60%)',
          opacity: spot,
          transform: `scale(${0.6 + 0.4 * spot})`,
        }}
      />
      <svg width={1080} height={1920} style={{position: 'absolute', filter: glow(30, 1)}}>
        <circle cx={610} cy={960} r={(46 + 34 * spot) * crowd(20)} fill="#7d8fa8" stroke={C.bright} strokeWidth={6} />
        <circle cx={610} cy={960} r={140 + 40 * stamp} fill="none" stroke={C.mark} strokeWidth={10} pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - ring} transform="rotate(-90 610 960)" />
        {approved && (
          <g transform={`translate(610, 760) scale(${ak * (1 + 0.5 * stamp)})`}>
            <circle r={78} fill={C.mark} />
            <path d="M -36 2 L -9 29 L 38 -24" fill="none" stroke={C.slab} strokeWidth={15} strokeLinecap="round" strokeLinejoin="round" />
          </g>
        )}
        {approved && <circle cx={610} cy={960} r={140 + 700 * (1 - stamp)} fill="none" stroke={C.mark} strokeWidth={8 * stamp} opacity={stamp} />}
      </svg>
      <div style={{position: 'absolute', top: 1180, left: 610 - 300, width: 600, textAlign: 'center', fontFamily: F.mono, fontSize: 34, letterSpacing: 10, color: C.mark, opacity: ring}}>
        {approved ? 'APPROVED' : 'AWAITING 1 APPROVAL'}
      </div>
    </AbsoluteFill>
  );
};

// ─── The operating seal: "that's the way we operate" ─────────────────────────

export const OperatingSeal: React.FC<{t: number; start: number; ticks: number[]; stampAt: number}> = ({t, start, ticks, stampAt}) => {
  const a = t - start;
  const drawIn = easeOut(a / 0.35);
  const stamped = t >= stampAt;
  const k = stamped ? t - stampAt : 0;
  const slam = stamped ? 1 + 0.35 * Math.exp(-k / 0.09) * Math.cos(k * 40) * Math.exp(-k / 0.2) : 1.25 - 0.25 * drawIn;
  const shock = stamped ? clamp01(k / 0.5) : 0;
  const lit = ticks.filter((x) => t >= x).length;
  const spin = a * 14 + (stamped ? 40 * easeOut(k / 0.4) : 0);
  const ringText = 'ONE HUMAN \u00b7 ONE APPROVAL \u00b7 ONE HUMAN \u00b7 ONE APPROVAL \u00b7';
  return (
    <AbsoluteFill>
      <svg width={1080} height={1920} style={{position: 'absolute'}}>
        <defs>
          <path id="sealRing" d="M 540 1040 m -330 0 a 330 330 0 1 1 660 0 a 330 330 0 1 1 -660 0" />
        </defs>
        {stamped && <circle cx={540} cy={1040} r={420 + 700 * shock} fill="none" stroke={C.mark} strokeWidth={14 * (1 - shock)} opacity={1 - shock} />}
        <g transform={`translate(540 1040) scale(${slam}) translate(-540 -1040)`} opacity={drawIn} style={{filter: glow(stamped ? 40 : 18, 0.9)}}>
          <polygon points={hexPts(420)} transform="translate(540 1040)" fill="rgba(20,9,26,0.7)" stroke={C.mark} strokeWidth={8} pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - drawIn} />
          <g transform={`rotate(${spin} 540 1040)`}>
            <text fontFamily={F.mono} fontSize={40} letterSpacing={9} fill={C.brass} textLength={2040} lengthAdjust="spacing">
              <textPath href="#sealRing">{ringText}</textPath>
            </text>
          </g>
          {Array.from({length: 3}, (_, i) => {
            const ang = -90 + (i - 1) * 40;
            const on = i < lit;
            return (
              <polygon
                key={i}
                points={hexPts(34)}
                transform={`translate(${540 + Math.cos((ang * Math.PI) / 180) * 250} ${1040 + Math.sin((ang * Math.PI) / 180) * 250})`}
                fill={on || stamped ? C.mark : 'transparent'}
                stroke={C.mark}
                strokeWidth={5}
              />
            );
          })}
        </g>
      </svg>
      <div style={{position: 'absolute', left: 540 - 170, top: 1060 - 170, width: 340, height: 340, transform: `scale(${slam})`, opacity: drawIn, filter: glow(stamped ? 50 : 20, 1)}}>
        <svg width={340} height={340} viewBox="0 0 240 240">
          <g transform={markData.transform}>
            <path d={markData.path} fill={C.mark} fillOpacity={stamped ? 1 : 0.25 + 0.2 * drawIn} stroke={C.mark} strokeWidth={2} />
          </g>
        </svg>
      </div>
      {stamped && <AbsoluteFill style={{backgroundColor: C.mark, opacity: 0.35 * Math.exp(-k / 0.08)}} />}
    </AbsoluteFill>
  );
};

// ─── Heartbeat line ──────────────────────────────────────────────────────────

export const Heartbeat: React.FC<{t: number; start: number; beats: number[]; head?: number}> = ({t, start, beats, head = 760}) => {
  // Monitor trace: the write head sits at x=head, so each spike is drawn there at the
  // instant of its beat (peak 5 ms after), then scrolls left.
  const a = t - start;
  const yAt = (tx: number) => {
    let y = 0;
    for (const b of beats) {
      const d = tx - b;
      if (d > -0.05 && d < 0.2) y += -360 * Math.exp(-Math.pow((d - 0.005) / 0.018, 2)) + 160 * Math.exp(-Math.pow((d - 0.045) / 0.02, 2));
    }
    return y;
  };
  const pts: string[] = [];
  for (let x = 0; x <= head; x += 6) pts.push(`${x},${960 + yAt(t - (head - x) / 1400)}`);
  const hit = Math.max(0, ...beats.map((b) => (t >= b ? Math.exp(-(t - b) / 0.15) : 0)));
  return (
    <AbsoluteFill>
      <svg width={1080} height={1920} style={{filter: glow(24, 1)}}>
        <polyline points={pts.join(' ')} fill="none" stroke={C.mark} strokeWidth={10} strokeLinejoin="round" opacity={clamp01(a / 0.1)} />
        <circle cx={head} cy={960 + yAt(t)} r={16 + 22 * hit} fill="#fff3d6" />
        <circle cx={head} cy={960} r={60 + 200 * (1 - hit)} fill="none" stroke={C.mark} strokeWidth={6 * hit} opacity={hit} />
      </svg>
    </AbsoluteFill>
  );
};

// ─── Swipe cards ─────────────────────────────────────────────────────────────

export const SwipeCards: React.FC<{t: number; swipes: number[]}> = ({t, swipes}) => (
  <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center'}}>
    {['fix/merge-gate', 'feat/ci-watch', 'docs/land-flow'].map((b, i) => {
      const at = swipes[i];
      const k = at === undefined ? 0 : easeInOut((t - at) / 0.22);
      const depth = i - swipes.filter((s) => t >= s + 0.22).length;
      return (
        <div
          key={i}
          style={{
            position: 'absolute',
            marginTop: 200,
            width: 760,
            height: 480,
            borderRadius: 3,
            border: `3px solid ${C.mark}`,
            backgroundColor: C.raised,
            padding: 40,
            transform: `translateX(${-1300 * k}px) rotate(${-18 * k}deg) translateY(${Math.max(0, depth) * 36}px) scale(${1 - Math.max(0, depth) * 0.05})`,
            zIndex: 10 - i,
            boxShadow: '0 30px 80px rgba(0,0,0,0.6)',
          }}
        >
          <div style={{fontFamily: F.mono, fontSize: 28, letterSpacing: 6, color: C.quiet}}>CORNER · REVIEW</div>
          <div style={{fontFamily: F.prose, fontWeight: 600, fontSize: 60, color: C.bright, marginTop: 20}}>{b}</div>
          <div style={{fontFamily: F.mono, fontSize: 38, marginTop: 30}}>
            <span style={{color: C.added}}>+{48 + i * 31}</span> <span style={{color: C.removed}}>−{9 + i * 7}</span>
          </div>
        </div>
      );
    })}
  </AbsoluteFill>
);

// ─── Scan line sweeping over code ────────────────────────────────────────────

export const ScanSweep: React.FC<{t: number; start: number}> = ({t, start}) => {
  const a = t - start;
  const y = 300 + ((a * 1500) % 1500);
  return (
    <AbsoluteFill>
      <div style={{position: 'absolute', left: 0, right: 0, top: y - 120, height: 240, background: 'linear-gradient(transparent, rgba(229,166,69,0.25), transparent)'}} />
      <div style={{position: 'absolute', left: 0, right: 0, top: y, height: 6, backgroundColor: '#fff3d6', boxShadow: '0 0 40px #E5A645'}} />
    </AbsoluteFill>
  );
};

// ─── The mark drawing itself, large ──────────────────────────────────────────

export const MarkDraw: React.FC<{t: number; start: number; size?: number; y?: number}> = ({t, start, size = 620, y = 900}) => {
  const a = t - start;
  const draw = easeInOut(clamp01(a / 1.6));
  const fill = clamp01((a - 1.5) / 0.5);
  return (
    <div style={{position: 'absolute', left: 540 - size / 2, top: y - size / 2, filter: glow(30 + 30 * fill, 0.9)}}>
      <svg width={size} height={size} viewBox="0 0 240 240">
        <g transform={markData.transform}>
          <path d={markData.path} fill={C.mark} fillOpacity={fill} stroke={C.mark} strokeWidth={1.6} pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - draw} />
        </g>
      </svg>
    </div>
  );
};

// ─── The bee flies into the portal on the horizon ────────────────────────────

export const BeeIntoPortal: React.FC<{t: number; start: number; dur: number; hx?: number; hy?: number}> = ({t, start, dur, hx = 540, hy = 614}) => {
  const k = (t - start) / dur;
  if (k < 0) return null;
  const e = easeInOut(clamp01(k));
  // Swoops in from low left, arcing up and away into the portal's center.
  const x = 180 + (hx - 180) * e + Math.sin(e * Math.PI) * 260;
  const y = 1560 + (hy - 1560) * e;
  const size = 460 * (1 - 0.96 * e);
  const flash = k >= 1 ? Math.exp(-(t - (start + dur)) / 0.25) : 0;
  return (
    <AbsoluteFill>
      {k < 1 && (
        <div style={{position: 'absolute', left: x - size / 2, top: y - size / 2, transform: `rotate(${-30 + e * 50}deg)`, filter: glow(30, 1)}}>
          <svg width={size} height={size} viewBox="0 0 240 240">
            <g transform={markData.transform}>
              <path d={markData.path} fill={C.mark} />
            </g>
          </svg>
        </div>
      )}
      {flash > 0.01 && (
        <div
          style={{
            position: 'absolute',
            left: hx - 300,
            top: hy - 300,
            width: 600,
            height: 600,
            borderRadius: '50%',
            background: 'radial-gradient(circle, #fff3d6 0%, rgba(229,166,69,0.6) 30%, transparent 65%)',
            transform: `scale(${1 + (1 - flash) * 1.5})`,
            opacity: flash,
          }}
        />
      )}
    </AbsoluteFill>
  );
};
