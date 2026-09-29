// One fullscreen fragment shader holding every environment. Scenes blend by weight:
// w0 river flyover · w1 night smoke + stars · w2 warp tunnel · w3 fire · w4 ring tunnel.

export const VERT = `
attribute vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }
`;

export const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uBeat;     // 0..1 decaying pulse on each beat
uniform float uDown;     // 0..1 decaying pulse on each downbeat
uniform float uFlow;     // integrated travel distance (speed surges accumulate)
uniform float uHeat;     // global intensity
uniform float uW0, uW1, uW2, uW3, uW4;
uniform float uShock;    // seconds since a shockwave (large = none)
uniform float uPortal;   // 0..1: the ring tunnel stands on the river's horizon as a portal

// Test Atlas tokens: ink-900, deep ink green, brand green, gold-500, cream-100.
const vec3 SLAB  = vec3(0.051, 0.094, 0.078);
const vec3 AUB   = vec3(0.09, 0.20, 0.16);
const vec3 BRASS = vec3(0.118, 0.60, 0.388);
const vec3 GOLD  = vec3(0.79, 0.635, 0.29);
const vec3 HOT   = vec3(0.957, 0.945, 0.91);
const vec3 LEAF  = vec3(0.345, 0.843, 0.573);

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = r * p * 2.03; a *= 0.5; }
  return v;
}
vec3 goldRamp(float x) {
  x = clamp(x, 0.0, 1.0);
  vec3 c = mix(SLAB, AUB, smoothstep(0.0, 0.3, x));
  c = mix(c, BRASS, smoothstep(0.3, 0.62, x));
  c = mix(c, GOLD, smoothstep(0.62, 0.82, x));
  return mix(c, HOT, 0.6 * smoothstep(0.9, 1.05, x));
}

vec3 rings(vec2 uv);

// Flying low over a river of liquid gold toward the horizon.
vec3 river(vec2 uv) {
  float horizon = 0.18;
  float d = horizon - uv.y;
  vec3 sky = mix(AUB * 0.6, SLAB, smoothstep(0.0, 0.9, uv.y - horizon));
  sky += GOLD * 0.35 * exp(-abs(uv.y - horizon) * 9.0) * (0.7 + 0.6 * uDown);
  if (d <= 0.0) {
    if (uPortal < 0.001) return sky;
    // The honeycomb tunnel rises out of the horizon: one camera, one horizon line.
    vec3 portal = rings((uv - vec2(0.0, horizon)) * 1.35);
    return mix(sky, portal, uPortal * smoothstep(0.0, 0.025, -d));
  }
  float z = 0.45 / d;
  vec2 q = vec2(uv.x * z, z + uFlow * 1.6);
  vec2 w = vec2(fbm(q * 0.6 + vec2(0.0, uTime * 0.2)), fbm(q * 0.6 + 4.1));
  float f = fbm(q * 0.9 + w * 2.2);
  float vein = pow(1.0 - abs(2.0 * fbm(q * 1.3 + w * 1.6) - 1.0), 7.0);
  float bank = exp(-pow(uv.x * z * 0.55, 2.0));
  float v = 0.22 * f + vein * (0.55 + 0.7 * bank) + 0.25 * uBeat * bank;
  vec3 c = goldRamp(v * (0.85 + 0.35 * uHeat));
  c += GOLD * pow(max(0.0, f - 0.55), 3.0) * 3.0 * bank;
  c *= 0.8;
  // The portal's rings shimmer as a reflection on the water.
  if (uPortal > 0.001) {
    vec3 refl = rings(vec2(uv.x, (horizon - uv.y) * 0.9) * 1.35 + vec2(0.02 * sin(q.y * 3.0 + uTime * 4.0), 0.0));
    c += refl * uPortal * 0.35 * exp(-d * 3.0);
  }
  float fog = exp(-d * 2.2);
  return mix(c, sky, 1.0 - smoothstep(0.0, 0.12, d) * (1.0 - fog * 0.6));
}

// Slow night nebula with drifting smoke and twinkling stars.
vec3 night(vec2 uv) {
  vec2 q = uv * 1.4 + vec2(uTime * 0.03, -uTime * 0.05);
  float s = fbm(q + fbm(q * 1.7 + uTime * 0.04));
  vec3 c = mix(SLAB, AUB * 2.0, smoothstep(0.3, 0.85, s));
  c += BRASS * 0.7 * pow(s, 3.5);
  vec2 g = uv * 42.0;
  vec2 id = floor(g);
  float star = hash(id);
  vec2 sp = fract(g) - 0.5 - (vec2(hash(id + 3.1), hash(id + 7.7)) - 0.5) * 0.6;
  float tw = 0.5 + 0.5 * sin(uTime * (2.0 + star * 5.0) + star * 40.0);
  c += HOT * smoothstep(0.09, 0.0, length(sp)) * step(0.82, star) * tw * (0.6 + 0.8 * uBeat);
  return c;
}

