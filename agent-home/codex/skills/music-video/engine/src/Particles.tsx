import React, {useLayoutEffect, useRef} from 'react';
import {AbsoluteFill, random} from 'remotion';
import {getLength, getPointAtLength} from '@remotion/paths';
import markData from './mark.json';
import {clamp01, easeInOut} from './timingFull';

// Every particle is a closed-form function of time, so any frame renders
// identically in any order (Remotion renders frames out of order in parallel).

export type Burst = {at: number; x: number; y: number; count?: number; power?: number};
export type ParticleSpec = {
  embers?: number; // 0..1 density of rising embers
  fireflies?: number; // 0..1 density of drifting night fireflies
  bursts?: Burst[];
  swarm?: {start: number; form: number; cx: number; cy: number; size: number}; // bees → mark
};

const W = 1080;
const H = 1920;

let markPoints: Array<{x: number; y: number}> | null = null;
function getMarkPoints(): Array<{x: number; y: number}> {
  if (markPoints) return markPoints;
  const len = getLength(markData.path);
  const n = 900;
  // transform="translate(20.087671 20.087671) scale(0.83260274)" inside a 240 viewBox
  markPoints = Array.from({length: n}, (_, i) => {
    const p = getPointAtLength(markData.path, (i / n) * len) ?? {x: 120, y: 120};
    return {x: (20.087671 + 0.83260274 * p.x) / 240, y: (20.087671 + 0.83260274 * p.y) / 240};
  });
  return markPoints;
}

function glowDot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, a: number, hot = false) {
  if (a <= 0.01) return;
  ctx.globalAlpha = a * 0.22;
  ctx.fillStyle = '#c9a24a';
  ctx.beginPath();
  ctx.arc(x, y, r * 3.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = a;
  ctx.fillStyle = hot ? '#f4f1e8' : '#58d792';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function draw(ctx: CanvasRenderingContext2D, t: number, spec: ParticleSpec) {
  ctx.clearRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';

  if (spec.embers && spec.embers > 0) {
    const n = Math.floor(170 * spec.embers);
    for (let i = 0; i < n; i++) {
      const period = 1.8 + random(`ep${i}`) * 2.4;
      const age = (t + random(`eo${i}`) * period) % period;
      const life = age / period;
      const x0 = random(`ex${i}`) * W;
      const x = x0 + Math.sin(t * (1 + random(`ew${i}`) * 2) + i) * 40 + (life * 120 * (random(`ed${i}`) - 0.5));
      const y = H + 40 - life * (H * (0.55 + random(`eh${i}`) * 0.6));
      const r = 1.5 + random(`er${i}`) * 3.5;
      glowDot(ctx, x, y, r * (1 - life * 0.5), Math.sin(life * Math.PI) * 0.9, random(`eH${i}`) > 0.8);
    }
  }

  if (spec.fireflies && spec.fireflies > 0) {
    const n = Math.floor(70 * spec.fireflies);
    for (let i = 0; i < n; i++) {
      const cx = random(`fx${i}`) * W;
      const cy = random(`fy${i}`) * H;
      const sp = 0.2 + random(`fs${i}`) * 0.5;
      const x = cx + Math.sin(t * sp + i) * 90 + Math.sin(t * sp * 2.3 + i * 3) * 30;
      const y = cy + Math.cos(t * sp * 0.8 + i * 1.7) * 70 - t * 12;
      const tw = 0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.sin(t * (1.5 + random(`ft${i}`) * 3) + i), 3);
      glowDot(ctx, ((x % W) + W) % W, ((y % H) + H) % H, 2.2, tw * spec.fireflies);
    }
  }

  for (const b of spec.bursts ?? []) {
    const age = t - b.at;
    if (age < 0 || age > 1.6) continue;
    const n = b.count ?? 90;
    const power = b.power ?? 1;
    for (let i = 0; i < n; i++) {
      const a = random(`ba${b.at}${i}`) * Math.PI * 2;
      const v = (500 + random(`bv${b.at}${i}`) * 1500) * power;
      const drag = (1 - Math.exp(-age * 3)) / 3;
      const x = b.x + Math.cos(a) * v * drag;
      const y = b.y + Math.sin(a) * v * drag + 420 * age * age;
      const fade = clamp01(1 - age / (0.8 + random(`bl${b.at}${i}`) * 0.8));
      // Short trail along the velocity for a streaking spark.
      const vx = Math.cos(a) * v * Math.exp(-age * 3);
      const vy = Math.sin(a) * v * Math.exp(-age * 3) + 840 * age;
      ctx.globalAlpha = fade;
      ctx.strokeStyle = '#58d792';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - vx * 0.035, y - vy * 0.035);
      ctx.stroke();
      glowDot(ctx, x, y, 2.5, fade, true);
    }
  }

  if (spec.swarm) {
    const {start, form, cx, cy, size} = spec.swarm;
    const pts = getMarkPoints();
    for (let i = 0; i < pts.length; i++) {
      // Each bee buzzes around its own orbit, then flies to its point on the mark.
      const delay = random(`sd${i}`) * 0.5;
      const k = easeInOut(clamp01((t - form - delay + 0.6) / 0.9));
      const orbitR = 260 + random(`sr${i}`) * 520;
      const w = (1.2 + random(`sw${i}`) * 1.6) * (random(`sg${i}`) > 0.5 ? 1 : -1);
      const ang = random(`sa${i}`) * Math.PI * 2 + w * (t - start);
      const ox = cx + Math.cos(ang) * orbitR + Math.sin(t * 5 + i) * 18;
      const oy = cy + Math.sin(ang) * orbitR * 0.7 + Math.cos(t * 6 + i) * 18;
      const tx = cx + (pts[i].x - 0.5) * size;
      const ty = cy + (pts[i].y - 0.5) * size;
      const x = ox + (tx - ox) * k;
      const y = oy + (ty - oy) * k;
      const appear = clamp01((t - start - random(`sp${i}`) * 0.6) / 0.3);
      glowDot(ctx, x, y, 2 + (1 - k) * 1.5, appear * (0.55 + 0.45 * k), k > 0.95);
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

export const Particles: React.FC<{t: number; spec: ParticleSpec}> = ({t, spec}) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (ctx) draw(ctx, t, spec);
  });
  return (
    <AbsoluteFill style={{pointerEvents: 'none'}}>
      <canvas ref={ref} width={W} height={H} style={{width: '100%', height: '100%'}} />
    </AbsoluteFill>
  );
};
