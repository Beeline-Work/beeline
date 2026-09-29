import React from 'react';
import {AbsoluteFill, Audio, random, staticFile, useCurrentFrame} from 'remotion';
import {AtlasMark, BatteryDrain, ClimbChart, ColdCoffee, DrillCards, HighlighterSwipe, LifeLine, PassageTunnel, EndCard, FamilyBars, FamilyMap, FlatScore, HighlightPage, LoopRing, MatchLine, MomChat, PassageStrike, PatternCrack, PatternPulse, PatternSnap, PoisonWords, QuickCheck, Receipt, Rewind, ShareBurst, TrapChoices, TrapField, Wordmark} from './atlas';
import {NightClock, VaultLock, WordStorm} from './graphics2';
import {GlitchSplit, KineticWord, Streak} from './components';
import {Environment, EnvUniforms} from './Environment';
import {Flash, LightLeaks} from './fx';
import {Burst, Particles, ParticleSpec} from './Particles';
import {C} from './theme';
import timeline from './fullTimeline.json'; // written by build_timeline.py
import {BEAT, FPS, SEC, beatPulse, beatsIn, clamp01, downbeatPulse, easeInOut, word, wordAt} from './timingFull';

// Test Atlas — full song (seed 808, 2:30). Every scene change and graphic cue is keyed
// to a verified sung word (fullTimeline.json) or a measured instrumental hit/gap.

type Weights = [number, number, number, number, number];
const RIVER: Weights = [1, 0, 0, 0, 0];
const NIGHT: Weights = [0, 1, 0, 0, 0];
const WARP: Weights = [0, 0, 1, 0, 0];
const TOPO: Weights = [0, 0, 0, 1, 0];
const RINGS: Weights = [0, 0, 0, 0, 1];
const DIMNIGHT: Weights = [0, 0.7, 0, 0.3, 0];

const HITS: number[] = timeline.hits;
const GAPS: Array<[number, number]> = timeline.gaps as Array<[number, number]>;
const inGap = (t: number) => GAPS.some(([a, b]) => t >= a && t < b);
const SHOCKS = [0.56, 1.41, 18.47, 36.35, 40.44, 44.16, SEC.drop, 49.64, SEC.drop2, 93.56, SEC.bridge, SEC.outro];

// First word with this text at/after `from` (throws if the lyric changed).
const w = (text: string, from: number) => word(text, from - 0.001);
const P1 = {
  i: w('I', 28.4), found: w('FOUND', 28.4), pattern0: w('PATTERN', 28.9), like: w('LIKE', 29.5), knew: w('KNEW', 30), could: w('COULD', 30.4),
  its: w("IT'S", 30.7), not: w('NOT', 30.9), no: w('NO', 32), its2: w("IT'S", 32.5), a2: w('A', 32.7), pattern: w('PATTERN', 32.9), test: w('TEST', 33.1), yes: w('YES', 33.4),
  find: w('FIND', 34), costing: w('COSTING', 34.8), me: w('ME', 35), drill: w('DRILL', 35.5), it: w('IT', 35.8), then: w('THEN', 36), reassess: w('REASSESS', 36.3),
  drill2: w('DRILL', 39.9), it2: w('IT', 40.1), reassess2: w('REASSESS', 40.4), here: w('HERE', 42),
};
const CH1 = {
  i: w('I', 44.1), map: w('MAP', 44.6), hey: w('HEY', 45), i2: w('I', 45.4), way: w('WAY', 46.2), hey2: w('HEY', 46.5), every: w('EVERY', 47),
  trap: w('TRAP', 47.3), set: w('SET', 47.8), see: w('SEE', 48.2), it: w('IT', 48.4), from: w('FROM', 48.6), mile: w('MILE', 49),
  runs: [w('RUN', 49.8), w('RUN', 50.6), w('RUN', 51.4), w('RUN', 51.7)], again: w('AGAIN', 52.3), watch: w('WATCH', 53.3),
};
const HOLD_END = 39.47; // the held "reassess" ends here (vocal level)
const BACKING = [43.38, 43.56, 43.76]; // high backing shouts before the chorus

const inWin = (t: number, a: number, b: number) => t >= a && t < b;
const WORDS_IN = (a: number, b: number) => (timeline.words as Array<{start: number}>).map((x) => x.start).filter((x) => x >= a && x < b);
const decayFrom = (t: number, marks: number[], tau: number) => Math.max(0, ...marks.map((m) => (t >= m ? Math.exp(-(t - m) / tau) : 0)));
const hitsIn = (a: number, b: number) => HITS.filter((h) => h >= a && h < b);

function speed(t: number): number {
  if (inGap(t)) return 0.06;
  const hit = decayFrom(t, HITS, 0.3);
  if (t < SEC.verse1b) return 0.45 + 1.2 * hit;
  if (t < SEC.pre1) return 0.7 + 1.6 * hit;
  if (inWin(t, P1.reassess, HOLD_END)) return 0.5 + 2.5 * Math.pow((t - P1.reassess) / (HOLD_END - P1.reassess), 2);
  if (inWin(t, P1.here, SEC.chorus1)) return 0.8 + 3 * Math.pow(clamp01((t - P1.here) / (SEC.chorus1 - P1.here)), 2);
  if (t < SEC.chorus1) return 0.8 + 1.4 * hit;
  if (inWin(t, SEC.verse2, SEC.pre2)) return 0.7 + 1.2 * hit;
  if (inWin(t, SEC.bridge, SEC.final)) return 1.4 + 2 * beatPulse(t, 0.12);
  return 1.1 + 2 * beatPulse(t, 0.12) + 2.4 * hit;
}
const FLOW_DT = 1 / 120;
const flowTable: number[] = [0];
function flowAt(t: number): number {
  const n = Math.floor(t / FLOW_DT);
  while (flowTable.length <= n + 1) {
    const i = flowTable.length - 1;
    flowTable.push(flowTable[i] + speed(i * FLOW_DT) * FLOW_DT);
  }
  return flowTable[n] + (flowTable[n + 1] - flowTable[n]) * ((t - n * FLOW_DT) / FLOW_DT);
}
function env(t: number, wts: Weights, heat?: number): EnvUniforms {
  const last = SHOCKS.filter((s) => s <= t).pop();
  const quiet = inGap(t);
  return {t, beat: quiet ? 0 : beatPulse(t), down: quiet ? 0 : downbeatPulse(t), flow: flowAt(t), heat: heat ?? 0.6 + 0.4 * downbeatPulse(t), w: wts, shock: last === undefined ? 99 : t - last};
}

