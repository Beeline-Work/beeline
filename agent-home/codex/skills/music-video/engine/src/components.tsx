import React from 'react';
import {AbsoluteFill, Img, random, staticFile} from 'remotion';
import {C, F} from './theme';
import {beatPulse, clamp01, downbeatPulse, easeOut} from './timingFull';

// ─── Backdrop ────────────────────────────────────────────────────────────────
// The obsidian slab, with grain, scanlines, and a brass pulse on the beat.

export const Backdrop: React.FC<{t: number; flash?: number; invert?: boolean}> = ({t, flash = 0.12, invert}) => {
  const pulse = beatPulse(t);
  const down = downbeatPulse(t);
  const grainX = Math.floor(random(`gx${Math.floor(t * 30)}`) * 256);
  const grainY = Math.floor(random(`gy${Math.floor(t * 30)}`) * 256);
  return (
    <AbsoluteFill style={{backgroundColor: invert ? C.brass : C.slab, overflow: 'hidden'}}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse 90% 60% at 50% 45%, ${invert ? '#c8a263' : '#2a1636'} 0%, transparent 70%)`,
          opacity: 0.55 + 0.35 * down,
        }}
      />
      <AbsoluteFill style={{backgroundColor: C.brass, opacity: invert ? 0 : flash * pulse}} />
      <AbsoluteFill
        style={{
          backgroundImage: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.22) 0px, rgba(0,0,0,0.22) 2px, transparent 2px, transparent 5px)',
          opacity: 0.5,
        }}
      />
      <AbsoluteFill
        style={{
          backgroundImage: `url(${staticFile('noise.png')})`,
          backgroundPosition: `${grainX}px ${grainY}px`,
          opacity: 0.55,
          mixBlendMode: 'overlay',
        }}
      />
      <AbsoluteFill style={{boxShadow: 'inset 0 0 260px 60px rgba(0,0,0,0.75)'}} />
    </AbsoluteFill>
  );
};

// ─── Kinetic type ────────────────────────────────────────────────────────────

const SMALL_WORDS = new Set(['I', 'A', 'TO', 'THE', 'IT', 'MY', 'AT', 'WE', 'THEY', 'THAN', "IT'S"]);

export const KineticWord: React.FC<{
  text: string;
  age: number; // seconds since the word started
  y?: number;
  maxSize?: number;
  color?: string;
  shake?: number;
  index?: number;
}> = ({text, age, y = 960, maxSize = 300, color, shake = 0, index = 0}) => {
  const isBrand = text === 'ATLAS' || text === 'TEST ATLAS';
  const small = SMALL_WORDS.has(text);
  const fit = Math.min(maxSize * (small ? 0.62 : 1), 980 / (text.length * 0.66));
  const pop = easeOut(age / 0.12);
  const scale = 1.55 - 0.55 * pop + 0.04 * Math.exp(-age / 0.3);
  const tilt = (random(`tilt${index}`) - 0.5) * 7 * (1 - pop);
  const jx = shake * (random(`jx${index}${Math.floor(age * 60)}`) - 0.5) * 24;
  const jy = shake * (random(`jy${index}${Math.floor(age * 60)}`) - 0.5) * 24;
  const fill = color ?? (isBrand ? C.mark : C.bright);
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: y - fit * 0.62,
        textAlign: 'center',
        fontFamily: F.prose,
        fontWeight: 700,
        fontSize: fit,
        lineHeight: 1,
        letterSpacing: isBrand ? '-0.02em' : '-0.03em',
        color: fill,
        transform: `translate(${jx}px, ${jy}px) scale(${scale}) rotate(${tilt}deg)`,
        opacity: clamp01(age / 0.04),
        textShadow: isBrand ? `0 0 ${40 + 60 * Math.exp(-age / 0.25)}px rgba(201,162,74,0.55)` : '0 0 30px rgba(0,0,0,0.6)',
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </div>
  );
};

// Brass/steel channel split for glitch hits, kept inside the brand palette.
export const GlitchSplit: React.FC<{amount: number; children: React.ReactNode}> = ({amount, children}) => {
  if (amount < 0.02) return <>{children}</>;
  const dx = amount * 18;
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{transform: `translateX(${-dx}px)`, opacity: 0.55, filter: 'sepia(1) saturate(4) hue-rotate(-10deg)'}}>{children}</AbsoluteFill>
      <AbsoluteFill style={{transform: `translateX(${dx}px)`, opacity: 0.45, filter: 'grayscale(1) brightness(1.6)'}}>{children}</AbsoluteFill>
      <AbsoluteFill>{children}</AbsoluteFill>
    </AbsoluteFill>
  );
};

// ─── The beeline streak ──────────────────────────────────────────────────────
// A straight brass line shooting across the frame along the mark's flight path.

export const Streak: React.FC<{age: number; y: number; angle?: number; thickness?: number; seed?: number}> = ({
  age,
  y,
  angle = -24,
  thickness = 10,
  seed = 0,
}) => {
  if (age < 0 || age > 0.55) return null;
  const head = easeOut(age / 0.22);
  const tail = easeOut((age - 0.12) / 0.4);
  const len = 2600;
  return (
    <div
      style={{
        position: 'absolute',
        left: -760,
        top: y,
        width: len,
        height: thickness,
        transform: `rotate(${angle + (random(`sa${seed}`) - 0.5) * 6}deg)`,
        transformOrigin: 'left center',
        overflow: 'visible',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: tail * len,
          width: Math.max(0, (head - tail) * len),
          height: '100%',
          borderRadius: thickness,
          background: `linear-gradient(90deg, rgba(201,162,74,0) 0%, ${C.mark} 70%, #f4f1e8 100%)`,
          boxShadow: `0 0 ${thickness * 4}px rgba(201,162,74,0.8)`,
        }}
      />
    </div>
  );
};

