import React from 'react';
import {AbsoluteFill, random} from 'remotion';
import markData from './mark.json';
import {C, F} from './theme';
import {BEAT, clamp01, easeInOut, easeOut} from './timingFull';

const glow = (px: number, a = 0.8) => `drop-shadow(0 0 ${px}px rgba(229,166,69,${a}))`;

// ─── Git graph: a feature branch races beside main, then merges ──────────────

export const GitMerge: React.FC<{t: number; start: number; mergeAt: number}> = ({t, start, mergeAt}) => {
  const a = t - start;
  const grow = easeOut(a / 0.5);
  const merged = t >= mergeAt;
  const m = t - mergeAt;
  const join = easeInOut(clamp01((t - (mergeAt - 0.35)) / 0.35));
  const x0 = 300;
  const x1 = 780;
  // Main runs top to bottom; the feature branch forks off, runs parallel, and bends back in.
  const fx = x0 + (x1 - x0) * (1 - join);
  const mainY = 1920 * grow;
  const nodes = [520, 760, 1000, 1240];
  const pulse = merged ? Math.exp(-m / 0.25) : 0;
  return (
    <AbsoluteFill style={{filter: glow(18 + 30 * pulse, 0.9)}}>
      <svg width={1080} height={1920}>
        <line x1={x0} y1={0} x2={x0} y2={mainY} stroke={C.body} strokeWidth={14} strokeLinecap="round" />
        <path
          d={`M ${x0} 420 C ${x0} 520, ${fx} 480, ${fx} 620 L ${fx} 1180 C ${fx} 1320, ${x0} 1300, ${x0} 1420`}
          fill="none"
          stroke={C.mark}
          strokeWidth={16}
          strokeLinecap="round"
          pathLength={1}
          strokeDasharray="1 1"
          strokeDashoffset={1 - easeOut(a / 0.7)}
        />
        {nodes.map((y, i) => {
          const at = start + 0.25 + i * BEAT;
          const s = t >= at ? easeOut((t - at) / 0.12) : 0;
          return <circle key={i} cx={fx} cy={y} r={30 * s} fill={C.slab} stroke={C.mark} strokeWidth={10} />;
        })}
        {[200, 1600].map((y, i) => (
          <circle key={`m${i}`} cx={x0} cy={y} r={grow * 28} fill={C.slab} stroke={C.body} strokeWidth={10} />
        ))}
        {merged && (
          <>
            <circle cx={x0} cy={1420} r={40 + 20 * pulse} fill={C.mark} />
            <circle cx={x0} cy={1420} r={60 + m * 900} fill="none" stroke={C.mark} strokeWidth={8} opacity={clamp01(1 - m / 0.6)} />
          </>
        )}
      </svg>
      <div
        style={{
          position: 'absolute',
          left: x0 + 70,
          top: 1390,
          fontFamily: F.mono,
          fontSize: 34,
          letterSpacing: 4,
          color: merged ? C.mark : C.quiet,
          opacity: merged ? 1 : clamp01((a - 0.3) / 0.2),
        }}
      >
        {merged ? '✓ merged into main' : 'feat/merge-gate'}
      </div>
    </AbsoluteFill>
  );
};

// ─── Lightning ───────────────────────────────────────────────────────────────

function bolt(seed: string, x0: number, y0: number, x1: number, y1: number, depth = 5): string {
  let pts: Array<[number, number]> = [
    [x0, y0],
    [x1, y1],
  ];
  let amp = Math.hypot(x1 - x0, y1 - y0) * 0.22;
  for (let d = 0; d < depth; d++) {
    const next: Array<[number, number]> = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      const off = (random(`${seed}${d}${i}`) - 0.5) * amp;
      next.push([(ax + bx) / 2 + off, (ay + by) / 2 + off * 0.3], pts[i + 1]);
    }
    pts = next;
    amp *= 0.5;
  }
  return pts.map(([x, y]) => `${x.toFixed(0)},${y.toFixed(0)}`).join(' ');
}

export const Lightning: React.FC<{t: number; hits: number[]}> = ({t, hits}) => (
  <AbsoluteFill style={{mixBlendMode: 'screen', pointerEvents: 'none'}}>
    <svg width={1080} height={1920} style={{filter: glow(22, 1)}}>
      {hits.map((h, i) => {
        const a = t - h;
        if (a < 0 || a > 0.22) return null;
        const flick = a < 0.05 || (a > 0.09 && a < 0.14) ? 1 : 0.35;
        const x0 = 150 + random(`lx${i}`) * 780;
        const pts = bolt(`b${i}`, x0, -40, 200 + random(`le${i}`) * 680, 1300 + random(`ly${i}`) * 600);
        const branch = bolt(`br${i}`, x0 + 60, 500, x0 + (random(`lb${i}`) - 0.5) * 700, 1100, 4);
        return (
          <g key={i} opacity={flick}>
            <polyline points={pts} fill="none" stroke="#fff3d6" strokeWidth={7} strokeLinejoin="round" />
            <polyline points={pts} fill="none" stroke={C.mark} strokeWidth={18} opacity={0.35} strokeLinejoin="round" />
            <polyline points={branch} fill="none" stroke="#fff3d6" strokeWidth={4} opacity={0.8} />
          </g>
        );
      })}
    </svg>
  </AbsoluteFill>
);