// ─── Shot model (same engine as the Beeline video) ───────────────────────────

type Enter = 'cut' | 'flash' | 'zoom' | 'whip' | 'slice' | 'iris';
type ShotOut = {
  w: Weights;
  heat?: number;
  layers?: React.ReactNode[];
  spec?: ParticleSpec;
  bursts?: Burst[];
  words?: {y: number; max?: number; color?: string} | null;
  glitch?: number;
  shake?: number;
  dim?: number;
  invert?: number;
  mono?: 'black' | 'white'; // "black and white": stark greyscale, then inverted to white
};
type Shot = {start: number; end: number; enter: Enter; render: (t: number, s: Shot) => ShotOut};

const Grain: React.FC<{t: number}> = ({t}) => (
  <AbsoluteFill style={{pointerEvents: 'none'}}>
    <AbsoluteFill style={{backgroundImage: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.16) 0px, rgba(0,0,0,0.16) 2px, transparent 2px, transparent 5px)', opacity: 0.4}} />
    <AbsoluteFill
      style={{
        backgroundImage: `url(${staticFile('noise.png')})`,
        backgroundPosition: `${Math.floor(random(`gx${Math.floor(t * 30)}`) * 256)}px ${Math.floor(random(`gy${Math.floor(t * 30)}`) * 256)}px`,
        opacity: 0.45,
        mixBlendMode: 'overlay',
      }}
    />
  </AbsoluteFill>
);

const hitStreaks = (t: number, marks: number[], seed: number) =>
  marks.map((s, i) => <Streak key={`hs${seed}${i}`} age={t - s} y={320 + ((i * 419 + seed * 53) % 1250)} seed={i + seed} thickness={12} angle={i % 2 ? -20 : -38} />);

function buildOut(t: number, from: number, to: number): {flicker: number; build: number} {
  const build = clamp01((t - from) / (to - from));
  const toDrop = to - t;
  const sub = toDrop < 0.5 ? BEAT / 4 : BEAT / 2;
  const flicker = build * Math.exp(-((((t - 0.375) % sub) + sub) % sub / sub) * 4);
  return {flicker, build};
}

const ADVICE = ['read harder', 're-read it', 'slow down', 'annotate', 'read it again', 'more practice', 'focus', 'read slower', 'take notes', 'grind'];
const gapStartIn = (a: number, b: number) => GAPS.find(([g]) => g > a && g < b)?.[0];
const gapEndIn = (a: number, b: number) => GAPS.find(([, g]) => g > a && g < b)?.[1];

