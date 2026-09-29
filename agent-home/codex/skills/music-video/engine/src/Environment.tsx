import React, {useLayoutEffect, useRef} from 'react';
import {AbsoluteFill} from 'remotion';
import {FRAG, VERT} from './shader';

export type EnvUniforms = {
  t: number;
  beat: number;
  down: number;
  flow: number;
  heat: number;
  w: [number, number, number, number, number];
  shock: number;
  portal?: number;
};

// Rendered at half resolution and scaled up: the environment is soft by nature,
// and a quarter of the pixels keeps software GL rendering fast.
const W = 540;
const H = 960;

type Ctx = {gl: WebGLRenderingContext; prog: WebGLProgram; loc: Record<string, WebGLUniformLocation | null>};

function init(canvas: HTMLCanvasElement): Ctx {
  const gl = canvas.getContext('webgl', {preserveDrawingBuffer: true, antialias: false})!;
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link error');
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const p = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(p);
  gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
  const names = ['uRes', 'uTime', 'uBeat', 'uDown', 'uFlow', 'uHeat', 'uW0', 'uW1', 'uW2', 'uW3', 'uW4', 'uShock', 'uPortal'];
  const loc: Ctx['loc'] = {};
  names.forEach((n) => (loc[n] = gl.getUniformLocation(prog, n)));
  return {gl, prog, loc};
}

export const Environment: React.FC<{u: EnvUniforms}> = ({u}) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const ctx = useRef<Ctx | null>(null);
  useLayoutEffect(() => {
    if (!ref.current) return;
    if (!ctx.current) ctx.current = init(ref.current);
    const {gl, loc} = ctx.current;
    gl.viewport(0, 0, W, H);
    gl.uniform2f(loc.uRes, W, H);
    gl.uniform1f(loc.uTime, u.t);
    gl.uniform1f(loc.uBeat, u.beat);
    gl.uniform1f(loc.uDown, u.down);
    gl.uniform1f(loc.uFlow, u.flow);
    gl.uniform1f(loc.uHeat, u.heat);
    u.w.forEach((w, i) => gl.uniform1f(loc[`uW${i}`], w));
    gl.uniform1f(loc.uShock, u.shock);
    gl.uniform1f(loc.uPortal, u.portal ?? 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.finish();
  });
  return (
    <AbsoluteFill>
      <canvas ref={ref} width={W} height={H} style={{width: '100%', height: '100%'}} />
    </AbsoluteFill>
  );
};