// ─── Blueprint grid + honeycomb being built by agents ────────────────────────

const HEX = 70;
const HW = Math.sqrt(3) * HEX;
const hexPts = (r: number) =>
  Array.from({length: 6}, (_, i) => {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    return `${(Math.cos(a) * r).toFixed(1)},${(Math.sin(a) * r).toFixed(1)}`;
  }).join(' ');
const buildCells: Array<{x: number; y: number; d: number}> = [];
for (let r = -3; r <= 3; r++) {
  for (let q = -3; q <= 3; q++) {
    const x = 540 + (q + (r % 2 ? 0.5 : 0)) * HW;
    const y = 1050 + r * HEX * 1.5;
    const d = Math.hypot(x - 540, y - 1050);
    if (d < 520) buildCells.push({x, y, d});
  }
}
buildCells.sort((a, b) => a.d - b.d);

export const HoneycombBuild: React.FC<{t: number; start: number; dur: number}> = ({t, start, dur}) => {
  const a = t - start;
  const step = BEAT / 2;
  return (
    <AbsoluteFill>
      <AbsoluteFill
        style={{
          backgroundImage:
            'linear-gradient(rgba(229,166,69,0.10) 2px, transparent 2px), linear-gradient(90deg, rgba(229,166,69,0.10) 2px, transparent 2px)',
          backgroundSize: '60px 60px',
          backgroundPosition: `0 ${(a * 120) % 60}px`,
        }}
      />
      <svg width={1080} height={1920} style={{filter: glow(14, 0.7)}}>
        {buildCells.map((c, i) => {
          const at = i * (dur * 0.8 / buildCells.length);
          const k = clamp01((a - at) / step);
          if (k <= 0) {
            return <polygon key={i} points={hexPts(HEX * 0.92)} transform={`translate(${c.x},${c.y})`} fill="none" stroke="rgba(229,166,69,0.18)" strokeWidth={2} strokeDasharray="8 8" />;
          }
          // The agent triangle flies in from off-frame and drops the cell into place.
          const fromX = c.x + (random(`fx${i}`) - 0.5) * 1400;
          const fromY = c.y - 900 - random(`fy${i}`) * 500;
          const fly = easeOut(k);
          const tx = fromX + (c.x - fromX) * fly;
          const ty = fromY + (c.y - fromY) * fly;
          const land = clamp01((k - 0.85) / 0.15);
          return (
            <g key={i}>
              <polygon
                points={hexPts(HEX * 0.92)}
                transform={`translate(${c.x},${c.y}) scale(${0.6 + 0.4 * land})`}
                fill={i % 5 === 0 ? C.mark : C.brass}
                fillOpacity={land * (0.55 + 0.4 * Math.exp(-(a - at - step) / 0.3))}
                stroke={C.mark}
                strokeWidth={3}
                opacity={land}
              />
              {land < 1 && <polygon points="0,-18 16,12 -16,12" transform={`translate(${tx},${ty}) rotate(${fly * 360})`} fill={C.mark} />}
            </g>
          );
        })}
      </svg>
    </AbsoluteFill>
  );
};

// ─── Sunburst + giant merged check ───────────────────────────────────────────