// A chorus, located from its own words and music cut-outs (the three choruses share
// the melody but not the arrangement: the music drops out in different places).
function chorus(i0: number, kind: 'full' | 'final', end: number, alt: boolean): Shot[] {
  const i = w('I', i0);
  const map = w('MAP', i);
  const hey = w('HEY', map);
  const i2 = w('I', hey);
  const way = w('WAY', i2);
  const hey2 = w('HEY', way);
  const every = w('EVERY', hey2);
  const trap = w('TRAP', every);
  const set = w('SET', trap);
  const see = w('SEE', set);
  const it = w('IT', see);
  const from = w('FROM', it);
  const mile = w('MILE', from);
  const gapA = gapStartIn(i, i2 + 0.01);
  const s1end = gapA ?? i2;
  const shots: Shot[] = [
    {start: i, end: s1end, enter: 'flash', render: (t) => ({w: alt ? RINGS : NIGHT, heat: 0.9, layers: [<AtlasMark key="am" progress={clamp01((t - i) / (map + 0.12 - i))} size={560} y={880} pulse={decayFrom(t, [map, hey], 0.3)} />], bursts: [{at: hey, x: 540, y: 880, count: 80, power: 0.8}], words: {y: 1500, max: 260}})},
    {start: s1end, end: every, enter: 'cut', render: (t, s) => ({w: NIGHT, heat: inGap(t) ? 0.15 : 0.6, layers: [<FamilyMap key="fm" t={t} start={s.start - 0.3} target={-1} routeFrom={i2} routeTo={way + 0.3} zoom={1.02} />, <AtlasMark key="am" progress={1} size={150} y={260} pulse={decayFrom(t, [hey2], 0.3)} />], words: {y: 1720, max: 240}})},
    {start: every, end: from, enter: 'flash', render: (t, s) => ({w: alt ? [0, 0.4, 0, 0.6, 0] : DIMNIGHT, heat: 1, shake: 18 * decayFrom(t, [every, ...hitsIn(every + 0.1, from)], 0.2), layers: [<LightLeaks key="lk" t={t} strength={0.4} />, <TrapChoices key="tc" t={t} start={s.start} strikes={[trap, set, see]} rightAt={it} y={720} />], bursts: [{at: every, x: 540, y: 960, count: 150, power: 1.4}], words: {y: 290, max: 250}})},
  ];
  if (kind === 'final') {
    const fieldEnd = gapEndIn(mile, mile + 2) ?? mile + 0.8;
    const test1 = w('TEST', fieldEnd);
    const atlas1 = w('ATLAS', test1);
    const echoT = w('TEST', atlas1);
    const echoA = w('ATLAS', echoT);
    const pattern = w('PATTERN', echoA);
    const cracked = w('CRACKED', pattern);
    const it3 = w('IT', cracked);
    const at = w('AT', it3);
    const last = w('LAST', at);
    shots.push(
      {start: from, end: fieldEnd, enter: 'zoom', render: (t, s) => ({w: NIGHT, heat: 0.4, layers: [<TrapField key="tf" t={t} start={s.start} pullAt={mile} pullTo={mile + 0.7} />], words: {y: 300, max: 300}})},
      // Instrumental bar before the last hook: the Loop spins up on the hits.
      {start: fieldEnd, end: test1, enter: 'flash', render: (t, s) => ({w: [0, 0, 0.5, 0, 0.5], heat: 1.2, shake: 14 * decayFrom(t, hitsIn(s.start, s.end), 0.15), layers: [<LoopRing key="lr" t={t} stamps={[s.start + 0.1, s.start + 0.6, s.start + 1.1, s.start + 1.6]} closeAt={s.end - 0.2} focus={(t - s.start) * 1.2} />, ...hitStreaks(t, hitsIn(s.start, s.end), 41)], spec: {embers: 0.8}, words: null})},
      brandSlam(test1, pattern, atlas1, [echoT, echoA], false),
      {start: pattern, end: end, enter: 'iris', render: (t, s) => ({w: DIMNIGHT, heat: 0.8, shake: 18 * decayFrom(t, [cracked, it3, at, last], 0.14), glitch: 0.6 * decayFrom(t, [last], 0.18), layers: [<PatternCrack key="pc" t={t} start={s.start} cracks={[cracked, it3, at]} shatter={last} />], bursts: [{at: last, x: 540, y: 960, count: 170, power: 1.5}], words: {y: 250, max: 280}})},
    );
    return shots;
  }
  const runs = [w('RUN', mile), 0, 0, 0];
  runs[1] = w('RUN', runs[0] + 0.1);
  runs[2] = w('RUN', runs[1] + 0.1);
  runs[3] = w('RUN', runs[2] + 0.1);
  const again = w('AGAIN', runs[3]);
  const watch = w('WATCH', again);
  const been = w('BEEN', watch);
  const test1 = w('TEST', been);
  const atlas1 = w('ATLAS', test1);
  const echoT = w('TEST', atlas1);
  const echoA = w('ATLAS', echoT);
  const pattern = w('PATTERN', echoA);
  const cracked = w('CRACKED', pattern);
  const it3 = w('IT', cracked);
  const at = w('AT', it3);
  const last = w('LAST', at);
  const test2 = w('TEST', last);
  const atlas2 = w('ATLAS', test2);
  const echoT2 = w('TEST', atlas2);
  const echoA2 = w('ATLAS', echoT2);
  const iB = w('I', echoA2);
  const crackedB = w('CRACKED', iB);
  const itB = w('IT', crackedB);
  const atB = w('AT', itB);
  const lastB = w('LAST', atB);
  const rewindIn = runs[0] - 0.22; // whip lands before the first RUN
  shots.push(
    {start: from, end: rewindIn, enter: 'zoom', render: (t, s) => ({w: NIGHT, heat: 0.4, layers: [<TrapField key="tf" t={t} start={s.start} pullAt={mile} pullTo={mile + 0.7} />], words: {y: 300, max: 300}})},
    {start: rewindIn, end: watch, enter: 'whip', render: (t) => ({w: alt ? [0, 0, 0.4, 0, 0.6] : RINGS, heat: 1.1, shake: 14 * decayFrom(t, [...runs, again, ...hitsIn(rewindIn, watch)], 0.15), layers: [<Rewind key="rw" t={t} runs={runs} again={again} />], bursts: [{at: again, x: 540, y: 1100, count: 130, power: 1.2}], spec: {embers: 0.5}, words: {y: 330, max: 300}})},
    {start: watch, end: test1, enter: 'flash', render: (t, s) => ({w: alt ? TOPO : RIVER, heat: 0.8, dim: 0.45, shake: 14 * decayFrom(t, hitsIn(s.start, s.end), 0.18), layers: [<ClimbChart key="cc" t={t} start={s.start} steps={beatsIn(watch + 0.05, been - 0.05)} breakAt={been} />], bursts: [{at: been + 0.2, x: 700, y: 300, count: 120, power: 1.1}], spec: {embers: 0.7}, words: {y: 290, max: 300}})},
    brandSlam(test1, pattern, atlas1, [echoT, echoA], alt),
    {start: pattern, end: test2, enter: 'iris', render: (t, s) => ({w: DIMNIGHT, heat: 0.8, shake: 18 * decayFrom(t, [cracked, it3, at, last], 0.14), glitch: 0.6 * decayFrom(t, [last], 0.18), layers: [<PatternCrack key="pc" t={t} start={s.start} cracks={[cracked, it3, at]} shatter={last} />], bursts: [{at: last, x: 540, y: 960, count: 170, power: 1.5}], words: {y: 250, max: 280}})},
    brandSlam(test2, iB, atlas2, [echoT2, echoA2], !alt),
    {start: iB, end: end, enter: 'zoom', render: (t, s) => ({w: alt ? [0, 0.5, 0, 0, 0.5] : [0.3, 0.7, 0, 0, 0], heat: 0.9, shake: 18 * decayFrom(t, [crackedB, itB, atB, lastB], 0.14), glitch: 0.6 * decayFrom(t, [lastB], 0.18), layers: [<AtlasMark key="am" progress={1} size={380} y={900} pulse={decayFrom(t, [crackedB, itB, atB, lastB], 0.25)} />, <PatternCrack key="pc" t={t} start={s.start - 3} cracks={[crackedB, itB, atB]} shatter={lastB} />], bursts: [{at: lastB, x: 540, y: 960, count: 170, power: 1.5}], words: {y: 250, max: 280}})},
  );
  return shots;
}

// Brand slam: mark + wordmark on TEST/ATLAS, pulses on the backing echo and the hits.
function brandSlam(test: number, end: number, atlas: number, echo: number[], topo: boolean): Shot {
  return {
    start: test,
    end,
    enter: 'flash',
    render: (t) => {
      const pulse = decayFrom(t, [...echo, ...hitsIn(test, end)], 0.22);
      return {
        w: topo ? [0, 0, 0, 0.8, 0.3] : [0.4, 0, 0, 0, 0.8],
        heat: 1.3,
        shake: 20 * decayFrom(t, hitsIn(test, end), 0.2),
        layers: [
          <LightLeaks key="lk" t={t} strength={0.8} />,
          <AtlasMark key="am" progress={clamp01((t - test) / 0.4)} size={600} y={800} pulse={pulse} />,
          <Wordmark key="wm" t={t} testAt={test} atlasAt={atlas} y={1220} size={170} flash={decayFrom(t, echo, 0.2)} />,
        ],
        bursts: [
          {at: test + 0.05, x: 540, y: 800, count: 160, power: 1.4},
          {at: echo[1] ?? test + 1, x: 540, y: 1290, count: 70, power: 0.8},
        ],
        spec: {embers: 0.8},
        words: null,
      };
    },
  };
}