// ─── Phone ───────────────────────────────────────────────────────────────────

export const PHONE = {w: 820, h: 1640, screenInset: 22};

export const Phone: React.FC<{
  x?: number;
  y?: number;
  scale?: number;
  rotate?: number;
  glow?: number;
  children: React.ReactNode;
}> = ({x = 540, y = 960, scale = 1, rotate = 0, glow = 0, children}) => (
  <div
    style={{
      position: 'absolute',
      left: x - PHONE.w / 2,
      top: y - PHONE.h / 2,
      width: PHONE.w,
      height: PHONE.h,
      transform: `scale(${scale}) rotate(${rotate}deg)`,
      borderRadius: 96,
      background: 'linear-gradient(145deg, #2a3e36 0%, #0d1814 45%, #1e2e28 100%)',
      boxShadow: `0 60px 140px rgba(0,0,0,0.7), 0 0 ${80 * glow}px rgba(201,162,74,${0.5 * glow}), inset 0 0 0 2px #3d5249`,
    }}
  >
    <div
      style={{
        position: 'absolute',
        inset: PHONE.screenInset,
        borderRadius: 76,
        overflow: 'hidden',
        backgroundColor: C.slab,
      }}
    >
      {children}
      <div
        style={{
          position: 'absolute',
          top: 20,
          left: '50%',
          width: 150,
          height: 42,
          marginLeft: -75,
          borderRadius: 30,
          backgroundColor: '#050208',
        }}
      />
    </div>
  </div>
);

// ─── Beeline app UI (inside the phone, ~1.9x device scale) ───────────────────

export const StatusBar: React.FC = () => (
  <div
    style={{
      height: 92,
      display: 'flex',
      alignItems: 'flex-end',
      justifyContent: 'space-between',
      padding: '0 52px 10px',
      fontFamily: F.mono,
      fontSize: 24,
      color: C.body,
    }}
  >
    <span>2:14</span>
    <span style={{letterSpacing: 2}}>▮▮▮ 5G ▭</span>
  </div>
);

export const Header: React.FC<{title: string; kicker: string; glyph?: string}> = ({title, kicker, glyph = '▢'}) => (
  <div style={{padding: '18px 40px 22px', borderBottom: `2px solid ${C.divider}`}}>
    <div style={{fontFamily: F.mono, fontSize: 19, letterSpacing: 4, color: C.ghost, textTransform: 'uppercase'}}>{kicker}</div>
    <div style={{fontFamily: F.prose, fontWeight: 600, fontSize: 40, color: C.bright, marginTop: 6}}>
      <span style={{color: C.brass, marginRight: 14}}>{glyph}</span>
      {title}
    </div>
  </div>
);

export const IdentityMark: React.FC<{kind: 'agent' | 'human'; hue: string; size?: number; alive?: boolean; t?: number}> = ({
  kind,
  hue,
  size = 34,
  alive,
  t = 0,
}) => {
  const breathe = alive ? 0.55 + 0.45 * Math.sin(t * Math.PI * 2 / 1.12) : 0;
  return (
    <svg width={size + 12} height={size + 12} viewBox="-6 -6 46 46" style={{flexShrink: 0}}>
      {kind === 'agent' ? (
        <>
          {alive && <polygon points="17,-3 37,32 -3,32" fill="none" stroke={C.mark} strokeWidth={2.5} opacity={breathe} />}
          <polygon points="17,2 32,29 2,29" fill={hue} />
          <polygon points="17,11 24,24 10,24" fill={C.slab} opacity={0.35} />
        </>
      ) : (
        <>
          <circle cx={17} cy={17} r={15} fill={hue} />
          <circle cx={17} cy={17} r={6} fill={C.slab} opacity={0.3} />
        </>
      )}
    </svg>
  );
};

