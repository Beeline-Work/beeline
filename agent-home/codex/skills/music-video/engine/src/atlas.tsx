import React from 'react';
import {AbsoluteFill, random} from 'remotion';
import {C, F} from './theme';
import {clamp01, easeInOut, easeOut} from './timingFull';

const glow = (px: number, a = 0.8, rgb = '201,162,74') => `drop-shadow(0 0 ${px}px rgba(${rgb},${a}))`;
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const pop = (t: number, at: number, d = 0.14) => easeOut((t - at) / d);

// ─── The Test Atlas mark (public/favicon.svg), drawn node by node ────────────

const MARK_NODES: Array<[number, number, number]> = [
  [20, 20, 4.6],
  [38, 30, 6.2],
  [34, 48, 4.6],
  [16, 47, 4.6],
];
const MARK_LINKS: Array<[number, number, number, number]> = [
  [23, 22, 33, 28],
  [35, 44, 38, 34],
  [31, 47, 20, 46],
];

// progress 0..1 draws nodes, then the dotted links, then the gold arrow shoots out.
export const AtlasMark: React.FC<{progress: number; size: number; x?: number; y?: number; pulse?: number; ink?: string}> = ({
  progress,
  size,
  x = 540,
  y = 900,
  pulse = 0,
  ink = C.bright,
}) => {
  const node = (i: number) => easeOut(clamp01((progress - i * 0.12) / 0.14));
  const link = (i: number) => clamp01((progress - 0.12 - i * 0.12) / 0.14);
  const arrow = easeInOut(clamp01((progress - 0.55) / 0.3));
  const head = easeOut(clamp01((progress - 0.8) / 0.2));
  const dotted = (x1: number, y1: number, x2: number, y2: number, k: number, color: string, w: number) =>
    k > 0 ? <line x1={x1} y1={y1} x2={lerp(x1, x2, k)} y2={lerp(y1, y2, k)} stroke={color} strokeWidth={w} strokeDasharray="1 3.5" strokeLinecap="round" /> : null;
  return (
    <div style={{position: 'absolute', left: x - size / 2, top: y - (size * 60) / 64 / 2, width: size, height: (size * 60) / 64, filter: glow(20 + 40 * pulse, 0.6 + 0.4 * pulse)}}>
      <svg width="100%" height="100%" viewBox="0 0 64 60" overflow="visible">
        {MARK_LINKS.map(([a, b, c, d], i) => (
          <React.Fragment key={i}>{dotted(a, b, c, d, link(i), ink, 2.6)}</React.Fragment>
        ))}
        {dotted(40, 27, 55, 12, arrow, C.mark, 3)}
        {head > 0 && <path d="M47 9 L57 8 L55 18 Z" fill={C.mark} transform={`translate(52 13) scale(${head}) translate(-52 -13)`} />}
        {MARK_NODES.map(([cx, cy, r], i) => (
          <g key={i} transform={`translate(${cx} ${cy}) scale(${node(i) * (1 + 0.25 * pulse)})`}>
            <circle r={r} fill={C.slab} stroke={ink} strokeWidth={2.6} />
            {i === 1 && <circle r={3} fill={C.mark} />}
          </g>
        ))}
      </svg>
    </div>
  );
};

export const Wordmark: React.FC<{t: number; testAt: number; atlasAt: number; y: number; size?: number; flash?: number}> = ({t, testAt, atlasAt, y, size = 150, flash = 0}) => {
  const a = pop(t, testAt, 0.12);
  const b = pop(t, atlasAt, 0.12);
  return (
    <div style={{position: 'absolute', top: y, width: '100%', textAlign: 'center', fontFamily: F.prose, fontWeight: 700, fontSize: size, letterSpacing: '-0.04em', lineHeight: 1}}>
      <span style={{color: C.bright, opacity: a, display: 'inline-block', transform: `translateY(${40 * (1 - a)}px) scale(${1 + 0.1 * flash})`, marginRight: '0.24em'}}>Test</span>
      <span style={{color: C.mark, opacity: b, display: 'inline-block', transform: `translateY(${40 * (1 - b)}px) scale(${1 + 0.1 * flash})`, textShadow: `0 0 ${30 + 60 * flash}px rgba(201,162,74,0.6)`}}>Atlas</span>
    </div>
  );
};

// ─── The Loop: Assess → Diagnose → Drill → Reassess ───────────────────────────