const V1 = {
  midnight: w('MIDNIGHT', 6), cold: w('COLD', 8.9), coffee: w('COFFEE', 9.3), highlighter: w('HIGHLIGHTER', 9.7), running: w('RUNNING', 10.5), no: w('NO', 11.3), rest: w('REST', 11.7),
  read: w('READ', 12.7), line: w('LINE', 14.6), same: w('SAME', 15.2), always: w('ALWAYS', 18.8), never: w('NEVER', 19.2), every: w('EVERY', 19.6), poison: w('POISON', 20.3),
  cross: w('CROSS', 20.7), out: w('OUT', 21.1), match: w('MATCH', 21.9), line2: w('LINE', 22.7), doubt: w('DOUBT', 24.3), they: w('THEY', 25), nah: w('NAH', 26.7), good: w('GOOD', 27.5),
};
const V2 = {
  quick: w('QUICK', 69), ground: w('GROUND', 71.3), one: w('ONE', 71.9), family: w('FAMILY', 72.5), down: w('DOWN', 74.4), fifteen: w('FIFTEEN', 75.1), lock: w('LOCK', 76.8),
  tight: w('TIGHT', 77.6), retest: w('RETEST', 78.4), hits: w('HITS', 79.2), numbers: w('NUMBERS', 80), right: w('RIGHT', 80.6),
};
const P2 = {assess: w('ASSESS', 81.3), hey: w('HEY', 81.9), diagnose: w('DIAGNOSE', 82.7), hey2: w('HEY', 83.4), drill: w('DRILL', 83.8), reassess: w('REASSESS', 84.3), here: w('HERE', 85.9)};
const CH2_I = w('I', 88);
const BR = {
  show: w('SHOW', 113), receipt: w('RECEIPT', 113.5), show2: w('SHOW', 114), show3: w('SHOW', 114.7), showMom: w('SHOW', 115.5), mom: w('MOM', 116), receipt2: w('RECEIPT', 116.5),
  show4: w('SHOW', 117.1), show5: w('SHOW', 117.9), before: w('BEFORE', 119), after: w('AFTER', 119.9), black: w('BLACK', 120.7), white: w('WHITE', 121.4), mistake: w('MISTAKE', 121.9),
  fixed: w('FIXED', 122.6), yeah: w('YEAH', 122.9), the: w('THE', 123.7), sight: w('SIGHT', 124.7),
};
const FINAL_I = w('I', 125.7);
const OUT = {test: w('TEST', 139), atlas: w('ATLAS', 139.9), test2: w('TEST', 142.3), test3: w('TEST', 145.4)};
const INTRO = {test: w('TEST', 0.5), atlas: w('ATLAS', 1.1), hey: w('HEY', 1.9), test2: w('TEST', 2.7), atlas2: w('ATLAS', 3.4), hey2: w('HEY', 5)};
const MUSIC_IN = HITS[0]; // 1.41: the beat enters under the a cappella "Test! Atlas!"
const V1_BEAT = 18.47; // the full beat arrives mid-verse