export type LedgerItem =
  | {type: 'msg'; who: string; role?: string; kind: 'agent' | 'human'; hue: string; time: string; text: string; viewer?: boolean}
  | {type: 'ghost'; text: string}
  | {type: 'status'; text: string};

export const LedgerRow: React.FC<{item: LedgerItem; age: number; t: number}> = ({item, age, t}) => {
  const enter = easeOut(age / 0.18);
  const style: React.CSSProperties = {
    opacity: enter,
    transform: `translateY(${(1 - enter) * 40}px)`,
    padding: '0 40px',
  };
  if (item.type === 'ghost') {
    return (
      <div style={{...style, display: 'flex', fontFamily: F.mono, fontSize: 23, color: C.ghost, margin: '18px 0', borderLeft: `2px solid ${C.peak}`, paddingLeft: 58}}>
        <span style={{flex: 1}}>⋯ {item.text}</span>
        <span style={{color: C.quiet}}>tap to expand</span>
      </div>
    );
  }
  if (item.type === 'status') {
    return (
      <div style={{...style, fontFamily: F.mono, fontSize: 23, color: C.quiet, margin: '18px 0'}}>{item.text}</div>
    );
  }
  // Typewriter reveal for the message body, like the app's streamed turns.
  const chars = Math.floor(item.text.length * clamp01((age - 0.08) / 0.45));
  return (
    <div style={{...style, marginTop: 30, borderTop: `2px solid ${C.divider}`, paddingTop: 24}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 10, fontFamily: F.mono, fontSize: 20, letterSpacing: 3, textTransform: 'uppercase'}}>
        <IdentityMark kind={item.kind} hue={item.hue} size={28} alive={item.kind === 'agent'} t={t} />
        <span style={{color: item.viewer ? C.brass : C.body}}>{item.who}</span>
        {item.role && <span style={{color: C.ghost}}>· {item.role}</span>}
        <span style={{color: C.ghost}}>· {item.time}</span>
      </div>
      <div style={{fontFamily: F.prose, fontSize: 31, lineHeight: 1.5, color: C.bright, marginTop: 10}}>{item.text.slice(0, chars)}</div>
    </div>
  );
};

export const PinnedCorner: React.FC<{t: number; text: string}> = ({t, text}) => {
  const breathe = 0.6 + 0.4 * Math.sin(t * Math.PI * 2 / 1.12);
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 150,
        padding: '22px 40px',
        borderTop: `2px solid ${C.divider}`,
        display: 'flex',
        fontFamily: F.mono,
        fontSize: 24,
        color: C.mark,
      }}
    >
      <span style={{opacity: breathe, marginRight: 14}}>◆</span>
      <span style={{flex: 1}}>{text}</span>
      <span style={{color: C.bright}}>view →</span>
    </div>
  );
};

export const Composer: React.FC = () => (
  <div
    style={{
      position: 'absolute',
      left: 30,
      right: 30,
      bottom: 44,
      height: 88,
      borderRadius: 3,
      border: `2px solid ${C.border}`,
      backgroundColor: C.raised,
      display: 'flex',
      alignItems: 'center',
      padding: '0 28px',
      fontFamily: F.prose,
      fontSize: 28,
      color: C.ghost,
    }}
  >
    Message the Room…
  </div>
);

// ─── Change review panel ─────────────────────────────────────────────────────

const DIFF: Array<[' ' | '+' | '-', string]> = [
  [' ', 'export async function landApproved(tip) {'],
  ['-', '  const ok = await gate.check(tip)'],
  ['+', '  const approval = await findHumanApproval(tip)'],
  ['+', '  if (!approval) return refuse("needs a human")'],
  ['+', '  await ci.watch(tip, {timeout: 15 * MIN})'],
  [' ', '  return push(tip, target)'],
  [' ', '}'],
];

