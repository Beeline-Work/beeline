import React from 'react';
import {AbsoluteFill, random} from 'remotion';
import {C} from './theme';
import {clamp01, easeInOut, easeOut} from './timingFull';

// ─── Honeycomb wipe ──────────────────────────────────────────────────────────
// Hex cells grow from an origin until the frame is covered, then shrink away to
// reveal the next scene. `p` runs 0→1 across the whole wipe; the scene swaps at 0.5.

const HEX_R = 92;
const HEX_W = Math.sqrt(3) * HEX_R;
const cells: Array<{x: number; y: number}> = [];
for (let row = -1; row < 1920 / (HEX_R * 1.5) + 2; row++) {
  for (let col = -1; col < 1080 / HEX_W + 2; col++) {
    cells.push({x: col * HEX_W + (row % 2 ? HEX_W / 2 : 0), y: row * HEX_R * 1.5});
  }
}
const hexPoints = (r: number) =>
  Array.from({length: 6}, (_, i) => {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    return `${(Math.cos(a) * r).toFixed(1)},${(Math.sin(a) * r).toFixed(1)}`;
  }).join(' ');

export const HexWipe: React.FC<{p: number; ox?: number; oy?: number}> = ({p, ox = 540, oy = 960}) => {
  if (p <= 0 || p >= 1) return null;
  const maxD = 2300;
  return (
    <AbsoluteFill>
      <svg width={1080} height={1920}>
        {cells.map((c, i) => {
          const d = Math.hypot(c.x - ox, c.y - oy) / maxD;
          const cover = easeOut(clamp01((p * 2 - d * 0.7) / 0.3));
          const reveal = easeInOut(clamp01(((p - 0.5) * 2 - d * 0.7) / 0.3));
          const s = cover * (1 - reveal);
          if (s <= 0.01) return null;
          const edge = s < 0.98 ? 1 : 0;
          return (
            <g key={i} transform={`translate(${c.x},${c.y}) scale(${s * 1.04})`}>
              <polygon points={hexPoints(HEX_R)} fill={C.slab} stroke={C.mark} strokeWidth={edge * 5} />
            </g>
          );
        })}
      </svg>
    </AbsoluteFill>
  );
};

// ─── Orbiters ────────────────────────────────────────────────────────────────
// Beeline's identity marks — triangles for agents, circles for people — orbit a
// center in pseudo-3D with glowing trails. Split into back/front layers so they
// pass behind and in front of whatever sits at the center.

type Orb = {kind: 'agent' | 'human'; hue: string; r: number; speed: number; phase: number; tilt: number; size: number};
export const ORBS: Orb[] = [
  {kind: 'agent', hue: '#c9a24a', r: 520, speed: 0.9, phase: 0, tilt: 0.32, size: 58},
  {kind: 'agent', hue: '#5f9e8f', r: 610, speed: 0.7, phase: 2.2, tilt: -0.22, size: 50},
  {kind: 'agent', hue: '#c96f6a', r: 470, speed: 1.1, phase: 4.1, tilt: 0.12, size: 44},
  {kind: 'human', hue: '#7d8fa8', r: 560, speed: 0.55, phase: 1.1, tilt: -0.4, size: 46},
  {kind: 'agent', hue: '#9b86c9', r: 680, speed: 0.8, phase: 3.3, tilt: 0.45, size: 40},
];

function orbAt(o: Orb, t: number, cx: number, cy: number, spread: number) {
  const a = o.phase + o.speed * t;
  const x = cx + Math.cos(a) * o.r * spread;
  const z = Math.sin(a);
  const y = cy + z * o.r * 0.28 * spread + Math.cos(a) * o.r * o.tilt * spread;
  return {x, y, z, a};
}

const Shape: React.FC<{o: Orb; size: number; opacity: number; rot: number}> = ({o, size, opacity, rot}) => (
  <svg width={size} height={size} viewBox="-20 -20 40 40" style={{position: 'absolute', left: -size / 2, top: -size / 2, opacity, overflow: 'visible'}}>
    <g transform={`rotate(${rot})`}>
      {o.kind === 'agent' ? (
        <polygon points="0,-16 14,10 -14,10" fill={o.hue} stroke="#f4f1e8" strokeWidth={1.2} />
      ) : (
        <circle r={13} fill={o.hue} stroke="#f4f1e8" strokeWidth={1.2} />
      )}
    </g>
  </svg>
);