export const SHOTS: Shot[] = [
  // ══ INTRO ══ a cappella "Test! Atlas!", then the beat.
  {start: 0, end: MUSIC_IN, enter: 'cut', render: (t) => ({w: NIGHT, heat: 0.2, layers: [<AtlasMark key="am" progress={clamp01((t - INTRO.test) / (INTRO.atlas + 0.1 - INTRO.test))} size={420} y={860} pulse={decayFrom(t, [INTRO.atlas], 0.3)} />], words: {y: 1450, max: 300}})},
  {start: MUSIC_IN, end: INTRO.test2, enter: 'flash', render: (t) => ({w: RINGS, heat: 1, shake: 12 * decayFrom(t, hitsIn(MUSIC_IN, INTRO.test2), 0.14), layers: [<AtlasMark key="am" progress={1} size={420} y={860} pulse={decayFrom(t, hitsIn(MUSIC_IN, INTRO.test2), 0.2)} />, ...hitStreaks(t, hitsIn(MUSIC_IN, INTRO.test2), 1)], bursts: [{at: INTRO.hey, x: 540, y: 860, count: 90, power: 1}], words: {y: 1450, max: 300}})},
  {start: INTRO.test2, end: SEC.verse1, enter: 'flash', render: (t) => ({w: TOPO, heat: 1, dim: 0.2, shake: 12 * decayFrom(t, hitsIn(INTRO.test2, SEC.verse1), 0.14), layers: [<AtlasMark key="am" progress={1} size={300} y={640} pulse={decayFrom(t, hitsIn(INTRO.test2, 5.9), 0.2)} />, <Wordmark key="wm" t={t} testAt={INTRO.test2} atlasAt={INTRO.atlas2} y={900} size={170} flash={decayFrom(t, [INTRO.hey2], 0.25)} />], bursts: [{at: INTRO.hey2, x: 540, y: 960, count: 120, power: 1.2}], words: {y: 1450, max: 280}})},
  // ══ VERSE ONE ══
  {start: SEC.verse1, end: V1.cold - 0.22, enter: 'zoom', render: (t, s) => ({w: NIGHT, heat: 0.4, shake: 8 * decayFrom(t, hitsIn(s.start, s.end), 0.14), layers: [<NightClock key="nc" t={t} start={s.start} />], spec: {fireflies: 0.8}, words: {y: 300, max: 260}})},
  // "Cold coffee, highlighter, running on no rest": one image per phrase, cued on the words.
  {start: V1.cold - 0.22, end: V1.highlighter, enter: 'whip', render: (t, s) => ({w: NIGHT, heat: 0.4, shake: 8 * decayFrom(t, [V1.cold, V1.coffee], 0.15), layers: [<ColdCoffee key="cc" t={t} start={s.start} coldAt={V1.cold} coffeeAt={V1.coffee} />], words: {y: 300, max: 280}})},
  {start: V1.highlighter, end: V1.running, enter: 'cut', render: (t) => ({w: DIMNIGHT, heat: 0.8, shake: 12 * decayFrom(t, [V1.highlighter], 0.2), layers: [<HighlighterSwipe key="hs" t={t} swipes={[{at: V1.highlighter, from: [-300, 1500], to: [1500, 800]}, {at: hitsIn(V1.highlighter + 0.2, V1.running)[0] ?? V1.highlighter + 0.4, from: [1400, 1080], to: [-400, 1500]}]} />], words: {y: 300, max: 280}})},
  {start: V1.running, end: V1.read, enter: 'flash', render: (t, s) => ({w: [0, 0.6, 0.4, 0, 0], heat: 0.7, shake: 12 * decayFrom(t, [V1.running, w('ON', 11.1), V1.no, V1.rest, ...hitsIn(s.start, s.end)], 0.14), glitch: 0.5 * decayFrom(t, [V1.rest], 0.2), layers: [<BatteryDrain key="bd" t={t} start={s.start} drops={[V1.running, w('ON', 11.1), V1.no, V1.rest]} deadAt={V1.rest} />], words: {y: 300, max: 280}})},
  // "Read every passage like my life's on the line"
  {start: V1.read, end: w('LIKE', 13.7), enter: 'flash', render: (t, s) => ({w: WARP, heat: 0.9, layers: [<PassageTunnel key="pt" t={t} start={s.start} hits={[V1.read, w('EVERY', 13), w('PASSAGE', 13.3)]} />], words: {y: 300, max: 280}})},
  {start: w('LIKE', 13.7), end: V1.same - 0.2, enter: 'cut', render: (t, s) => ({w: NIGHT, heat: 0.5, shake: 16 * decayFrom(t, [V1.line], 0.2), layers: [<LifeLine key="ll" t={t} start={s.start} spikes={[w('LIKE', 13.7), w("LIFE'S", 14.1), w('ON', 14.3), V1.line]} lineAt={V1.line} />], words: {y: 300, max: 280}})},
  {start: V1.same - 0.2, end: V1_BEAT, enter: 'zoom', render: (t, s) => ({w: NIGHT, heat: 0.3, layers: [<FlatScore key="fs" t={t} start={s.start} dots={WORDS_IN(V1.same, V1_BEAT)} />], words: {y: 300, max: 260}})},
  {start: V1_BEAT, end: V1.match - 0.2, enter: 'flash', render: (t, s) => ({w: [0, 0.6, 0, 0.4, 0], heat: 0.9, shake: 14 * decayFrom(t, [V1_BEAT, V1.cross, ...hitsIn(s.start + 0.1, s.end)], 0.15), layers: [<PoisonWords key="pw" t={t} appears={[V1.always, V1.never, V1.every]} poisonAt={V1.poison} crossAt={V1.cross} outAt={V1.out} />], bursts: [{at: V1_BEAT, x: 540, y: 960, count: 120, power: 1.2}], words: {y: 300, max: 260}})},
  {start: V1.match - 0.2, end: V1.they, enter: 'whip', render: (t, s) => ({w: TOPO, heat: 0.7, dim: 0.35, shake: 10 * decayFrom(t, [V1.line2, V1.doubt], 0.15), layers: [<MatchLine key="ml" t={t} start={s.start} matchAt={V1.match + 0.1} lineAt={V1.line2} doubtAt={V1.doubt} />], words: {y: 300, max: 260}})},
  {start: V1.they, end: P1.i, enter: 'slice', render: (t, s) => ({w: NIGHT, heat: 0.6, shake: 10 * decayFrom(t, [V1.nah], 0.2), layers: [<WordStorm key="ws" t={t} start={s.start - 1} steer={V1.nah} words={ADVICE} />], bursts: [{at: V1.good, x: 540, y: 960, count: 60, power: 0.7}], words: {y: 960, max: 300}})},
  // "I found the pattern like I knew I could": scattered tiles snap into a grid.
  {
    start: P1.i,
    end: P1.its,
    enter: 'zoom',
    render: (t, s) => ({w: DIMNIGHT, heat: 0.7, shake: 8 * decayFrom(t, [P1.knew, P1.could], 0.14), layers: [<PatternSnap key="ps" t={t} start={s.start} snapAt={P1.found} lockAt={P1.pattern0 + 0.2} pulses={[P1.like, P1.knew, P1.could]} />], spec: {fireflies: 0.5}, words: {y: 300, max: 280}}),
  },
  // ══ PRE-CHORUS ONE ══
  {start: P1.its, end: P1.no, enter: 'flash', render: (t, s) => ({w: NIGHT, heat: 0.5, shake: 12 * decayFrom(t, [P1.not], 0.15), layers: [<PassageStrike key="pa" t={t} start={s.start} strikeAt={P1.not} noAt={99} />], words: {y: 300, max: 280}})},
  {start: P1.no, end: P1.its2, enter: 'cut', render: (t, s) => ({w: NIGHT, heat: 0.8, glitch: 0.9 * Math.exp(-(t - s.start) / 0.2), shake: 22 * Math.exp(-(t - s.start) / 0.18), layers: [<PassageStrike key="pa" t={t} start={s.start - 2} strikeAt={-99} noAt={s.start} />], words: {y: 960, max: 420}})},
  {start: P1.its2, end: P1.find, enter: 'slice', render: (t, s) => ({w: TOPO, heat: 0.8, dim: 0.3, shake: 10 * decayFrom(t, [P1.yes], 0.2), layers: [<PatternPulse key="pp" t={t} start={s.start} stamps={[P1.a2, P1.pattern, P1.test]} yesAt={P1.yes} />], bursts: [{at: P1.yes, x: 540, y: 1040, count: 110, power: 1.1}], words: {y: 300, max: 300}})},
  {start: P1.find, end: P1.drill, enter: 'zoom', render: (t, s) => ({w: TOPO, heat: 0.8, dim: 0.3, shake: 12 * decayFrom(t, [P1.costing, P1.me], 0.15), layers: [<FamilyMap key="fm" t={t} start={s.start - 0.2} target={0} targetAt={P1.costing} pulseAt={P1.me} scan dimNodes={t >= P1.costing ? 0.55 : 0} zoom={1 + 0.05 * (t - s.start) + 0.85 * easeInOut(clamp01((t - P1.costing) / 0.3))} origin={[60, 800]} />], words: {y: 300, max: 280}})},
  {start: P1.drill, end: P1.reassess, enter: 'whip', render: (t) => ({w: WARP, heat: 1, layers: [<DrillCards key="dc" t={t} flips={[P1.it, P1.then]} />], spec: {embers: 0.4}, words: {y: 300, max: 300}})},
  // The held "reassess": the comet travels the whole Loop for exactly the length of the note.
  {
    start: P1.reassess,
    end: P1.drill2,
    enter: 'flash',
    render: (t) => {
      const q = (HOLD_END - P1.reassess) / 4;
      const stamps = [0, 1, 2, 3].map((i) => P1.reassess + i * q);
      const build = clamp01((t - P1.reassess) / (HOLD_END - P1.reassess));
      return {
        w: [0, 0.4 * (1 - build), 0, 0, 0.6 + 0.4 * build],
        heat: 0.6 + 0.6 * build,
        shake: 14 * decayFrom(t, [HOLD_END], 0.2),
        layers: [<LoopRing key="lr" t={t} stamps={stamps} closeAt={HOLD_END} focus={0} />],
        bursts: [{at: HOLD_END, x: 540, y: 1020, count: 130, power: 1.1}],
        spec: {embers: 0.3 + 0.5 * build},
        words: {y: 300, max: 300},
      };
    },
  },
  {start: P1.drill2, end: P1.reassess2, enter: 'cut', render: (t) => ({w: WARP, heat: 1.2, layers: [<DrillCards key="dc" t={t} flips={[P1.it2]} label="DRILL · TRANSITIONS" />], words: {y: 300, max: 300}})},
  {start: P1.reassess2, end: P1.here, enter: 'flash', render: (t) => ({w: RINGS, heat: 1, shake: 14 * decayFrom(t, [P1.reassess2, ...hitsIn(40.5, 42)], 0.16), layers: [<LoopRing key="lr" t={t} stamps={[36.35, 37.1, 37.9, 38.7]} closeAt={HOLD_END} focus={3} />, ...hitStreaks(t, hitsIn(40.5, 42), 5)], words: {y: 300, max: 300}})},
  {
    start: P1.here,
    end: CH1.i,
    enter: 'zoom',
    render: (t) => {
      const {flicker, build} = buildOut(t, P1.here, CH1.i);
      return {
        w: [0, 0, 1 - 0.5 * build, 0, 0.5 * build],
        heat: 0.6 + build,
        shake: build * build * 16 + 14 * decayFrom(t, hitsIn(42, 44.1), 0.14),
        layers: [<Flash key="fl" age={0} max={0.25 * flicker + 0.5 * decayFrom(t, BACKING, 0.07)} color={C.mark} />, ...hitStreaks(t, hitsIn(42, 44.1), 9)],
        spec: {embers: build},
        words: {y: 960, max: 360},
      };
    },
  },
  // ══ CHORUS ONE ══
  ...chorus(SEC.chorus1 - 0.05, 'full', V2.quick, false),
  // ══ VERSE TWO ══
  {start: V2.quick, end: V2.one, enter: 'flash', render: (t, s) => ({w: TOPO, heat: 0.6, dim: 0.35, shake: 10 * decayFrom(t, [V2.ground], 0.2), layers: [<QuickCheck key="qc" t={t} start={s.start} groundAt={V2.ground} />], words: {y: 300, max: 260}})},
  {start: V2.one, end: V2.fifteen, enter: 'whip', render: (t, s) => ({w: NIGHT, heat: 0.6, shake: 16 * decayFrom(t, [V2.down], 0.2), layers: [<FamilyBars key="fb" t={t} start={s.start} oneAt={V2.family} downAt={V2.down} />], words: {y: 300, max: 260}})},
  {start: V2.fifteen, end: V2.lock, enter: 'zoom', render: (t) => ({w: WARP, heat: 0.9, layers: [<DrillCards key="dc" t={t} flips={beatsIn(V2.fifteen + 0.25, V2.lock - 0.1)} label="DRILL · 15 QUESTIONS" />], words: {y: 300, max: 260}})},
  {start: V2.lock, end: V2.retest, enter: 'cut', render: (t, s) => ({w: [0, 0.5, 0, 0.5, 0], heat: 0.8, shake: 16 * decayFrom(t, [V2.tight], 0.2), layers: [<VaultLock key="vl" t={t} start={s.start} slamAt={V2.tight} />], words: {y: 300, max: 260}})},
  {start: V2.retest, end: P2.assess, enter: 'slice', render: (t, s) => ({w: RIVER, heat: 0.7, dim: 0.45, shake: 10 * decayFrom(t, [V2.hits, V2.right], 0.18), layers: [<Receipt key="rc" t={t} start={s.start + 0.05} printTo={V2.hits} beforeAt={V2.hits} afterAt={V2.numbers} fixedAt={V2.right} stampAt={V2.right} stamp="LOOKS RIGHT" />], bursts: [{at: V2.right, x: 700, y: 900, count: 90, power: 0.9}], words: {y: 240, max: 240}})},
  // ══ PRE-CHORUS TWO ══ the chant, one Loop station per word.
  {start: P2.assess, end: P2.here, enter: 'flash', render: (t) => ({w: RINGS, heat: 1, shake: 12 * decayFrom(t, [P2.assess, P2.hey, P2.diagnose, P2.hey2, P2.drill, P2.reassess], 0.14), layers: [<LoopRing key="lr" t={t} stamps={[P2.assess, P2.diagnose, P2.drill, P2.reassess]} closeAt={P2.reassess + 0.8} focus={0} />], bursts: [{at: P2.reassess + 0.8, x: 540, y: 1020, count: 120, power: 1.1}], words: {y: 300, max: 300}})},
  {
    start: P2.here,
    end: CH2_I,
    enter: 'zoom',
    render: (t) => {
      const {flicker, build} = buildOut(t, P2.here, CH2_I);
      const backing = BACKING.map((b) => b + 43.92);
      return {w: [0, 0, 1 - 0.5 * build, 0, 0.5 * build], heat: 0.6 + build, shake: build * build * 16 + 14 * decayFrom(t, hitsIn(P2.here + 0.2, CH2_I), 0.14), layers: [<Flash key="fl" age={0} max={0.25 * flicker + 0.5 * decayFrom(t, backing, 0.07)} color={C.mark} />, ...hitStreaks(t, hitsIn(P2.here + 0.2, CH2_I), 19)], spec: {embers: build}, words: {y: 960, max: 360}};
    },
  },
  // ══ CHORUS TWO ══
  ...chorus(CH2_I - 0.05, 'full', BR.show, true),
  // ══ BRIDGE ══ four on the floor: the receipt.
  {start: BR.show, end: BR.showMom, enter: 'flash', render: (t, s) => ({w: [0.5, 0, 0, 0, 0.5], heat: 1, dim: 0.35, shake: 10 * beatPulse(t, 0.1), layers: [<Receipt key="rc" t={t} start={s.start} printTo={BR.show2} beforeAt={BR.show2} afterAt={BR.show3} stampAt={BR.show3} stamp="SHARE" />], words: {y: 230, max: 240}})},
  {start: BR.showMom, end: BR.show4, enter: 'whip', render: (t, s) => ({w: NIGHT, heat: 0.8, layers: [<MomChat key="mc" t={t} start={s.start} sendAt={BR.receipt2} replyAt={BR.show4 - 0.3} />], words: {y: 230, max: 240}})},
  {start: BR.show4, end: BR.before - 0.2, enter: 'cut', render: (t) => ({w: RINGS, heat: 1.2, shake: 14 * decayFrom(t, [BR.show4, BR.show5, w("'EM", 117.4), w("'EM", 118.2)], 0.14), layers: [<ShareBurst key="sb" t={t} shots={[BR.show4, w("'EM", 117.4), BR.show5, w("'EM", 118.2)]} />], spec: {embers: 0.6}, words: {y: 960, max: 320}})},
  {start: BR.before - 0.2, end: BR.black, enter: 'slice', render: (t, s) => ({w: TOPO, heat: 0.8, dim: 0.4, layers: [<Receipt key="rc" t={t} start={s.start - 1} printTo={s.start - 0.5} beforeAt={BR.before} afterAt={BR.after} x={540} y={1060} scale={1.05} rotate={0} />], words: {y: 230, max: 260}})},
  {start: BR.black, end: BR.mistake, enter: 'cut', render: (t, s) => ({w: NIGHT, heat: 1, mono: t >= BR.white ? 'white' : 'black', shake: 16 * decayFrom(t, [BR.black, BR.white], 0.15), layers: [<Receipt key="rc" t={t} start={s.start - 2} printTo={s.start - 1.5} beforeAt={-9} afterAt={-9} x={540} y={1060} scale={1.05} rotate={0} />], words: {y: 230, max: 280}})},
  {start: BR.mistake, end: BR.the, enter: 'flash', render: (t, s) => ({w: [0.4, 0, 0, 0, 0.6], heat: 1, dim: 0.35, shake: 14 * decayFrom(t, [BR.fixed, BR.yeah], 0.15), layers: [<Receipt key="rc" t={t} start={s.start - 2} printTo={s.start - 1.5} beforeAt={-9} afterAt={-9} fixedAt={BR.fixed} stampAt={BR.yeah} stamp="FIXED" x={540} y={1060} scale={1.05} rotate={0} />], bursts: [{at: BR.yeah, x: 700, y: 900, count: 110, power: 1.1}], words: {y: 230, max: 260}})},
  {start: BR.the, end: FINAL_I, enter: 'zoom', render: (t, s) => {
    const z = easeInOut(clamp01((t - s.start) / (BR.sight - s.start)));
    return {w: [0.3, 0, 0.7, 0, 0], heat: 1.2, shake: 14 * decayFrom(t, [BR.sight, ...hitsIn(BR.sight + 0.2, FINAL_I)], 0.15), layers: [<AbsoluteFill key="z" style={{clipPath: 'inset(430px 0 0 0)'}}><AbsoluteFill style={{transform: `scale(${1 + 0.6 * z})`, transformOrigin: '540px 1250px'}}><Receipt t={t} start={s.start - 3} printTo={s.start - 2.5} beforeAt={-9} afterAt={-9} fixedAt={-9} stampAt={-9} stamp="FIXED" x={540} y={1060} scale={1.05} rotate={0} /></AbsoluteFill></AbsoluteFill>], bursts: [{at: BR.sight, x: 540, y: 960, count: 150, power: 1.3}], words: {y: 230, max: 280}};
  }},
  // ══ FINAL CHORUS ══
  ...chorus(FINAL_I - 0.05, 'final', SEC.outro, false),
  // ══ OUTRO ══ chant slams on the hits, then the end card.
  {start: SEC.outro, end: OUT.test3, enter: 'flash', render: (t, s) => {
    const hits = hitsIn(s.start, s.end);
    return {w: t < OUT.test2 ? RINGS : [0, 0, 0.6, 0, 0.4], heat: 1.3, shake: 18 * decayFrom(t, hits, 0.16), layers: [<LightLeaks key="lk" t={t} strength={0.8} />, <AtlasMark key="am" progress={1} size={560} y={800} pulse={decayFrom(t, hits, 0.25)} />, <Wordmark key="wm" t={t} testAt={OUT.test} atlasAt={OUT.atlas} y={1220} size={170} flash={decayFrom(t, [OUT.test2, ...hits], 0.2)} />, ...hitStreaks(t, hits, 51)], bursts: hits.map((h, k) => ({at: h, x: 540, y: 800, count: 60 + 10 * (k % 3), power: 0.9})), spec: {embers: 0.9}, words: null};
  }},
  {start: OUT.test3, end: SEC.end + 1, enter: 'flash', render: (t, s) => ({w: RIVER, heat: 0.5, dim: 0.5, shake: 10 * decayFrom(t, hitsIn(s.start, s.end), 0.18), layers: [<EndCard key="ec" t={t} start={s.start} />], spec: {fireflies: 0.6}, words: null})},
];