export const ReviewPanel: React.FC<{t: number; since: number; diffFlash: number; tapAt: number; mergedAt: number}> = ({
  t,
  since,
  diffFlash,
  tapAt,
  mergedAt,
}) => {
  const age = t - since;
  const enter = easeOut(age / 0.2);
  const tapped = t >= tapAt;
  const merged = t >= mergedAt;
  const tapAge = t - tapAt;
  const mergedAge = t - mergedAt;
  const counter = Math.round(128 * clamp01((t - since - 0.3) / 1.6));
  const counterR = Math.round(42 * clamp01((t - since - 0.3) / 1.6));
  return (
    <div style={{padding: '26px 30px', opacity: enter, transform: `translateY(${(1 - enter) * 60}px)`}}>
      <div
        style={{
          borderRadius: 3,
          border: `2px solid ${merged ? C.mark : C.peak}`,
          backgroundColor: C.raised,
          padding: '26px 26px 30px',
          boxShadow: merged ? `0 0 ${50 * Math.exp(-mergedAge / 0.6) + 12}px rgba(201,162,74,0.45)` : 'none',
        }}
      >
        <div style={{fontFamily: F.mono, fontSize: 21, letterSpacing: 4, color: merged ? C.mark : C.quiet}}>
          {merged ? '✓ MERGED INTO main' : 'CHANGE READY FOR REVIEW'}
        </div>
        <div style={{fontFamily: F.prose, fontWeight: 600, fontSize: 36, color: C.bright, marginTop: 10}}>fix/merge-gate</div>
        <div style={{display: 'flex', gap: 22, marginTop: 8, fontFamily: F.mono, fontSize: 26}}>
          <span style={{color: C.added}}>+{counter}</span>
          <span style={{color: C.removed}}>−{counterR}</span>
          <span style={{color: C.ghost}}>3 files · tests green</span>
        </div>
        <div style={{marginTop: 22, borderLeft: `2px solid ${C.peak}`, backgroundColor: C.slab, padding: '14px 0'}}>
          {DIFF.map(([sign, line], i) => {
            const on = clamp01((age - 0.15 - i * 0.07) / 0.1);
            const color = sign === '+' ? C.added : sign === '-' ? C.removed : C.quiet;
            const bg = sign === '+' ? 'rgba(63,185,80,' : sign === '-' ? 'rgba(248,81,73,' : 'rgba(0,0,0,';
            return (
              <div
                key={i}
                style={{
                  fontFamily: F.mono,
                  fontSize: 21,
                  lineHeight: 1.7,
                  color,
                  opacity: on,
                  padding: '0 16px',
                  whiteSpace: 'pre',
                  overflow: 'hidden',
                  backgroundColor: sign === ' ' ? 'transparent' : `${bg}${0.1 + 0.35 * diffFlash})`,
                }}
              >
                {sign} {line}
              </div>
            );
          })}
        </div>
        <div style={{position: 'relative', marginTop: 28}}>
          <div
            style={{
              height: 96,
              borderRadius: 3,
              border: `2px solid ${C.brass}`,
              backgroundColor: tapped ? C.brass : 'transparent',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: F.mono,
              fontWeight: 600,
              fontSize: 30,
              letterSpacing: 5,
              color: tapped ? C.slab : C.mark,
              transform: `scale(${tapped ? 1 - 0.06 * Math.exp(-tapAge / 0.08) : 1})`,
            }}
          >
            {merged ? '✓ LANDED' : tapped ? 'SIGNING…' : 'APPROVE MERGE'}
          </div>
          {tapped && tapAge < 0.7 && (
            <div
              style={{
                position: 'absolute',
                left: '50%',
                top: 48,
                width: 40,
                height: 40,
                marginLeft: -20,
                marginTop: -20,
                borderRadius: '50%',
                border: `4px solid ${C.mark}`,
                transform: `scale(${1 + tapAge * 22})`,
                opacity: 1 - tapAge / 0.7,
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
};

// A fingertip that presses on a target point.
export const Finger: React.FC<{x: number; y: number; t: number; at: number}> = ({x, y, t, at}) => {
  const a = t - (at - 0.35);
  if (a < 0 || a > 1.0) return null;
  const come = easeOut(a / 0.3);
  const press = a > 0.35 ? Math.exp(-(a - 0.35) / 0.12) : 0;
  const leave = clamp01((a - 0.6) / 0.35);
  return (
    <div
      style={{
        position: 'absolute',
        left: x - 55,
        top: y - 55 + (1 - come) * 260 + leave * 260,
        width: 110,
        height: 110,
        borderRadius: '50%',
        background: 'radial-gradient(circle at 40% 35%, rgba(255,255,255,0.55), rgba(255,255,255,0.12) 60%, transparent 72%)',
        border: '3px solid rgba(255,255,255,0.35)',
        transform: `scale(${1 - 0.15 * press})`,
        opacity: come * (1 - leave),
      }}
    />
  );
};

export const Mark: React.FC<{d: string; transform: string; progress: number; size: number; fill: number}> = ({d, transform, progress, size, fill}) => (
  <svg width={size} height={size} viewBox="0 0 240 240">
    <g transform={transform}>
      <path
        d={d}
        fill={C.mark}
        fillOpacity={fill}
        stroke={C.mark}
        strokeWidth={2.4}
        pathLength={1}
        strokeDasharray="1 1"
        strokeDashoffset={1 - progress}
      />
    </g>
  </svg>
);