// Stars stretched into streaks rushing out of a tunnel.
vec3 warp(vec2 uv) {
  float r = length(uv);
  float a = atan(uv.y, uv.x);
  float lanes = 150.0;
  float lane = floor((a / 6.2832 + 0.5) * lanes);
  float h = hash(vec2(lane, 1.0));
  float z = fract(h * 7.0 - uFlow * (0.6 + h));
  float streak = smoothstep(0.02 + 0.12 * z * z, 0.0, abs(r - z * 1.6)) * smoothstep(0.0, 0.25, r);
  float width = smoothstep(0.5, 0.0, abs(fract((a / 6.2832 + 0.5) * lanes) - 0.5) * 2.0);
  vec3 c = SLAB + AUB * 0.6 * exp(-r * 1.5);
  c += mix(BRASS, HOT, h) * streak * width * (1.2 + uHeat * 2.0);
  c += GOLD * 0.3 * exp(-r * 6.0) * (0.5 + 0.6 * uHeat);
  return c;
}

// Flying low over a topographic map: glowing contour lines, a survey grid and
// gold summit rings (the "atlas").
vec3 topo(vec2 uv) {
  float horizon = 0.2;
  float d = horizon - uv.y;
  vec3 sky = mix(AUB * 0.5, SLAB, smoothstep(0.0, 0.9, uv.y - horizon));
  sky += LEAF * 0.22 * exp(-abs(uv.y - horizon) * 10.0) * (0.7 + 0.6 * uDown);
  if (d <= 0.0) return sky;
  float z = 0.5 / d;
  vec2 q = vec2(uv.x * z, z + uFlow * 1.3);
  vec2 base = q * 0.35 + vec2(3.0, 1.7);
  float h = fbm(base);
  // Line width in pixels: h's change per pixel from a finite-difference gradient and
  // the perspective footprint of one pixel (dq/dx = z, dq/dy = 2 z^2 per unit uv).
  float e = 0.02;
  vec2 gq = vec2(fbm(base + vec2(e, 0.0)) - h, fbm(base + vec2(0.0, e)) - h) / e * 0.35;
  float hpp = length(vec2(gq.x * z, gq.y * 2.0 * z * z)) / uRes.y + 1e-5;
  float lines = 14.0;
  float distH = (0.5 - abs(fract(h * lines) - 0.5)) / lines;
  float far = smoothstep(0.02, 0.16, d);
  float contour = smoothstep(2.4, 0.8, distH / hpp) * far;
  float major = step(3.5, mod(floor(h * lines + 0.5), 4.0)) * contour;
  vec2 g = abs(fract(q * 0.5) - 0.5);
  float grid = smoothstep(0.03 * z, 0.0, min(g.x, g.y)) * 0.35;
  vec3 c = mix(SLAB, AUB, smoothstep(0.3, 0.8, h)) * 0.9;
  c += BRASS * contour * (0.5 + 0.5 * uBeat);
  c += GOLD * major * (0.6 + 0.4 * uHeat);
  c += LEAF * grid * far * (0.25 + 0.4 * uDown);
  float fog = exp(-d * 2.0);
  return mix(c, sky, 1.0 - smoothstep(0.0, 0.14, d) * (1.0 - fog * 0.5));
}

// Flying through rings of green and gold.
vec3 rings(vec2 uv) {
  float r = length(uv);
    float hexd = r; // round rings (the hex honeycomb was Beeline's)
  float depth = 0.35 / max(hexd, 0.01) + uFlow * 2.0;
  float dn = floor(depth + 0.5);
  float rr = 0.35 / max(dn - uFlow * 2.0, 0.05);
  float ring = smoothstep(0.004 + 0.012 * hexd, 0.0, abs(hexd - rr)) * smoothstep(1.4, 0.2, hexd);
  float a = atan(uv.y, uv.x);
  float spokes = 0.5 + 0.5 * sin(a * 6.0 + depth * 0.7);
  vec3 c = SLAB + AUB * exp(-r * 1.2);
  c += mix(BRASS, GOLD, spokes) * ring * smoothstep(0.02, 0.3, hexd) * (0.75 + uBeat * 0.8);
  c += HOT * ring * pow(spokes, 8.0) * 0.5;
  c += GOLD * 0.08 * smoothstep(0.45, 0.0, abs(fract(depth) - 0.5)) * exp(-hexd * 2.0);
  c += GOLD * 0.18 * exp(-r * 6.0);
  return c;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec3 c = vec3(0.0);
  float wsum = uW0 + uW1 + uW2 + uW3 + uW4 + 1e-4;
  if (uW0 > 0.001) c += uW0 * river(uv);
  if (uW1 > 0.001) c += uW1 * night(uv);
  if (uW2 > 0.001) c += uW2 * warp(uv);
  if (uW3 > 0.001) c += uW3 * topo(uv);
  if (uW4 > 0.001) c += uW4 * rings(uv);
  c /= max(wsum, 1.0);
  // Shockwave ring.
  float sr = uShock * 1.6;
  float shock = exp(-pow((length(uv) - sr) * 18.0, 2.0)) * exp(-uShock * 2.5);
  c += mix(GOLD, HOT, 0.25) * shock * 0.55;
  // Vignette + beat lift.
  c *= 1.0 - 0.55 * pow(length(uv * vec2(1.4, 0.9)), 2.2);
  c += GOLD * 0.05 * uBeat;
  gl_FragColor = vec4(c, 1.0);
}
`;