const ShotView: React.FC<{shot: Shot; t: number}> = ({shot, t}) => {
  const out = shot.render(t, shot);
  const shake = out.shake ?? 0;
  const sx = (random(`sx${Math.floor(t * 60)}`) - 0.5) * shake;
  const sy = (random(`sy${Math.floor(t * 60)}`) - 0.5) * shake;
  const e = {...env(t, out.w, out.heat), portal: 0};
  return (
    <GlitchSplit amount={out.glitch ?? 0}>
      <AbsoluteFill style={{transform: `translate(${sx}px, ${sy}px) scale(${1 + 0.012 * e.down})`, backgroundColor: C.slab, filter: out.mono === 'white' ? 'grayscale(1) contrast(1.6) invert(1)' : out.mono === 'black' ? 'grayscale(1) contrast(1.6) brightness(0.8)' : undefined}}>
        <Environment u={e} />
        {out.dim ? <AbsoluteFill style={{backgroundColor: `rgba(13,24,20,${out.dim})`}} /> : null}
        {out.layers}
        <Particles t={t} spec={{...(out.spec ?? {}), bursts: out.bursts}} />
        {out.invert ? <AbsoluteFill style={{backgroundColor: C.bright, mixBlendMode: 'difference'}} /> : null}
      </AbsoluteFill>
    </GlitchSplit>
  );
};