const LOOP = ['ASSESS', 'DIAGNOSE', 'DRILL', 'REASSESS'];
export const LoopRing: React.FC<{t: number; stamps: number[]; closeAt: number; focus: number; cy?: number; r?: number}> = ({t, stamps, closeAt, focus, cy = 1020, r = 270}) => {
  // The comet rides the ring from station to station, arriving on each sung word.
  const marks = [...stamps, closeAt];
  let ang = -90;
  for (let i = 0; i < marks.length - 1; i++) {
    if (t >= marks[i]) ang = -90 + 90 * i + 90 * easeInOut(clamp01((t - marks[i]) / Math.min(0.35, marks[i + 1] - marks[i])));
  }
  if (t < stamps[0]) ang = -90 - 40 * (1 - clamp01((t - (stamps[0] - 0.6)) / 0.6));
  const rad = (d: number) => (d * Math.PI) / 180;
  const sweep = ang + 90; // degrees of ring lit so far
  const arcLen = 2 * Math.PI * r;
  const rot = -focus * 90; // the active station swings to the top
  return (
    <AbsoluteFill>
      <svg width={1080} height={1920} style={{filter: glow(18, 0.7)}}>
        <g transform={`translate(540 ${cy}) rotate(${rot})`}>
          <circle r={r} fill="none" stroke={C.pressed} strokeWidth={10} />
          <circle r={r} fill="none" stroke={C.leaf} strokeWidth={12} strokeDasharray={`${(arcLen * clamp01(sweep / 360)).toFixed(1)} ${arcLen}`} transform="rotate(-90)" strokeLinecap="round" />
          {LOOP.map((label, i) => {
            const a = rad(-90 + 90 * i);
            const on = t >= stamps[i];
            const k = on ? Math.exp(-(t - stamps[i]) / 0.25) : 0;
            return (
              <g key={label} transform={`translate(${Math.cos(a) * r} ${Math.sin(a) * r})`}>
                <circle r={46 + 26 * k} fill={on ? C.mark : C.slab} stroke={on ? C.bright : C.quiet} strokeWidth={6} />
                {on && <circle r={46 + 220 * (1 - k)} fill="none" stroke={C.mark} strokeWidth={6 * k} opacity={k} />}
                <text transform={`rotate(${-rot})`} y={12} textAnchor="middle" fontFamily={F.mono} fontSize={34} fill={on ? C.slab : C.quiet}>
                  {i + 1}
                </text>
              </g>
            );
          })}
          <g transform={`rotate(${ang})`}>
            <circle cx={r} cy={0} r={20} fill={C.bright} />
          </g>
        </g>
      </svg>
      {LOOP.map((label, i) => {
        const on = t >= stamps[i];
        const a = rad(-90 + 90 * i + rot);
        const lx = 540 + Math.cos(a) * (r + 90);
        const ly = cy + Math.sin(a) * (r + 100);
        return (
          <div key={label} style={{position: 'absolute', left: lx - 200, top: ly - 22, width: 400, textAlign: 'center', fontFamily: F.mono, fontSize: 34, letterSpacing: 5, transform: `rotate(${Math.abs(Math.cos(a)) > 0.7 ? (Math.cos(a) > 0 ? 90 : -90) : 0}deg)`, color: on ? C.mark : C.ghost}}>
            {label}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

// ─── Diagnose: a scan finds the family costing the most points ───────────────

const FAMILIES: Array<[string, number, number]> = [
  ['Inferences', 300, 760],
  ['Transitions', 760, 700],
  ['Linear functions', 250, 1080],
  ['Central ideas', 790, 1040],
  ['Percentages', 330, 1400],
  ['Circles', 800, 1380],
  ['Boundaries', 540, 1560],
  ['Command of evidence', 560, 900],
];

export const FamilyMap: React.FC<{t: number; start: number; target: number; targetAt?: number; pulseAt?: number; routeFrom?: number; routeTo?: number; scan?: boolean; zoom?: number; dimNodes?: number; origin?: [number, number]}> = ({
  t,
  start,
  target,
  targetAt = -99,
  pulseAt = -99,
  routeFrom,
  routeTo,
  scan = false,
  zoom = 1,
  dimNodes = 0,
  origin = [540, 960],
}) => {
  const a = t - start;
  const route = [0, 7, 1, 3, 2, 4, 6, 5];
  const rk = routeFrom === undefined || routeTo === undefined ? 0 : easeInOut(clamp01((t - routeFrom) / (routeTo - routeFrom)));
  const segs = route.length - 1;
  const scanY = 600 + ((a * 1400) % 1100);
  return (
    <AbsoluteFill style={{transform: `scale(${zoom})`, transformOrigin: `${origin[0]}px ${origin[1]}px`}}>
      <svg width={1080} height={1920}>
        {route.slice(0, -1).map((n, i) => {
          const [, x1, y1] = FAMILIES[n];
          const [, x2, y2] = FAMILIES[route[i + 1]];
          const k = clamp01(rk * segs - i);
          return (
            <g key={i}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={C.pressed} strokeWidth={4} strokeDasharray="4 16" strokeLinecap="round" />
              {k > 0 && <line x1={x1} y1={y1} x2={lerp(x1, x2, k)} y2={lerp(y1, y2, k)} stroke={C.mark} strokeWidth={10} strokeDasharray="2 22" strokeLinecap="round" style={{filter: glow(14, 1)}} />}
            </g>
          );
        })}
        {FAMILIES.map(([, x, y], i) => {
          const s = easeOut((a - i * 0.04) / 0.2);
          const hot = i === target && t >= targetAt;
          const hk = hot ? easeOut((t - targetAt) / 0.12) : 0;
          const pk = t >= pulseAt ? Math.exp(-(t - pulseAt) / 0.25) : 0;
          const k = hot ? Math.max(0.5 + 0.5 * Math.sin(a * 14), pk) : 0;
          return (
            <g key={i} transform={`translate(${x} ${y}) scale(${s * (hot ? 1 + 0.35 * (1 - hk) + 0.3 * pk : 1)})`} opacity={hot ? 1 : 1 - dimNodes}>
              {hot && <circle r={70 + 30 * k} fill="none" stroke={C.removed} strokeWidth={5} opacity={0.4 + 0.6 * k} />}
              <circle r={hot ? 34 : 26} fill={C.slab} stroke={hot ? C.removed : C.bright} strokeWidth={6} />
              {hot && <circle r={13} fill={C.removed} />}
            </g>
          );
        })}
        {scan && <rect x={0} y={scanY} width={1080} height={6} fill={C.leaf} opacity={0.7} style={{filter: glow(20, 1, '88,215,146')}} />}
      </svg>
      {FAMILIES.map(([name, x, y], i) => {
        const s = clamp01((a - i * 0.04 - 0.1) / 0.2);
        const hot = i === target;
        return (
          <div key={name} style={{position: 'absolute', left: x - 220, top: y + 44, width: 440, textAlign: 'center', fontFamily: F.mono, fontSize: hot ? 34 : 26, color: hot ? C.removed : C.quiet, opacity: s}}>
            {name}
            {hot && <div style={{fontSize: 24, letterSpacing: 4, marginTop: 6}}>COSTING YOU THE MOST</div>}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

// ─── Drill: rapid-fire cards, checked on the beat ────────────────────────────

export const DrillCards: React.FC<{t: number; flips: number[]; y?: number; label?: string}> = ({t, flips, y = 1080, label = 'DRILL · INFERENCES'}) => (
  <AbsoluteFill>
    {[0, 1, 2, 3].map((i) => {
      const at = flips[i];
      const k = at === undefined ? 0 : easeInOut((t - at) / 0.2);
      const depth = i - flips.filter((f) => t >= f + 0.2).length;
      const checked = at !== undefined && t >= at - 0.06;
      return (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: 540 - 380,
            top: y - 250,
            width: 760,
            height: 500,
            borderRadius: 4,
            backgroundColor: C.raised,
            border: `3px solid ${checked ? C.leaf : C.border}`,
            padding: 44,
            zIndex: 10 - i,
            transform: `translateY(${Math.max(0, depth) * 34 - 1500 * k}px) rotate(${-10 * k}deg) scale(${1 - Math.max(0, depth) * 0.05})`,
            boxShadow: '0 30px 80px rgba(0,0,0,0.6)',
          }}
        >
          <div style={{fontFamily: F.mono, fontSize: 28, letterSpacing: 6, color: C.quiet}}>
            {label} · Q{i + 1}/12
          </div>
          <div style={{fontFamily: F.prose, fontWeight: 500, fontSize: 46, color: C.bright, marginTop: 26, lineHeight: 1.2}}>Which choice most logically follows from the text?</div>
          <div style={{position: 'absolute', right: 40, bottom: 34, width: 86, height: 86, borderRadius: '50%', backgroundColor: checked ? C.leaf : 'transparent', border: `4px solid ${checked ? C.leaf : C.border}`, color: C.slab, fontSize: 58, textAlign: 'center', lineHeight: '84px', fontWeight: 700}}>
            {checked ? '✓' : ''}
          </div>
        </div>
      );
    })}
  </AbsoluteFill>
);

// ─── Every trap they set: poison words get struck out ────────────────────────

const CHOICES: Array<{key: string; pre: string; poison?: string; post: string; right?: boolean}> = [
  {key: 'A', pre: 'Cities should ', poison: 'ALWAYS', post: ' widen their roads.'},
  {key: 'B', pre: 'Traffic ', poison: 'NEVER', post: ' improves with new lanes.'},
  {key: 'C', pre: 'Widening roads tends not to reduce congestion.', post: '', right: true},
  {key: 'D', pre: 'Planners ignored ', poison: 'EVERY', post: ' budget.'},
];

export const TrapChoices: React.FC<{t: number; start: number; strikes: number[]; rightAt: number; y?: number}> = ({t, start, strikes, rightAt, y = 700}) => {
  const a = t - start;
  const scanY = y - 60 + clamp01((t - strikes[0] + 0.2) / (rightAt - strikes[0] + 0.2)) * 1000;
  let s = 0;
  return (
    <AbsoluteFill>
      <div style={{position: 'absolute', left: 90, top: y - 120, width: 900, fontFamily: F.prose, fontWeight: 500, fontSize: 40, color: C.body, opacity: easeOut(a / 0.2)}}>
        Which choice best states the passage&rsquo;s main idea?
      </div>
      {CHOICES.map((c, i) => {
        const k = easeOut((a - 0.05 * i) / 0.2);
        const strikeAt = c.poison ? strikes[s++] : undefined;
        const struck = strikeAt !== undefined && t >= strikeAt;
        const sk = struck ? easeOut((t - strikeAt) / 0.12) : 0;
        const good = c.right && t >= rightAt;
        const gk = good ? Math.exp(-(t - rightAt) / 0.3) : 0;
        return (
          <div
            key={c.key}
            style={{
              position: 'absolute',
              left: 90,
              top: y + i * 220,
              width: 900,
              minHeight: 170,
              padding: '30px 36px',
              boxSizing: 'border-box',
              backgroundColor: good ? 'rgba(88,215,146,0.14)' : C.raised,
              border: `4px solid ${good ? C.leaf : struck ? C.removed : C.border}`,
              borderRadius: 4,
              opacity: k * (struck ? 0.55 + 0.45 * (1 - sk) : 1),
              transform: `translateX(${(1 - k) * 200 + (struck ? 14 * Math.sin((t - strikeAt!) * 70) * Math.exp(-(t - strikeAt!) / 0.12) : 0)}px) scale(${1 + 0.05 * gk})`,
              boxShadow: good ? `0 0 ${40 + 60 * gk}px rgba(88,215,146,0.5)` : 'none',
              fontFamily: F.prose,
              fontSize: 44,
              color: C.bright,
            }}
          >
            <span style={{fontFamily: F.mono, color: good ? C.leaf : C.quiet, marginRight: 22}}>{c.key}</span>
            {c.pre}
            {c.poison && (
              <span style={{position: 'relative', color: struck ? C.removed : C.bright, fontWeight: 700}}>
                {c.poison}
                <span style={{position: 'absolute', left: -6, top: '52%', height: 8, width: `${(100 + 12) * sk}%`, backgroundColor: C.removed, boxShadow: '0 0 20px rgba(229,83,75,0.8)'}} />
              </span>
            )}
            {c.post}
            <span style={{position: 'absolute', right: 30, top: 26, fontSize: 60, fontWeight: 700, color: good ? C.leaf : C.removed, opacity: good ? 1 : sk}}>{good ? '✓' : struck ? '✗' : ''}</span>
          </div>
        );
      })}
      <div style={{position: 'absolute', left: 60, top: scanY, width: 960, height: 5, backgroundColor: C.leaf, opacity: t >= strikes[0] - 0.2 && t < rightAt + 0.2 ? 0.8 : 0, boxShadow: '0 0 30px rgba(88,215,146,1)'}} />
    </AbsoluteFill>
  );
};

// ─── From a mile away: pull back to a whole field of questions, traps glowing ─

export const TrapField: React.FC<{t: number; start: number; pullAt: number; pullTo: number}> = ({t, start, pullAt, pullTo}) => {
  const k = easeInOut(clamp01((t - pullAt) / (pullTo - pullAt)));
  const pre = easeOut(clamp01((t - start) / (pullAt - start))) * 0.25;
  const scale = lerp(9, 1, Math.max(pre, k));
  const cols = 9;
  const rows = 15;
  return (
    <AbsoluteFill style={{transform: `scale(${scale})`, transformOrigin: '540px 960px'}}>
      {Array.from({length: cols * rows}, (_, i) => {
        const cx = i % cols;
        const cy = Math.floor(i / cols);
        const trap = random(`trap${i}`) < 0.3;
        const blink = trap ? 0.5 + 0.5 * Math.sin(t * 9 + i) : 0;
        const center = cx === 4 && cy === 7;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: 540 - (cols * 112) / 2 + cx * 112 + 8,
              top: 960 - (rows * 122) / 2 + cy * 122 + 8,
              width: 96,
              height: 106,
              borderRadius: 2,
              backgroundColor: center ? 'rgba(88,215,146,0.25)' : C.raised,
              border: `2px solid ${center ? C.leaf : trap ? `rgba(229,83,75,${0.4 + 0.6 * blink})` : C.border}`,
              boxShadow: trap ? `0 0 ${12 * blink}px rgba(229,83,75,0.9)` : center ? '0 0 20px rgba(88,215,146,0.9)' : 'none',
            }}
          >
            {[0, 1, 2, 3].map((l) => (
              <div key={l} style={{margin: '10px 10px 0', height: 8, width: `${40 + random(`w${i}${l}`) * 40}px`, backgroundColor: trap && l === 1 ? C.removed : C.pressed}} />
            ))}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

// ─── Run it back: rewind spins, three times ──────────────────────────────────

export const Rewind: React.FC<{t: number; runs: number[]; again: number}> = ({t, runs, again}) => {
  const n = runs.filter((r) => t >= r).length;
  const spin = runs.reduce((acc, r) => acc + (t >= r ? -360 * easeOut((t - r) / 0.42) : 0), 0);
  const ag = t >= again ? t - again : -1;
  const agk = ag >= 0 ? Math.exp(-ag / 0.3) : 0;
  const hit = Math.max(0, ...runs.map((r) => (t >= r ? Math.exp(-(t - r) / 0.2) : 0)));
  return (
    <AbsoluteFill>
      <svg width={1080} height={1920} style={{filter: glow(24 + 40 * hit, 0.9)}}>
        <g transform={`translate(540 1100) rotate(${spin + (ag >= 0 ? -720 * easeOut(ag / 0.6) : 0)}) scale(${1 + 0.12 * hit + 0.4 * agk})`}>
          <path d="M 0 -250 A 250 250 0 1 0 250 0" fill="none" stroke={C.mark} strokeWidth={40} strokeLinecap="round" />
          <path d="M -20 -330 L 90 -250 L -20 -170 Z" fill={C.mark} />
          {[0, 1, 2].map((i) => (
            <circle key={i} cx={Math.cos((i * 2 * Math.PI) / 3) * 150} cy={Math.sin((i * 2 * Math.PI) / 3) * 150} r={22} fill={i < n ? C.leaf : C.pressed} />
          ))}
        </g>
      </svg>
      <div style={{position: 'absolute', top: 1450, width: '100%', textAlign: 'center', fontFamily: F.mono, fontSize: 64, letterSpacing: 16, color: ag >= 0 ? C.leaf : C.mark}}>
        {ag >= 0 ? 'LOOP ∞' : `LOOP ${Math.max(1, n)}`}
      </div>
      {runs.map((r, i) =>
        t >= r && t - r < 0.18 ? (
          <AbsoluteFill key={i} style={{backgroundImage: 'repeating-linear-gradient(0deg, rgba(244,241,232,0.08) 0px, rgba(244,241,232,0.08) 3px, transparent 3px, transparent 14px)', transform: `translateY(${-(t - r) * 3000}px)`}} />
        ) : null,
      )}
    </AbsoluteFill>
  );
};

// ─── Watch my score climb: a line that keeps stepping up on the beat ─────────

export const ClimbChart: React.FC<{t: number; start: number; steps: number[]; breakAt: number}> = ({t, start, steps, breakAt}) => {
  const a = t - start;
  const pts: Array<[number, number]> = [[90, 1600]];
  steps.forEach((s, i) => {
    const k = easeOut((t - s) / 0.16);
    if (t < s) return;
    const [px, py] = pts[pts.length - 1];
    const nx = 90 + (i + 1) * (860 / steps.length);
    const ny = 1600 - (i + 1) * (1050 / steps.length) - (i % 3 === 1 ? -40 : 0);
    pts.push([lerp(px, nx, k), lerp(py, ny, k)]);
  });
  const brk = t >= breakAt ? easeInOut((t - breakAt) / 0.35) : 0;
  const [hx, hy0] = pts[pts.length - 1];
  const hy = hy0 - brk * 700;
  if (brk > 0) pts.push([hx + 60 * brk, hy]);
  const cam = -Math.max(0, 1150 - hy) * 0.5;
  return (
    <AbsoluteFill style={{transform: `translateY(${-cam}px)`}}>
      <svg width={1080} height={1920} overflow="visible">
        {Array.from({length: 14}, (_, i) => (
          <line key={i} x1={60} x2={1020} y1={1600 - i * 120} y2={1600 - i * 120} stroke={C.border} strokeWidth={2} />
        ))}
        <polyline points={pts.map(([x, y]) => `${x},${y}`).join(' ')} fill="none" stroke={C.mark} strokeWidth={16} strokeLinejoin="round" strokeLinecap="round" style={{filter: glow(24, 1)}} />
        <polyline points={[...pts.map(([x, y]) => `${x},${y}`), `${pts[pts.length - 1][0]},1700`, '90,1700'].join(' ')} fill="rgba(201,162,74,0.12)" stroke="none" />
        <g transform={`translate(${pts[pts.length - 1][0]} ${pts[pts.length - 1][1]}) rotate(-45)`}>
          <path d="M -30 -34 L 44 0 L -30 34 Z" fill={C.mark} style={{filter: glow(20, 1)}} />
        </g>
      </svg>
      <div style={{position: 'absolute', left: 90, top: 1640, fontFamily: F.mono, fontSize: 34, letterSpacing: 8, color: C.quiet, opacity: easeOut(a / 0.3)}}>
        SCORE · CYCLE BY CYCLE
      </div>
    </AbsoluteFill>
  );
};

// ─── Pattern test: a grid that repeats itself, then cracks and shatters ──────

const GLYPHS = ['○', '△', '□', '◇'];
export const PatternCrack: React.FC<{t: number; start: number; cracks: number[]; shatter: number}> = ({t, start, cracks, shatter}) => {
  const a = t - start;
  const cols = 6;
  const rows = 10;
  const sh = t >= shatter ? t - shatter : -1;
  return (
    <AbsoluteFill>
      {Array.from({length: cols * rows}, (_, i) => {
        const cx = i % cols;
        const cy = Math.floor(i / cols);
        const x = 540 - (cols * 160) / 2 + cx * 160;
        const y = 960 - (rows * 160) / 2 + cy * 160;
        const wave = Math.exp(-Math.pow(((cx + cy) * 0.18 - a * 2.2) % 2.4, 2) / 0.02);
        const k = easeOut((a - (cx + cy) * 0.015) / 0.2);
        const dx = x + 80 - 540;
        const dy = y + 80 - 960;
        const fly = sh >= 0 ? easeOut(sh / 0.55) : 0;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: x + 8,
              top: y + 8,
              width: 144,
              height: 144,
              border: `2px solid ${wave > 0.4 ? C.mark : C.border}`,
              backgroundColor: `rgba(22,33,29,${0.6 + 0.3 * wave})`,
              color: wave > 0.4 ? C.mark : C.quiet,
              fontSize: 70,
              textAlign: 'center',
              lineHeight: '140px',
              opacity: k * (1 - fly),
              transform: `translate(${dx * 2.2 * fly}px, ${dy * 2.2 * fly}px) rotate(${(random(`r${i}`) - 0.5) * 540 * fly}deg) scale(${1 - 0.3 * fly})`,
            }}
          >
            {GLYPHS[(cx + cy * 2) % 4]}
          </div>
        );
      })}
      <svg width={1080} height={1920} style={{position: 'absolute', filter: glow(16, 1, '244,241,232')}}>
        {cracks.map((c, ci) =>
          Array.from({length: 7}, (_, j) => {
            if (t < c || sh > 0.1) return null;
            const k = easeOut((t - c) / 0.14);
            const pts: string[] = [];
            let px = 540;
            let py = 960;
            const ang = ((j + ci * 0.5) / 7) * Math.PI * 2 + random(`ca${ci}${j}`) * 0.6;
            for (let s = 0; s <= 6; s++) {
              pts.push(`${px},${py}`);
              const seg = (90 + random(`cl${ci}${j}${s}`) * 80) * k;
              const jitter = (random(`cj${ci}${j}${s}`) - 0.5) * 1.1;
              px += Math.cos(ang + jitter) * seg;
              py += Math.sin(ang + jitter) * seg;
            }
            return <polyline key={`${ci}-${j}`} points={pts.join(' ')} fill="none" stroke={C.bright} strokeWidth={6 - ci * 2} strokeLinejoin="round" />;
          }),
        )}
      </svg>
      {sh >= 0 && <AbsoluteFill style={{background: `radial-gradient(circle at 50% 50%, rgba(244,241,232,${0.95 * Math.exp(-sh / 0.25)}) 0%, rgba(201,162,74,${0.6 * Math.exp(-sh / 0.4)}) 35%, transparent 70%)`}} />}
    </AbsoluteFill>
  );
};

export const EndCard: React.FC<{t: number; start: number}> = ({t, start}) => {
  const a = t - start;
  return (
    <AbsoluteFill>
      <AtlasMark progress={clamp01(a / 0.45)} size={430} y={760} pulse={Math.exp(-a / 0.3)} />
      <Wordmark t={t} testAt={start + 0.08} atlasAt={start + 0.2} y={1080} size={160} flash={Math.exp(-Math.max(0, a - 0.12) / 0.25)} />
      <div style={{position: 'absolute', top: 1300, width: '100%', textAlign: 'center', fontFamily: F.mono, fontSize: 40, letterSpacing: 10, color: C.leaf, opacity: easeOut((a - 0.3) / 0.25)}}>testatlas.xyz</div>
      <div style={{position: 'absolute', top: 1790, width: '100%', textAlign: 'center', fontFamily: F.mono, fontSize: 20, letterSpacing: 2, color: C.ghost, opacity: easeOut((a - 0.35) / 0.3)}}>
        SAT® is a trademark of the College Board, which is not affiliated with Test Atlas.
      </div>
    </AbsoluteFill>
  );
};

// ─── "I found the pattern": scattered tiles snap into a repeating grid ───────

export const PatternSnap: React.FC<{t: number; start: number; snapAt: number; lockAt: number; pulses: number[]}> = ({t, start, snapAt, lockAt, pulses}) => {
  const cols = 6;
  const rows = 8;
  const snap = easeInOut(clamp01((t - snapAt) / (lockAt - snapAt)));
  const pulse = Math.max(0, ...pulses.map((p) => (t >= p ? Math.exp(-(t - p) / 0.22) : 0)));
  return (
    <AbsoluteFill>
      {Array.from({length: cols * rows}, (_, i) => {
        const cx = i % cols;
        const cy = Math.floor(i / cols);
        const gx = 540 - (cols * 150) / 2 + cx * 150;
        const gy = 1040 - (rows * 150) / 2 + cy * 150;
        const rx = 60 + random(`px${i}`) * 900;
        const ry = 420 + random(`py${i}`) * 1250;
        const x = lerp(rx, gx, snap);
        const y = lerp(ry, gy, snap);
        const lit = snap >= 1 && (cx + cy) % 2 === 0;
        const appear = easeOut((t - start - random(`pa${i}`) * 0.3) / 0.2);
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: x + 6,
              top: y + 6,
              width: 138,
              height: 138,
              border: `2px solid ${lit ? C.mark : C.border}`,
              backgroundColor: `rgba(22,33,29,${0.55 + 0.35 * snap})`,
              color: lit ? C.mark : C.quiet,
              fontSize: 64,
              lineHeight: '134px',
              textAlign: 'center',
              opacity: appear,
              transform: `rotate(${(random(`pr${i}`) - 0.5) * 120 * (1 - snap)}deg) scale(${1 + (lit ? 0.12 * pulse : 0)})`,
              boxShadow: lit ? `0 0 ${20 + 50 * pulse}px rgba(201,162,74,${0.35 + 0.4 * pulse})` : 'none',
            }}
          >
            {GLYPHS[(cx + cy * 2) % 4]}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

// ─── "It's not a reading test": a dense passage gets slashed out ─────────────

export const PassageStrike: React.FC<{t: number; start: number; strikeAt: number; noAt: number}> = ({t, start, strikeAt, noAt}) => {
  const a = t - start;
  const sk = t >= strikeAt ? easeOut((t - strikeAt) / 0.16) : 0;
  const no = t >= noAt ? Math.exp(-(t - noAt) / 0.2) : 0;
  return (
    <AbsoluteFill>
      <div style={{position: 'absolute', left: 110, top: 560, width: 860, height: 1060, backgroundColor: C.bright, borderRadius: 4, padding: '60px 64px', boxSizing: 'border-box', opacity: easeOut(a / 0.2) * (1 - 0.35 * sk), transform: `rotate(${-2 + 3 * sk}deg) scale(${1 - 0.04 * sk})`, boxShadow: '0 40px 120px rgba(0,0,0,0.6)'}}>
        <div style={{fontFamily: F.mono, fontSize: 26, letterSpacing: 6, color: C.quiet}}>PASSAGE 1 OF 27</div>
        {Array.from({length: 17}, (_, i) => (
          <div key={i} style={{height: 16, marginTop: 30, width: `${62 + random(`ln${i}`) * 36}%`, backgroundColor: '#8a9690', opacity: 0.55}} />
        ))}
      </div>
      <svg width={1080} height={1920} style={{position: 'absolute', filter: 'drop-shadow(0 0 30px rgba(229,83,75,0.9))'}}>
        <line x1={120} y1={1600} x2={120 + 840 * sk} y2={1600 - 1020 * sk} stroke={C.removed} strokeWidth={42} strokeLinecap="round" />
        <line x1={960} y1={1600} x2={960 - 840 * sk} y2={1600 - 1020 * sk} stroke={C.removed} strokeWidth={42} strokeLinecap="round" opacity={sk > 0.3 ? 1 : 0} />
      </svg>
      {no > 0 && <AbsoluteFill style={{backgroundColor: C.removed, opacity: 0.35 * no, mixBlendMode: 'screen'}} />}
    </AbsoluteFill>
  );
};

// ─── "It's a pattern test": the grid lights on each word, YES bursts green ───

export const PatternPulse: React.FC<{t: number; start: number; stamps: number[]; yesAt: number}> = ({t, start, stamps, yesAt}) => {
  const cols = 6;
  const rows = 8;
  const n = stamps.filter((s) => t >= s).length;
  const yes = t >= yesAt ? easeOut((t - yesAt) / 0.18) : 0;
  const yk = t >= yesAt ? Math.exp(-(t - yesAt) / 0.3) : 0;
  return (
    <AbsoluteFill>
      {Array.from({length: cols * rows}, (_, i) => {
        const cx = i % cols;
        const cy = Math.floor(i / cols);
        const group = (cx + cy) % 3;
        const on = yes > 0 ? true : group < n;
        const col = yes > 0 ? C.leaf : C.mark;
        const k = easeOut((t - start - (cx + cy) * 0.012) / 0.18);
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: 540 - (cols * 150) / 2 + cx * 150 + 6,
              top: 1040 - (rows * 150) / 2 + cy * 150 + 6,
              width: 138,
              height: 138,
              border: `2px solid ${on ? col : C.border}`,
              backgroundColor: on ? (yes > 0 ? 'rgba(88,215,146,0.18)' : 'rgba(201,162,74,0.12)') : 'rgba(22,33,29,0.8)',
              color: on ? col : C.quiet,
              fontSize: 64,
              lineHeight: '134px',
              textAlign: 'center',
              opacity: k,
              transform: `scale(${1 + 0.1 * yk})`,
            }}
          >
            {GLYPHS[(cx + cy * 2) % 4]}
          </div>
        );
      })}
      {yes > 0 && (
        <div style={{position: 'absolute', left: 540 - 170, top: 1040 - 170, width: 340, height: 340, borderRadius: '50%', backgroundColor: C.leaf, color: C.slab, fontSize: 240, fontWeight: 700, textAlign: 'center', lineHeight: '330px', transform: `scale(${yes * (1 + 0.3 * yk)})`, boxShadow: `0 0 ${80 + 120 * yk}px rgba(88,215,146,0.8)`}}>✓</div>
      )}
    </AbsoluteFill>
  );
};

// ─── Verse 1: study-night scenes ─────────────────────────────────────────────

// A page of passage lines; each mark swipes a highlighter across the next line.
// `scroll` makes the page run upward (reading passage after passage); `redAt` flares one line.
export const HighlightPage: React.FC<{t: number; start: number; marks: number[]; scroll?: number; redAt?: number}> = ({t, start, marks, scroll = 0, redAt}) => {
  const a = t - start;
  const lines = 26;
  const red = redAt !== undefined && t >= redAt ? easeOut((t - redAt) / 0.12) : 0;
  return (
    <AbsoluteFill style={{overflow: 'hidden'}}>
      <div style={{position: 'absolute', left: 110, top: 480 - a * scroll, width: 860, padding: '54px 60px', boxSizing: 'border-box', backgroundColor: C.bright, borderRadius: 4, opacity: easeOut(a / 0.2), transform: 'rotate(-1.5deg)', boxShadow: '0 40px 120px rgba(0,0,0,0.6)'}}>
        <div style={{fontFamily: F.mono, fontSize: 26, letterSpacing: 6, color: C.quiet, marginBottom: 20}}>READING &amp; WRITING · MODULE 1</div>
        {Array.from({length: lines}, (_, i) => {
          const m = marks[i % Math.max(1, marks.length)];
          const hk = i < marks.length && t >= m ? easeOut((t - m) / 0.18) : 0;
          const isRed = redAt !== undefined && i === 9;
          return (
            <div key={i} style={{position: 'relative', height: 16, marginTop: 34, width: `${60 + random(`hl${i}`) * 38}%`, backgroundColor: '#8a9690', opacity: 0.6}}>
              {hk > 0 && <div style={{position: 'absolute', left: -8, top: -10, height: 36, width: `${(100 + 4) * hk}%`, backgroundColor: 'rgba(233,210,90,0.75)', mixBlendMode: 'multiply'}} />}
              {isRed && red > 0 && <div style={{position: 'absolute', left: -14, top: -14, height: 44, width: `${(100 + 6) * red}%`, border: `6px solid ${C.removed}`, boxShadow: '0 0 30px rgba(229,83,75,0.9)'}} />}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// "Same score, same score": a flat line that refuses to move.
export const FlatScore: React.FC<{t: number; start: number; dots: number[]}> = ({t, start, dots}) => {
  const a = t - start;
  const shown = dots.filter((d) => t >= d);
  const x = (i: number) => 140 + i * (800 / (dots.length - 1));
  const hit = Math.max(0, ...dots.map((d) => (t >= d ? Math.exp(-(t - d) / 0.2) : 0)));
  return (
    <AbsoluteFill>
      <svg width={1080} height={1920} style={{filter: glow(16, 0.6)}}>
        {Array.from({length: 8}, (_, i) => (
          <line key={i} x1={100} x2={980} y1={700 + i * 110} y2={700 + i * 110} stroke={C.border} strokeWidth={2} />
        ))}
        {shown.length > 1 && <line x1={x(0)} x2={x(shown.length - 1)} y1={1080} y2={1080} stroke={C.quiet} strokeWidth={10} strokeLinecap="round" />}
        {shown.map((d, i) => (
          <circle key={i} cx={x(i)} cy={1080} r={22 + 14 * Math.exp(-(t - d) / 0.2)} fill={C.slab} stroke={C.body} strokeWidth={7} />
        ))}
      </svg>
      <div style={{position: 'absolute', left: 100, top: 620, fontFamily: F.mono, fontSize: 32, letterSpacing: 8, color: C.quiet, opacity: easeOut(a / 0.3)}}>SCORE · PRACTICE TESTS 1–{Math.max(1, shown.length)}</div>
      <div style={{position: 'absolute', left: 0, right: 0, top: 1190, textAlign: 'center', fontFamily: F.mono, fontSize: 44, letterSpacing: 14, color: C.removed, opacity: 0.4 + 0.6 * hit}}>NO CHANGE</div>
    </AbsoluteFill>
  );
};

// "Always, never, every? Poison — cross it out."
export const PoisonWords: React.FC<{t: number; appears: number[]; poisonAt: number; crossAt: number; outAt: number}> = ({t, appears, poisonAt, crossAt, outAt}) => {
  const words = ['ALWAYS', 'NEVER', 'EVERY'];
  const poison = t >= poisonAt ? easeOut((t - poisonAt) / 0.15) : 0;
  const cross = t >= crossAt ? easeOut((t - crossAt) / 0.14) : 0;
  const out = t >= outAt ? easeInOut((t - outAt) / 0.4) : 0;
  return (
    <AbsoluteFill>
      {words.map((wd, i) => {
        const k = appears[i] !== undefined && t >= appears[i] ? easeOut((t - appears[i]) / 0.14) : 0;
        const col = poison > 0 ? C.removed : C.bright;
        return (
          <div
            key={wd}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 720 + i * 250,
              textAlign: 'center',
              fontFamily: F.mono,
              fontWeight: 500,
              fontSize: 130,
              letterSpacing: 10,
              color: col,
              opacity: k,
              transform: `translateX(${(1 - k) * (i % 2 ? 300 : -300) + out * (i % 2 ? 1400 : -1400)}px) rotate(${out * (i % 2 ? 25 : -25)}deg) scale(${1 + 0.15 * (1 - k)})`,
              textShadow: poison > 0 ? `0 0 ${40 * poison}px rgba(229,83,75,0.8)` : '0 0 30px rgba(0,0,0,0.6)',
            }}
          >
            <span style={{position: 'relative'}}>
              {wd}
              <span style={{position: 'absolute', left: -20, top: '48%', height: 18, width: `${(100 + 8) * cross}%`, backgroundColor: C.removed, boxShadow: '0 0 24px rgba(229,83,75,1)'}} />
            </span>
          </div>
        );
      })}
      {poison > 0 && <div style={{position: 'absolute', left: 0, right: 0, top: 1540, textAlign: 'center', fontFamily: F.mono, fontSize: 40, letterSpacing: 12, color: C.removed, opacity: poison * (1 - out)}}>POISON WORDS</div>}
    </AbsoluteFill>
  );
};

// "Match it to the line": a gold thread from the answer to the key line; DOUBT stamps it.
export const MatchLine: React.FC<{t: number; start: number; matchAt: number; lineAt: number; doubtAt: number}> = ({t, start, matchAt, lineAt, doubtAt}) => {
  const a = t - start;
  const k = easeInOut(clamp01((t - matchAt) / (lineAt - matchAt)));
  const lock = t >= lineAt ? Math.exp(-(t - lineAt) / 0.25) : 0;
  const ok = t >= doubtAt ? easeOut((t - doubtAt) / 0.16) : 0;
  const key = [540, 760];
  const ans = [540, 1420];
  return (
    <AbsoluteFill>
      <div style={{position: 'absolute', left: 90, top: 560, width: 900, padding: '34px 40px', boxSizing: 'border-box', backgroundColor: C.raised, border: `3px solid ${k >= 1 ? C.mark : C.border}`, fontFamily: F.prose, fontSize: 40, color: C.body, lineHeight: 1.35, opacity: easeOut(a / 0.2)}}>
        …and yet <span style={{color: k >= 1 ? C.mark : C.bright, fontWeight: 600, backgroundColor: k >= 1 ? 'rgba(201,162,74,0.18)' : 'transparent'}}>widening roads tends not to reduce congestion</span>, the study found.
      </div>
      <div style={{position: 'absolute', left: 90, top: 1340, width: 900, padding: '30px 40px', boxSizing: 'border-box', backgroundColor: ok > 0 ? 'rgba(88,215,146,0.14)' : C.raised, border: `3px solid ${ok > 0 ? C.leaf : C.border}`, fontFamily: F.prose, fontSize: 42, color: C.bright, opacity: easeOut((a - 0.1) / 0.2)}}>
        <span style={{fontFamily: F.mono, color: ok > 0 ? C.leaf : C.quiet, marginRight: 20}}>C</span>Wider roads don&rsquo;t cut congestion.
      </div>
      <svg width={1080} height={1920} style={{position: 'absolute', filter: glow(18 + 30 * lock, 1)}}>
        {k > 0 && <line x1={ans[0]} y1={ans[1] - 20} x2={ans[0]} y2={lerp(ans[1] - 20, key[1] + 90, k)} stroke={C.mark} strokeWidth={10} strokeDasharray="2 20" strokeLinecap="round" />}
      </svg>
      {ok > 0 && <div style={{position: 'absolute', left: 540 - 110, top: 1060 - 110, width: 220, height: 220, borderRadius: '50%', backgroundColor: C.leaf, color: C.slab, fontSize: 150, fontWeight: 700, textAlign: 'center', lineHeight: '214px', transform: `scale(${ok})`, boxShadow: '0 0 90px rgba(88,215,146,0.7)'}}>✓</div>}
    </AbsoluteFill>
  );
};

// ─── Verse 2 ─────────────────────────────────────────────────────────────────

// "Quick check shows me where I'm losing ground": a short adaptive check fills, one family sags.
export const QuickCheck: React.FC<{t: number; start: number; groundAt: number}> = ({t, start, groundAt}) => {
  const a = t - start;
  const fill = easeInOut(clamp01(a / (groundAt - start)));
  const sag = t >= groundAt ? easeOut((t - groundAt) / 0.3) : 0;
  const ticks = 12;
  return (
    <AbsoluteFill>
      <div style={{position: 'absolute', left: 110, top: 640, fontFamily: F.mono, fontSize: 34, letterSpacing: 8, color: C.leaf}}>QUICK CHECK · ADAPTIVE</div>
      <div style={{position: 'absolute', left: 110, top: 700, width: 860, height: 22, backgroundColor: C.raised, border: `2px solid ${C.border}`}}>
        <div style={{height: '100%', width: `${fill * 100}%`, backgroundColor: C.leaf, boxShadow: '0 0 20px rgba(88,215,146,0.8)'}} />
      </div>
      {Array.from({length: ticks}, (_, i) => {
        const on = fill * ticks > i;
        const wrong = i === 4 || i === 7 || i === 10;
        return (
          <div key={i} style={{position: 'absolute', left: 110 + (i % 4) * 225, top: 800 + Math.floor(i / 4) * 150, width: 190, height: 110, border: `3px solid ${on ? (wrong ? C.removed : C.leaf) : C.border}`, backgroundColor: C.raised, fontFamily: F.mono, fontSize: 58, textAlign: 'center', lineHeight: '104px', color: on ? (wrong ? C.removed : C.leaf) : C.ghost}}>
            {on ? (wrong ? '✗' : '✓') : i + 1}
          </div>
        );
      })}
      <div style={{position: 'absolute', left: 110, top: 1300, width: 860, height: 300}}>
        {['Inferences', 'Transitions', 'Central ideas'].map((f, i) => (
          <div key={f} style={{display: 'flex', alignItems: 'center', height: 90, fontFamily: F.mono, fontSize: 30, color: i === 0 && sag > 0 ? C.removed : C.quiet}}>
            <div style={{width: 300}}>{f}</div>
            <div style={{height: 26, width: `${(i === 0 ? 70 - 45 * sag : 60 + i * 8) * 0.8}%`, backgroundColor: i === 0 && sag > 0 ? C.removed : C.pressed, transition: 'none'}} />
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

// "One little family dragging my whole score down."
export const FamilyBars: React.FC<{t: number; start: number; oneAt: number; downAt: number}> = ({t, start, oneAt, downAt}) => {
  const a = t - start;
  const one = t >= oneAt ? easeOut((t - oneAt) / 0.2) : 0;
  const down = t >= downAt ? easeOut((t - downAt) / 0.35) : 0;
  const names = ['Inf', 'Trn', 'CEv', 'Lin', 'Pct', 'Cir', 'Bnd', 'Ctr'];
  return (
    <AbsoluteFill>
      <div style={{position: 'absolute', left: 100, top: 560, width: 880, height: 70, border: `3px solid ${C.border}`, backgroundColor: C.raised}}>
        <div style={{height: '100%', width: `${78 - 30 * down}%`, backgroundColor: down > 0 ? C.removed : C.mark, boxShadow: `0 0 30px rgba(${down > 0 ? '229,83,75' : '201,162,74'},0.6)`}} />
      </div>
      <div style={{position: 'absolute', left: 100, top: 650, fontFamily: F.mono, fontSize: 30, letterSpacing: 8, color: C.quiet}}>TOTAL SCORE</div>
      {names.map((n, i) => {
        const bad = i === 0;
        const k = easeOut((a - i * 0.05) / 0.25);
        const h = bad ? 360 - 250 * one : 300 + ((i * 53) % 110);
        return (
          <div key={n} style={{position: 'absolute', left: 110 + i * 110, top: 1600 - h * k, width: 80, height: h * k, backgroundColor: bad && one > 0 ? C.removed : C.pressed, border: `2px solid ${bad && one > 0 ? C.removed : C.border}`, boxShadow: bad && one > 0 ? '0 0 40px rgba(229,83,75,0.7)' : 'none'}}>
            <div style={{position: 'absolute', top: h * k + 12, width: '100%', textAlign: 'center', fontFamily: F.mono, fontSize: 24, color: bad && one > 0 ? C.removed : C.quiet}}>{n}</div>
          </div>
        );
      })}
      {down > 0 && (
        <svg width={1080} height={1920} style={{position: 'absolute', filter: glow(16, 1, '229,83,75')}}>
          <line x1={150} y1={1600 - 110 * one} x2={150 + (100 + 880 * 0.78 - 150) * 0.2} y2={630 + 300 * (1 - down)} stroke={C.removed} strokeWidth={6} strokeDasharray="10 12" />
        </svg>
      )}
    </AbsoluteFill>
  );
};

// ─── The retest receipt (verse 2 end, bridge) ────────────────────────────────

export const Receipt: React.FC<{t: number; start: number; printTo: number; beforeAt?: number; afterAt?: number; fixedAt?: number; stampAt?: number; stamp?: string; x?: number; y?: number; scale?: number; rotate?: number}> = ({
  t,
  start,
  printTo,
  beforeAt = -99,
  afterAt = -99,
  fixedAt = 999, // not fixed until the lyric earns it
  stampAt,
  stamp = 'VERIFIED',
  x = 540,
  y = 1040,
  scale = 1,
  rotate = -3,
}) => {
  const p = easeOut(clamp01((t - start) / Math.max(0.01, printTo - start)));
  const bk = t >= beforeAt ? easeOut((t - beforeAt) / 0.3) : 0;
  const ak = t >= afterAt ? easeOut((t - afterAt) / 0.45) : 0;
  const fk = t >= fixedAt ? easeOut((t - fixedAt) / 0.14) : 0;
  const sk = stampAt !== undefined && t >= stampAt ? easeOut((t - stampAt) / 0.12) : 0;
  const H = 1100;
  const row = (label: string, body: React.ReactNode) => (
    <div style={{display: 'flex', alignItems: 'center', minHeight: 70, borderBottom: '3px dashed #c8c2b2', fontFamily: F.mono, fontSize: 30, color: '#2a3e36'}}>
      <div style={{width: 230, color: '#5a6860'}}>{label}</div>
      <div style={{flex: 1}}>{body}</div>
    </div>
  );
  return (
    <div style={{position: 'absolute', left: x - 380, top: y - H / 2, width: 760, height: H * p, overflow: 'hidden', transform: `scale(${scale}) rotate(${rotate}deg)`, boxShadow: '0 40px 120px rgba(0,0,0,0.6)'}}>
      <div style={{width: 760, height: H, backgroundColor: C.bright, padding: '50px 50px', boxSizing: 'border-box', position: 'relative'}}>
        <div style={{fontFamily: F.prose, fontWeight: 700, fontSize: 56, color: C.slab, letterSpacing: '-0.02em'}}>Retest Receipt</div>
        <div style={{fontFamily: F.mono, fontSize: 26, letterSpacing: 6, color: '#5a6860', marginBottom: 20}}>TEST ATLAS · CYCLE 1</div>
        {row('FAMILY', 'Inferences')}
        {row('BEFORE', <div style={{height: 28, width: `${30 * bk}%`, backgroundColor: '#8a9690'}} />)}
        {row('AFTER', <div style={{height: 28, width: `${82 * ak}%`, backgroundColor: C.green}} />)}
        {row('MISTAKE', (
          <span style={{position: 'relative'}}>
            always / never / every
            <span style={{position: 'absolute', left: -6, top: '50%', height: 6, width: `${106 * fk}%`, backgroundColor: C.removed}} />
          </span>
        ))}
        {row('STATUS', <span style={{color: fk > 0 ? C.green : '#8a9690', fontWeight: 500}}>{fk > 0 ? 'FIXED ✓' : 'in drill'}</span>)}
        {row('NEXT', 'Transitions')}
        <div style={{marginTop: 30, fontFamily: F.mono, fontSize: 22, letterSpacing: 4, color: '#8a9690'}}>SHAREABLE · PARENT-READABLE</div>
        {sk > 0 && (
          <div style={{position: 'absolute', right: 40, top: 420, padding: '14px 26px', border: `8px solid ${C.green}`, color: C.green, fontFamily: F.mono, fontWeight: 500, fontSize: 54, letterSpacing: 8, transform: `rotate(-14deg) scale(${1 + 1.5 * (1 - sk)})`, opacity: sk}}>
            {stamp}
          </div>
        )}
      </div>
    </div>
  );
};

// "Show your mom the receipt": the receipt lands in a family thread, mom replies.
export const MomChat: React.FC<{t: number; start: number; sendAt: number; replyAt: number}> = ({t, start, sendAt, replyAt}) => {
  const a = t - start;
  const s = t >= sendAt ? easeOut((t - sendAt) / 0.2) : 0;
  const r = t >= replyAt ? easeOut((t - replyAt) / 0.2) : 0;
  const bubble = (mine: boolean, k: number, body: React.ReactNode) => (
    <div style={{alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: 560, margin: '14px 0', padding: '22px 28px', borderRadius: 28, backgroundColor: mine ? C.green : C.pressed, color: C.bright, fontFamily: F.prose, fontSize: 40, opacity: k, transform: `translateY(${(1 - k) * 60}px) scale(${0.8 + 0.2 * k})`}}>{body}</div>
  );
  return (
    <AbsoluteFill>
      <div style={{position: 'absolute', left: 540 - 400, top: 380, width: 800, height: 1300, borderRadius: 80, backgroundColor: C.slab, border: `4px solid ${C.peak}`, boxShadow: '0 60px 140px rgba(0,0,0,0.7)', overflow: 'hidden', opacity: easeOut(a / 0.2)}}>
        <div style={{height: 150, borderBottom: `2px solid ${C.border}`, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 26, fontFamily: F.prose, fontWeight: 600, fontSize: 44, color: C.bright}}>Mom</div>
        <div style={{display: 'flex', flexDirection: 'column', padding: '30px 40px'}}>
          {bubble(true, 1, 'look what i did')}
          {bubble(true, s, (
            <div style={{width: 420}}>
              <div style={{fontFamily: F.mono, fontSize: 24, letterSpacing: 4, opacity: 0.8}}>RETEST RECEIPT · CYCLE 1</div>
              <div style={{marginTop: 12, height: 20, width: '30%', backgroundColor: 'rgba(244,241,232,0.5)'}} />
              <div style={{marginTop: 10, height: 20, width: '82%', backgroundColor: C.bright}} />
              <div style={{marginTop: 12, fontFamily: F.mono, fontSize: 26}}>MISTAKE FIXED ✓</div>
            </div>
          ))}
          {bubble(false, r, 'wait — that’s YOU?? so proud')}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// "Show 'em, show 'em": copies of the receipt fly out to the corners on each shout.
export const ShareBurst: React.FC<{t: number; shots: number[]}> = ({t, shots}) => (
  <AbsoluteFill>
    {shots.map((s, i) => {
      if (t < s) return null;
      const k = easeOut((t - s) / 0.6);
      const ang = [-0.7, 0.8, -2.4, 2.3][i % 4];
      const d = 900 * k;
      return (
        <div key={i} style={{position: 'absolute', left: 540 - 150 + Math.cos(ang) * d, top: 1000 - 200 + Math.sin(ang) * d * 1.2, width: 300, height: 400, backgroundColor: C.bright, borderRadius: 6, opacity: 1 - k * 0.6, transform: `rotate(${ang * 40 * k}deg) scale(${1 - 0.5 * k})`, boxShadow: '0 20px 60px rgba(0,0,0,0.5)', padding: 24, boxSizing: 'border-box'}}>
          <div style={{fontFamily: F.prose, fontWeight: 700, fontSize: 30, color: C.slab}}>Retest Receipt</div>
          <div style={{marginTop: 16, height: 14, width: '30%', backgroundColor: '#8a9690'}} />
          <div style={{marginTop: 10, height: 14, width: '82%', backgroundColor: C.green}} />
        </div>
      );
    })}
  </AbsoluteFill>
);

// ─── Verse 1 redo: "Cold coffee, highlighter, running on no rest / Read every passage
// like my life's on the line" ────────────────────────────────────────────────

// A stale mug: frost creeps across on COLD, the surface ripples on COFFEE.
export const ColdCoffee: React.FC<{t: number; start: number; coldAt: number; coffeeAt: number}> = ({t, start, coldAt, coffeeAt}) => {
  const a = t - start;
  const frost = t >= coldAt ? easeOut((t - coldAt) / 0.35) : 0;
  const rip = t >= coffeeAt ? t - coffeeAt : -1;
  const pop = t >= coldAt ? Math.exp(-(t - coldAt) / 0.2) : 0;
  const cx = 540;
  const cy = 1080;
  return (
    <AbsoluteFill>
      <svg width={1080} height={1920} style={{filter: glow(20, 0.5)}}>
        <g transform={`translate(${cx} ${cy}) scale(${(0.85 + 0.15 * easeOut(a / 0.25)) * (1 + 0.05 * pop)})`}>
          {/* handle */}
          <path d="M 250 -140 C 420 -140, 420 120, 250 120" fill="none" stroke={C.bright} strokeWidth={46} strokeLinecap="round" />
          {/* body */}
          <path d="M -260 -260 L 260 -260 L 220 300 C 210 360, -210 360, -220 300 Z" fill={C.bright} />
          <path d="M -260 -260 L 260 -260 L 220 300 C 210 360, -210 360, -220 300 Z" fill="none" stroke={C.mark} strokeWidth={8} />
          {/* coffee surface */}
          <ellipse cx={0} cy={-255} rx={250} ry={52} fill="#3b2a1e" />
          {rip >= 0 && [0, 1, 2].map((i) => {
            const k = clamp01((rip - i * 0.12) / 0.6);
            return k > 0 && k < 1 ? <ellipse key={i} cx={0} cy={-255} rx={40 + 200 * k} ry={8 + 42 * k} fill="none" stroke="#7a5a41" strokeWidth={6 * (1 - k)} /> : null;
          })}
          {/* the logo on the mug */}
          <g transform="translate(-60 -40) scale(3.2)" opacity={0.9}>
            <circle cx={10} cy={10} r={4} fill="none" stroke={C.slab} strokeWidth={2.4} />
            <circle cx={26} cy={18} r={5} fill="none" stroke={C.slab} strokeWidth={2.4} />
            <circle cx={26} cy={18} r={2.2} fill={C.mark} />
            <line x1={13} y1={12} x2={21} y2={16} stroke={C.slab} strokeWidth={2.4} strokeDasharray="1 3" strokeLinecap="round" />
          </g>
        </g>
        {/* frost creeping in from the rim */}
        {frost > 0 &&
          Array.from({length: 26}, (_, i) => {
            const ang = (i / 26) * Math.PI * 2;
            const len = (60 + random(`fr${i}`) * 160) * frost;
            const x0 = cx + Math.cos(ang) * 300;
            const y0 = cy + 20 + Math.sin(ang) * 330;
            return (
              <g key={i} stroke="#d7f0ff" strokeWidth={4} opacity={0.85} strokeLinecap="round">
                <line x1={x0} y1={y0} x2={x0 - Math.cos(ang) * len} y2={y0 - Math.sin(ang) * len} />
                <line x1={x0 - Math.cos(ang) * len * 0.5} y1={y0 - Math.sin(ang) * len * 0.5} x2={x0 - Math.cos(ang + 0.6) * len * 0.8} y2={y0 - Math.sin(ang + 0.6) * len * 0.8} />
              </g>
            );
          })}
      </svg>
      <div style={{position: 'absolute', left: 0, right: 0, top: 1520, textAlign: 'center', fontFamily: F.mono, fontSize: 36, letterSpacing: 10, color: frost > 0 ? '#d7f0ff' : C.quiet}}>BREWED 9:47 PM · NOW 2:14 AM</div>
      {frost > 0 && <AbsoluteFill style={{background: `radial-gradient(circle at 50% 56%, transparent 35%, rgba(215,240,255,${0.28 * frost}) 100%)`}} />}
    </AbsoluteFill>
  );
};

// A giant highlighter streaks neon swipes across the frame: one on the word, one on the hit.
export const HighlighterSwipe: React.FC<{t: number; swipes: Array<{at: number; from: [number, number]; to: [number, number]}>}> = ({t, swipes}) => (
  <AbsoluteFill>
    <svg width={1080} height={1920} style={{position: 'absolute'}}>
      {swipes.map((sw, i) => {
        if (t < sw.at) return null;
        const k = easeInOut(clamp01((t - sw.at) / 0.3));
        const hx = lerp(sw.from[0], sw.to[0], k);
        const hy = lerp(sw.from[1], sw.to[1], k);
        return <line key={i} x1={sw.from[0]} y1={sw.from[1]} x2={hx} y2={hy} stroke="#e9de5a" strokeWidth={240} opacity={0.82} style={{filter: 'drop-shadow(0 0 50px rgba(233,222,90,0.9))'}} />;
      })}
    </svg>
    {swipes.map((sw, i) => {
      const next = swipes[i + 1];
      if (t < sw.at || (next && t >= next.at)) return null;
      const k = easeInOut(clamp01((t - sw.at) / 0.3));
      const hx = lerp(sw.from[0], sw.to[0], k);
      const hy = lerp(sw.from[1], sw.to[1], k);
      const ang = (Math.atan2(sw.to[1] - sw.from[1], sw.to[0] - sw.from[0]) * 180) / Math.PI;
      // The marker trails its chisel tip, lying along the stroke, tilted up off the page.
      return (
        <div key={`p${i}`} style={{position: 'absolute', left: hx, top: hy, width: 0, height: 0, transform: `rotate(${ang}deg)`}}>
          <div style={{position: 'absolute', left: -120, top: -130, width: 120, height: 260, backgroundColor: '#e9de5a', clipPath: 'polygon(100% 20%, 100% 80%, 0 100%, 0 0)'}} />
          <div style={{position: 'absolute', left: -700, top: -120, width: 580, height: 240, borderRadius: 30, background: `linear-gradient(180deg, ${C.pressed}, ${C.slab} 60%, ${C.pressed})`, border: `6px solid ${C.mark}`}} />
          <div style={{position: 'absolute', left: -860, top: -130, width: 180, height: 260, borderRadius: '30px 8px 8px 30px', backgroundColor: '#e9de5a'}} />
        </div>
      );
    })}
  </AbsoluteFill>
);

// "Running on no rest": a battery loses a chunk per word and dies on REST.
export const BatteryDrain: React.FC<{t: number; start: number; drops: number[]; deadAt: number}> = ({t, start, drops, deadAt}) => {
  const a = t - start;
  const levels = [0.62, 0.38, 0.18, 0.06];
  let lvl = 0.85;
  drops.forEach((d, i) => {
    if (t >= d) lvl = levels[i];
  });
  const dead = t >= deadAt;
  const flash = dead ? 0.5 + 0.5 * Math.sign(Math.sin((t - deadAt) * 22)) : 0;
  const hit = Math.max(0, ...drops.map((d) => (t >= d ? Math.exp(-(t - d) / 0.18) : 0)));
  const col = lvl > 0.3 ? C.leaf : lvl > 0.1 ? C.mark : C.removed;
  return (
    <AbsoluteFill>
      <div style={{position: 'absolute', left: 540 - 250, top: 620, width: 500, height: 900, border: `16px solid ${dead ? C.removed : C.bright}`, borderRadius: 50, opacity: easeOut(a / 0.2), transform: `scale(${1 + 0.04 * hit})`, boxShadow: dead ? `0 0 ${80 * flash}px rgba(229,83,75,0.9)` : 'none'}}>
        <div style={{position: 'absolute', left: 160, top: -70, width: 150, height: 50, borderRadius: '14px 14px 0 0', backgroundColor: dead ? C.removed : C.bright}} />
        <div style={{position: 'absolute', left: 24, right: 24, bottom: 24, height: `${(900 - 80) * lvl}px`, backgroundColor: col, borderRadius: 18, opacity: dead ? flash : 1, boxShadow: `0 0 40px ${col}`}} />
      </div>
      <div style={{position: 'absolute', left: 0, right: 0, top: 1590, textAlign: 'center', fontFamily: F.mono, fontSize: 64, letterSpacing: 10, color: dead ? C.removed : C.bright}}>
        {dead ? 'NO REST · 0%' : `${Math.round(lvl * 100)}%`}
      </div>
    </AbsoluteFill>
  );
};

// "Read every passage": passages fly at the camera, one per word, counter ticking.
export const PassageTunnel: React.FC<{t: number; start: number; hits: number[]}> = ({t, start, hits}) => {
  const a = t - start;
  const n = hits.filter((h) => t >= h).length;
  return (
    <AbsoluteFill style={{perspective: 900}}>
      {Array.from({length: 7}, (_, i) => {
        const born = start + i * 0.17 - 0.2;
        const k = (t - born) / 0.9;
        if (k < 0 || k > 1) return null;
        const z = -1600 + 2300 * k * k;
        const x = (random(`tx${i}`) - 0.5) * 500;
        const y = 1000 + (random(`ty${i}`) - 0.5) * 400;
        return (
          <div key={i} style={{position: 'absolute', left: 540 - 300 + x, top: y - 400, width: 600, height: 800, backgroundColor: C.bright, padding: 40, boxSizing: 'border-box', transform: `translateZ(${z}px) rotate(${(random(`tr${i}`) - 0.5) * 20}deg)`, opacity: clamp01(k * 4) * clamp01((1 - k) * 5), boxShadow: '0 30px 80px rgba(0,0,0,0.6)'}}>
            <div style={{fontFamily: F.mono, fontSize: 22, letterSpacing: 5, color: C.quiet}}>PASSAGE {11 + i} OF 27</div>
            {Array.from({length: 13}, (_, j) => (
              <div key={j} style={{height: 12, marginTop: 30, width: `${55 + random(`pl${i}${j}`) * 43}%`, backgroundColor: '#8a9690', opacity: 0.6}} />
            ))}
          </div>
        );
      })}
      <div style={{position: 'absolute', left: 0, right: 0, top: 1640, textAlign: 'center', fontFamily: F.mono, fontSize: 52, letterSpacing: 12, color: C.mark, opacity: easeOut(a / 0.2)}}>PASSAGE {11 + n} / 27</div>
    </AbsoluteFill>
  );
};

// "Like my life's on the line": a heart-monitor trace spikes on the words; on LINE the
// trace flares red — the monitor line *is* the line.
export const LifeLine: React.FC<{t: number; start: number; spikes: number[]; lineAt: number}> = ({t, start, spikes, lineAt}) => {
  const head = 800;
  const red = t >= lineAt ? easeOut((t - lineAt) / 0.12) : 0;
  const yAt = (tx: number) => {
    let y = 0;
    for (const b of spikes) {
      const d = tx - b;
      const amp = b === lineAt ? 1.5 : 1;
      if (d > -0.05 && d < 0.2) y += amp * (-380 * Math.exp(-Math.pow((d - 0.005) / 0.018, 2)) + 170 * Math.exp(-Math.pow((d - 0.045) / 0.02, 2)));
    }
    return y;
  };
  const pts: string[] = [];
  for (let x = 0; x <= head; x += 6) pts.push(`${x},${1060 + yAt(t - (head - x) / 1500)}`);
  const col = red > 0 ? C.removed : C.leaf;
  const rgb = red > 0 ? '229,83,75' : '88,215,146';
  const hit = Math.max(0, ...spikes.map((b) => (t >= b ? Math.exp(-(t - b) / 0.15) : 0)));
  return (
    <AbsoluteFill>
      <svg width={1080} height={1920} style={{filter: `drop-shadow(0 0 ${24 + 40 * red}px rgba(${rgb},1))`}}>
        {Array.from({length: 12}, (_, i) => (
          <line key={i} x1={0} x2={1080} y1={700 + i * 60} y2={700 + i * 60} stroke={C.border} strokeWidth={1.5} opacity={0.6} />
        ))}
        <polyline points={pts.join(' ')} fill="none" stroke={col} strokeWidth={10 + 6 * red} strokeLinejoin="round" opacity={clamp01((t - start) / 0.1)} />
        <circle cx={head} cy={1060 + yAt(t)} r={16 + 22 * hit} fill={C.bright} />
      </svg>
      <div style={{position: 'absolute', left: 90, top: 1440, fontFamily: F.mono, fontSize: 40, letterSpacing: 8, color: col}}>{red > 0 ? 'ON THE LINE' : `BPM ${120 + 20 * Math.min(4, spikes.filter((s) => t >= s).length)}`}</div>
    </AbsoluteFill>
  );
};