export const Orbiters: React.FC<{t: number; cx: number; cy: number; layer: 'back' | 'front'; spread?: number; speed?: number; opacity?: number}> = ({
  t,
  cx,
  cy,
  layer,
  spread = 1,
  speed = 1,
  opacity = 1,
}) => (
  <AbsoluteFill style={{pointerEvents: 'none'}}>
    {ORBS.map((o, i) => {
      const tt = t * speed;
      const head = orbAt(o, tt, cx, cy, spread);
      if ((layer === 'front') !== head.z > 0) return null;
      const trail = [6, 5, 4, 3, 2, 1].map((k) => orbAt(o, tt - k * 0.045, cx, cy, spread));
      const depth = 0.65 + 0.35 * (head.z + 1) / 2;
      return (
        <div key={i}>
          {trail.map((p, k) => (
            <div key={k} style={{position: 'absolute', left: p.x, top: p.y, transform: `scale(${depth * (0.4 + k * 0.1)})`}}>
              <Shape o={o} size={o.size} opacity={opacity * 0.08 * (k + 1)} rot={p.a * 57} />
            </div>
          ))}
          <div style={{position: 'absolute', left: head.x, top: head.y, transform: `scale(${depth})`, filter: `drop-shadow(0 0 18px ${o.hue})`}}>
            <Shape o={o} size={o.size} opacity={opacity} rot={head.a * 57} />
          </div>
        </div>
      );
    })}
  </AbsoluteFill>
);

// ─── Light leaks ─────────────────────────────────────────────────────────────

export const LightLeaks: React.FC<{t: number; strength?: number}> = ({t, strength = 1}) => (
  <AbsoluteFill style={{mixBlendMode: 'screen', pointerEvents: 'none'}}>
    {[0, 1, 2].map((i) => {
      const x = 540 + Math.sin(t * (0.35 + i * 0.13) + i * 2) * 620;
      const y = 960 + Math.cos(t * (0.27 + i * 0.11) + i) * 900;
      const r = 700 + i * 180;
      return (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: x - r,
            top: y - r,
            width: r * 2,
            height: r * 2,
            borderRadius: '50%',
            background: `radial-gradient(circle, rgba(201,162,74,${0.2 * strength}) 0%, rgba(30,153,99,${0.07 * strength}) 40%, transparent 70%)`,
          }}
        />
      );
    })}
  </AbsoluteFill>
);

// ─── Floating hexagon outlines drifting through the frame ───────────────────

export const DriftHexes: React.FC<{t: number; count?: number; speed?: number; opacity?: number}> = ({t, count = 12, speed = 1, opacity = 1}) => (
  <AbsoluteFill style={{pointerEvents: 'none'}}>
    <svg width={1080} height={1920}>
      {Array.from({length: count}, (_, i) => {
        const r = 30 + random(`hr${i}`) * 110;
        const x = random(`hx${i}`) * 1080 + Math.sin(t * 0.6 + i) * 50;
        const period = 2300;
        const y = ((random(`hy${i}`) * period - t * speed * (120 + r)) % period + period) % period - 190;
        const rot = t * 20 * (random(`hs${i}`) - 0.5) + i * 17;
        return (
          <g key={i} transform={`translate(${x},${y}) rotate(${rot})`} opacity={opacity * (0.25 + random(`ho${i}`) * 0.5)}>
            <polygon points={hexPoints(r)} fill="none" stroke={C.mark} strokeWidth={2 + r / 40} />
          </g>
        );
      })}
    </svg>
  </AbsoluteFill>
);

// ─── 3D camera wrapper ───────────────────────────────────────────────────────

export const Stage3D: React.FC<{rx?: number; ry?: number; rz?: number; z?: number; x?: number; y?: number; children: React.ReactNode}> = ({
  rx = 0,
  ry = 0,
  rz = 0,
  z = 0,
  x = 0,
  y = 0,
  children,
}) => (
  <AbsoluteFill style={{perspective: 1900, perspectiveOrigin: '50% 50%'}}>
    <AbsoluteFill
      style={{
        transformStyle: 'preserve-3d',
        transform: `translate3d(${x}px, ${y}px, ${z}px) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg)`,
      }}
    >
      {children}
    </AbsoluteFill>
  </AbsoluteFill>
);

export const Flash: React.FC<{age: number; color?: string; decay?: number; max?: number}> = ({age, color = '#fff6e4', decay = 0.14, max = 1}) =>
  age >= 0 && age < decay * 6 ? <AbsoluteFill style={{backgroundColor: color, opacity: max * Math.exp(-age / decay), pointerEvents: 'none'}} /> : null;