const TR = 0.18;

// Lyrics render above transitions so each word pops exactly on its sung start.
const LyricLayer: React.FC<{shot: Shot; t: number}> = ({shot, t}) => {
  const out = shot.render(t, shot);
  if (!out.words) return null;
  const current = wordAt(t, shot.start, shot.end);
  if (!current) return null;
  return <KineticWord text={current.word.text} age={t - current.word.start} index={current.index} y={out.words.y} maxSize={out.words.max ?? 300} color={out.invert || out.mono === 'white' ? C.slab : out.words.color} shake={out.glitch ?? 0} />;
};

export const TestAtlasFull: React.FC = () => {
  const t = useCurrentFrame() / FPS;
  const idx = Math.max(0, SHOTS.findIndex((s) => t >= s.start && t < s.end));
  const shot = SHOTS[idx];
  const prev = SHOTS[idx - 1];
  const p = (t - shot.start) / TR;
  const transitioning = prev && p < 1 && ['zoom', 'whip', 'slice', 'iris'].includes(shot.enter);
  let view: React.ReactNode;
  if (!transitioning) {
    view = <ShotView shot={shot} t={t} />;
  } else {
    const e = easeInOut(p);
    if (shot.enter === 'zoom') {
      view = (
        <>
          <AbsoluteFill style={{transform: `scale(${1 + 0.8 * e})`, opacity: 1 - e, filter: `blur(${10 * e}px)`}}>
            <ShotView shot={prev} t={t} />
          </AbsoluteFill>
          <AbsoluteFill style={{transform: `scale(${1.4 - 0.4 * e})`, opacity: clamp01(p * 1.5), filter: `blur(${8 * (1 - e)}px)`}}>
            <ShotView shot={shot} t={t} />
          </AbsoluteFill>
        </>
      );
    } else if (shot.enter === 'whip') {
      view = (
        <>
          <AbsoluteFill style={{transform: `translateX(${-1300 * e}px)`, filter: `blur(${16 * Math.sin(p * Math.PI)}px)`}}>
            <ShotView shot={prev} t={t} />
          </AbsoluteFill>
          <AbsoluteFill style={{transform: `translateX(${1300 * (1 - e)}px)`, filter: `blur(${16 * Math.sin(p * Math.PI)}px)`}}>
            <ShotView shot={shot} t={t} />
          </AbsoluteFill>
        </>
      );
    } else if (shot.enter === 'slice') {
      const x = -500 + 2100 * e;
      view = (
        <>
          <ShotView shot={prev} t={t} />
          <AbsoluteFill style={{clipPath: `polygon(0px 0px, ${x + 500}px 0px, ${x}px 1920px, 0px 1920px)`}}>
            <ShotView shot={shot} t={t} />
          </AbsoluteFill>
          <div style={{position: 'absolute', left: x + 250 - 20, top: -200, width: 40, height: 2400, backgroundColor: C.leaf, transform: 'rotate(14.6deg)', boxShadow: '0 0 60px rgba(88,215,146,1)'}} />
        </>
      );
    } else {
      const r = 1300 * e;
      view = (
        <>
          <ShotView shot={prev} t={t} />
          <AbsoluteFill style={{clipPath: `circle(${r}px at 50% 50%)`}}>
            <ShotView shot={shot} t={t} />
          </AbsoluteFill>
          <div style={{position: 'absolute', left: 540 - r, top: 960 - r, width: r * 2, height: r * 2, borderRadius: '50%', border: `14px solid ${C.mark}`, boxShadow: '0 0 60px rgba(201,162,74,1)'}} />
        </>
      );
    }
  }
  const flashAge = shot.enter === 'flash' ? t - shot.start : -1;
  const fadeIn = clamp01(t / 0.2);
  const fadeOut = clamp01((t - (SEC.end - 0.6)) / 0.5);
  return (
    <AbsoluteFill style={{backgroundColor: C.slab}}>
      <Audio src={staticFile('full.wav')} />
      {view}
      <LyricLayer shot={shot} t={t} />
      <Flash age={flashAge} decay={0.12} max={0.7} color="#f4f1e8" />
      <Grain t={t} />
      <AbsoluteFill style={{backgroundColor: '#000', opacity: Math.max(1 - fadeIn, fadeOut)}} />
    </AbsoluteFill>
  );
};