export const Sunburst: React.FC<{t: number; start: number; label?: string}> = ({t, start, label = 'MERGED'}) => {
  const a = t - start;
  const pop = easeOut(a / 0.18);
  const rays = 18;
  return (
    <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center'}}>
      <svg width={1080} height={1920} style={{position: 'absolute', opacity: 0.85}}>
        <g transform={`translate(540, 820) rotate(${a * 40})`}>
          {Array.from({length: rays}, (_, i) => {
            const ang = (i / rays) * Math.PI * 2;
            const w = Math.PI / rays / 1.3;
            const r = 1500;
            return (
              <polygon
                key={i}
                points={`0,0 ${Math.cos(ang - w) * r},${Math.sin(ang - w) * r} ${Math.cos(ang + w) * r},${Math.sin(ang + w) * r}`}
                fill={i % 2 ? 'rgba(229,166,69,0.20)' : 'rgba(176,138,74,0.08)'}
              />
            );
          })}
        </g>
      </svg>
      <div style={{position: 'absolute', top: 560, transform: `scale(${1.6 - 0.6 * pop}) rotate(${(1 - pop) * -20}deg)`, filter: glow(40, 0.9)}}>
        <svg width={520} height={520} viewBox="0 0 100 100">
          <circle cx={50} cy={50} r={44} fill={C.slab} stroke={C.mark} strokeWidth={6} />
          <path d="M 28 52 L 44 67 L 73 35" fill="none" stroke={C.mark} strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - easeOut((a - 0.08) / 0.25)} />
        </svg>
      </div>
      <div style={{position: 'absolute', top: 1150, fontFamily: F.mono, fontWeight: 600, fontSize: 64, letterSpacing: 18, color: C.mark, opacity: clamp01((a - 0.15) / 0.15)}}>
        {label}
      </div>
    </AbsoluteFill>
  );
};

// ─── Spinning hexagon mandala ────────────────────────────────────────────────

export const HexMandala: React.FC<{t: number; start: number; pulse: number}> = ({t, start, pulse}) => {
  const a = t - start;
  return (
    <AbsoluteFill>
      <svg width={1080} height={1920} style={{filter: glow(16, 0.8)}}>
        <g transform="translate(540, 960)">
          {Array.from({length: 9}, (_, i) => {
            const r = 90 + i * 95 + pulse * 25 * (i % 2 ? 1 : -1);
            const rot = a * (i % 2 ? 35 : -28) + i * 12;
            return (
              <polygon
                key={i}
                points={hexPts(r)}
                transform={`rotate(${rot})`}
                fill="none"
                stroke={i % 3 === 0 ? C.mark : C.brass}
                strokeWidth={i % 3 === 0 ? 8 : 3}
                opacity={clamp01((a - i * 0.04) / 0.15) * (0.5 + 0.5 * (i % 3 === 0 ? 1 : 0.6))}
              />
            );
          })}
          {Array.from({length: 6}, (_, i) => {
            const ang = (i / 6) * 360 + a * 50;
            return (
              <g key={`m${i}`} transform={`rotate(${ang}) translate(0, -560) rotate(${-ang})`}>
                <g transform="translate(-60,-60) scale(0.5)">
                  <g transform={markData.transform}>
                    <path d={markData.path} fill={C.mark} opacity={0.85} />
                  </g>
                </g>
              </g>
            );
          })}
        </g>
      </svg>
    </AbsoluteFill>
  );
};

// ─── Giant approve button ────────────────────────────────────────────────────

export const BigApprove: React.FC<{t: number; start: number; pressAt: number}> = ({t, start, pressAt}) => {
  const a = t - start;
  const inK = easeOut(a / 0.25);
  const pressed = t >= pressAt;
  const p = t - pressAt;
  const squash = pressed ? 1 - 0.12 * Math.exp(-p / 0.07) : 1;
  return (
    <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center'}}>
      <div
        style={{
          width: 900,
          height: 300,
          borderRadius: 3,
          border: `8px solid ${C.mark}`,
          backgroundColor: pressed ? C.mark : 'rgba(20,9,26,0.85)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: F.mono,
          fontWeight: 600,
          fontSize: 96,
          letterSpacing: 20,
          color: pressed ? C.slab : C.mark,
          transform: `translateY(${(1 - inK) * 700}px) scale(${squash * (0.8 + 0.2 * inK)})`,
          boxShadow: pressed ? `0 0 ${160 * Math.exp(-p / 0.4) + 40}px rgba(229,166,69,0.9)` : '0 0 40px rgba(229,166,69,0.3)',
        }}
      >
        {pressed ? '✓ GO' : 'APPROVE'}
      </div>
    </AbsoluteFill>
  );
};

// ─── The mark flying through frame like a bee ────────────────────────────────

export const FlyingMark: React.FC<{t: number; start: number; dur?: number; size?: number}> = ({t, start, dur = 1.4, size = 360}) => {
  const k = (t - start) / dur;
  if (k < 0 || k > 1) return null;
  const e = easeInOut(k);
  const x = -300 + e * 1700;
  const y = 1500 - e * 1300 + Math.sin(k * Math.PI * 3) * 120;
  return (
    <div style={{position: 'absolute', left: x - size / 2, top: y - size / 2, transform: `rotate(${-20 + Math.sin(k * 9) * 12}deg)`, filter: glow(30, 1)}}>
      <svg width={size} height={size} viewBox="0 0 240 240">
        <g transform={markData.transform}>
          <path d={markData.path} fill={C.mark} />
        </g>
      </svg>
    </div>
  );
};
