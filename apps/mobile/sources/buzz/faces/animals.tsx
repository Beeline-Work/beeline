/**
 * Speakeasy's twelve launch-set animals, ported as STATIC render functions.
 *
 * The path data, helper geometry and draw order are copied verbatim from
 * `speakeasy/apps/mobile/src/avatars/components.tsx` (the default, non-call
 * renders) so the art is identical; everything that moved there — the
 * Animated wrappers, prosody, gaze, blink, the call-mask variants — is
 * dropped, because a Beeline face is a still identity tile, not a puppet.
 *
 * Two things are parameterised so the same drawings serve two classes:
 *
 *  - `palette` replaces Speakeasy's BRASS / BONE / INK. A person keeps BONE
 *    and INK and swaps BRASS for their signature hue; an agent paints all
 *    three INK (an ink figure on a coloured plate).
 *  - `eyes` is either `drawn` (the original two eyes) or `lens` — the agent's
 *    one bone band spanning the same eyes, drawn in the eyes' own slot so it
 *    sits at exactly the depth the eyes did.
 *
 * Construction rules inherited from Speakeasy §2.2: three colours max, no
 * strokes except where noted (stag antlers, the mouth lines), 100×100 viewBox.
 */

import React from 'react';
import { Circle, Ellipse, G, Line, Path, Polygon, Rect } from 'react-native-svg';
import { FACE_IDS, type FaceId } from './index';

export { FACE_IDS, type FaceId } from './index';

// Brand-locked colours — the same constants Speakeasy's marks hard-code.
export const BRASS = '#E5A645';
export const BONE = '#F2E9D8';
export const INK = '#14091A';

export type FacePalette = { brass: string; bone: string; ink: string };
export type FaceEyes = 'drawn' | 'lens';
export type FaceRenderProps = { palette: FacePalette; eyes: FaceEyes };
export type FaceRender = (props: FaceRenderProps) => React.ReactElement;

/** The lens band: bone, ~6.4 units tall, `rx` 1, spanning the eyes' centres
 *  with a 7-unit reach past the outermost ones (the approved contact sheet's
 *  geometry). */
export const LENS_BAND_HEIGHT = 6.4;
export const LENS_BAND_REACH = 7;

type Point = { x: number; y: number };

/**
 * The pair of eyes. Speakeasy pivoted each in its own group so a blink could
 * collapse around the right point; the pivots are the eye centres, and they
 * are what the agent's lens band is measured from.
 */
function Eyes({
  leftPivot,
  rightPivot,
  eyes,
  children,
}: {
  leftPivot: Point;
  rightPivot: Point;
  eyes: FaceEyes;
  children: [React.ReactElement, React.ReactElement];
}): React.ReactElement {
  if (eyes === 'lens') {
    const left = Math.min(leftPivot.x, rightPivot.x) - LENS_BAND_REACH;
    const right = Math.max(leftPivot.x, rightPivot.x) + LENS_BAND_REACH;
    return (
      <Rect
        x={left}
        y={leftPivot.y - LENS_BAND_HEIGHT / 2}
        width={right - left}
        height={LENS_BAND_HEIGHT}
        rx={1}
        fill={BONE}
        testID="face-lens-band"
      />
    );
  }
  return (
    <>
      <G>{children[0]}</G>
      <G>{children[1]}</G>
    </>
  );
}

/** The mouth group — a static wrapper where Speakeasy scaled on amplitude. */
function Mouth({ children }: { children: React.ReactNode }): React.ReactElement {
  return <G>{children}</G>;
}

/** Speakeasy's crossfading mouth at rest: only the closed path is drawn. */
function MouthClosed({
  d,
  stroke,
  strokeWidth,
}: {
  d: string;
  stroke: string;
  strokeWidth: number;
}): React.ReactElement {
  return (
    <Path
      d={d}
      stroke={stroke}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  );
}

// ─────────────────────────────────────────────────────────────────────

const Fox: FaceRender = ({ palette: { brass, bone, ink }, eyes }) => (
  <>
    <G>
      <Polygon points="18,12 38,12 28,32" fill={brass} />
      <Polygon points="24,18 32,18 28,28" fill={ink} />
    </G>
    <G>
      <Polygon points="62,12 82,12 72,32" fill={brass} />
      <Polygon points="68,18 76,18 72,28" fill={ink} />
    </G>
    {/* head */}
    <Path d="M20,28 L80,28 L74,62 L50,88 L26,62 Z" fill={brass} />
    {/* white chest */}
    <Path d="M38,56 L62,56 L50,86 Z" fill={bone} />
    <Eyes leftPivot={{ x: 36, y: 44 }} rightPivot={{ x: 64, y: 44 }} eyes={eyes}>
      <Ellipse cx={36} cy={44} rx={3.2} ry={3.2} fill={ink} />
      <Ellipse cx={64} cy={44} rx={3.2} ry={3.2} fill={ink} />
    </Eyes>
    <MouthClosed d="M 45 52 Q 50 54 55 52" stroke={ink} strokeWidth={1.4} />
  </>
);

const Owl: FaceRender = ({ palette: { brass, bone, ink }, eyes }) => (
  <G>
    {/* ear tufts */}
    <Polygon points="20,18 32,18 27,5" fill={brass} />
    <Polygon points="68,18 80,18 73,5" fill={brass} />
    {/* body / head */}
    <Path
      d="M18,22 Q18,18 30,18 L70,18 Q82,18 82,22 L82,76 Q82,90 50,90 Q18,90 18,76 Z"
      fill={brass}
    />
    {/* face disk */}
    <Ellipse cx={50} cy={46} rx={30} ry={26} fill={bone} />
    <Eyes leftPivot={{ x: 38, y: 44 }} rightPivot={{ x: 62, y: 44 }} eyes={eyes}>
      <G>
        <Circle cx={38} cy={44} r={8} fill={ink} />
        <Circle cx={38} cy={44} r={2.5} fill={brass} />
      </G>
      <G>
        <Circle cx={62} cy={44} r={8} fill={ink} />
        <Circle cx={62} cy={44} r={2.5} fill={brass} />
      </G>
    </Eyes>
    <Mouth>
      <Polygon points="46,54 54,54 50,64" fill={ink} />
    </Mouth>
  </G>
);

const Pigeon: FaceRender = ({ palette: { brass, ink }, eyes }) => (
  // Profile silhouette — single eye, beak as the mouth element.
  <G>
    <Ellipse cx={42} cy={52} rx={30} ry={24} fill={ink} />
    <Eyes leftPivot={{ x: 38, y: 44 }} rightPivot={{ x: 38, y: 44 }} eyes={eyes}>
      <Circle cx={38} cy={44} r={3} fill={brass} />
      {/* second eye intentionally identical — profile pose has only one
          visible eye; the slot is kept so the Eyes helper shape is consistent. */}
      <G />
    </Eyes>
    <Mouth>
      <Polygon points="68,46 96,52 68,58" fill={ink} />
    </Mouth>
  </G>
);

const Hare: FaceRender = ({ palette: { brass, bone, ink }, eyes }) => (
  <>
    <G>
      <Rect x={33} y={6} width={11} height={38} rx={5} fill={bone} />
      <Rect x={36} y={12} width={5} height={26} rx={2} fill={brass} />
    </G>
    <G>
      <Rect x={56} y={6} width={11} height={38} rx={5} fill={bone} />
      <Rect x={59} y={12} width={5} height={26} rx={2} fill={brass} />
    </G>
    {/* head */}
    <Ellipse cx={50} cy={60} rx={28} ry={26} fill={bone} />
    <Eyes leftPivot={{ x: 38, y: 56 }} rightPivot={{ x: 62, y: 56 }} eyes={eyes}>
      <Circle cx={38} cy={56} r={2.8} fill={ink} />
      <Circle cx={62} cy={56} r={2.8} fill={ink} />
    </Eyes>
    <Mouth>
      <Ellipse cx={50} cy={68} rx={3.5} ry={2.5} fill={ink} />
    </Mouth>
  </>
);

const Stag: FaceRender = ({ palette: { brass, bone, ink }, eyes }) => (
  <G>
    {/* antlers — exception to the no-stroke rule per design notes */}
    <Path
      d="M30,28 L24,12 M30,28 L18,22 M30,28 L34,8"
      stroke={brass}
      strokeWidth={3}
      fill="none"
      strokeLinecap="square"
    />
    <Path
      d="M70,28 L76,12 M70,28 L82,22 M70,28 L66,8"
      stroke={brass}
      strokeWidth={3}
      fill="none"
      strokeLinecap="square"
    />
    {/* head */}
    <Path d="M30,30 L70,30 L66,68 L50,88 L34,68 Z" fill={brass} />
    {/* white chin */}
    <Path d="M42,62 L58,62 L50,84 Z" fill={bone} />
    <Eyes leftPivot={{ x: 40, y: 46 }} rightPivot={{ x: 60, y: 46 }} eyes={eyes}>
      <Ellipse cx={40} cy={46} rx={2.6} ry={2.6} fill={ink} />
      <Ellipse cx={60} cy={46} rx={2.6} ry={2.6} fill={ink} />
    </Eyes>
    <Mouth>
      <Ellipse cx={50} cy={64} rx={3} ry={2} fill={ink} />
    </Mouth>
  </G>
);

const Whale: FaceRender = ({ palette: { brass, bone, ink }, eyes }) => (
  <G>
    <Path
      d="M10,55 Q15,38 40,38 Q70,38 78,52 L94,42 L88,58 L94,68 L78,60 Q70,72 40,72 Q15,72 10,55 Z"
      fill={ink}
    />
    <Path d="M22,58 Q40,68 65,64 L65,62 Q40,56 22,52 Z" fill={bone} />
    <Eyes leftPivot={{ x: 68, y: 50 }} rightPivot={{ x: 68, y: 50 }} eyes={eyes}>
      <Circle cx={68} cy={50} r={2} fill={brass} />
      <G />
    </Eyes>
    {/* No visible mouth element. */}
    <Mouth>
      <G />
    </Mouth>
  </G>
);

const Moth: FaceRender = ({ palette: { brass, bone, ink }, eyes }) => (
  <>
    <Path d="M46,18 Q40,8 32,6" stroke={ink} strokeWidth={1.5} fill="none" />
    <Path d="M54,18 Q60,8 68,6" stroke={ink} strokeWidth={1.5} fill="none" />
    {/* left wings */}
    <G>
      <Path d="M50,28 L18,22 L10,42 L50,52 Z" fill={brass} />
      <Path d="M50,52 L20,52 L28,76 L50,68 Z" fill={bone} />
    </G>
    {/* right wings */}
    <G>
      <Path d="M50,28 L82,22 L90,42 L50,52 Z" fill={brass} />
      <Path d="M50,52 L80,52 L72,76 L50,68 Z" fill={bone} />
    </G>
    <Mouth>
      <Ellipse cx={50} cy={48} rx={4} ry={22} fill={ink} />
    </Mouth>
    <Eyes leftPivot={{ x: 28, y: 36 }} rightPivot={{ x: 72, y: 36 }} eyes={eyes}>
      <Circle cx={28} cy={36} r={3} fill={ink} />
      <Circle cx={72} cy={36} r={3} fill={ink} />
    </Eyes>
  </>
);

const Octopus: FaceRender = ({ palette: { brass, ink }, eyes }) => (
  <>
    {/* mantle */}
    <Path
      d="M22,42 Q22,18 50,18 Q78,18 78,42 L78,58 Q78,62 74,62 L26,62 Q22,62 22,58 Z"
      fill={brass}
    />
    {/* tentacles */}
    <G>
      <Path d="M26,62 Q20,75 28,88" stroke={brass} strokeWidth={5} fill="none" strokeLinecap="round" />
      <Path d="M36,62 Q32,80 42,88" stroke={brass} strokeWidth={5} fill="none" strokeLinecap="round" />
      <Path d="M46,62 L44,90" stroke={brass} strokeWidth={5} fill="none" strokeLinecap="round" />
    </G>
    <G>
      <Path d="M54,62 L56,90" stroke={brass} strokeWidth={5} fill="none" strokeLinecap="round" />
      <Path d="M64,62 Q68,80 58,88" stroke={brass} strokeWidth={5} fill="none" strokeLinecap="round" />
      <Path d="M74,62 Q80,75 72,88" stroke={brass} strokeWidth={5} fill="none" strokeLinecap="round" />
    </G>
    <Eyes leftPivot={{ x: 40, y: 40 }} rightPivot={{ x: 60, y: 40 }} eyes={eyes}>
      <Circle cx={40} cy={40} r={3.5} fill={ink} />
      <Circle cx={60} cy={40} r={3.5} fill={ink} />
    </Eyes>
    {/* No mouth — hidden under the mantle. */}
    <Mouth>
      <G />
    </Mouth>
  </>
);

const Heron: FaceRender = ({ palette: { brass, bone, ink }, eyes }) => (
  <>
    {/* body */}
    <Ellipse cx={60} cy={72} rx={22} ry={14} fill={bone} />
    {/* neck S-curve */}
    <Path d="M58,62 Q40,52 44,32 Q48,18 60,16" stroke={bone} strokeWidth={8} fill="none" strokeLinecap="round" />
    <G>
      {/* head */}
      <Ellipse cx={62} cy={16} rx={8} ry={7} fill={bone} />
      <Eyes leftPivot={{ x: 60, y: 14 }} rightPivot={{ x: 60, y: 14 }} eyes={eyes}>
        <Circle cx={60} cy={14} r={1.6} fill={ink} />
        <G />
      </Eyes>
      {/* Beak is the mouth: an INK stroke so it reads against the bone body. */}
      <MouthClosed d="M 68 16 L 92 17 L 68 18 Z" stroke={ink} strokeWidth={1.1} />
    </G>
    {/* legs */}
    <Line x1={54} y1={84} x2={50} y2={96} stroke={brass} strokeWidth={2} />
    <Line x1={66} y1={84} x2={70} y2={96} stroke={brass} strokeWidth={2} />
  </>
);

const Bear: FaceRender = ({ palette: { brass, bone, ink }, eyes }) => (
  <G>
    {/* ears */}
    <Circle cx={26} cy={24} r={10} fill={ink} />
    <Circle cx={74} cy={24} r={10} fill={ink} />
    <Circle cx={26} cy={24} r={4} fill={brass} />
    <Circle cx={74} cy={24} r={4} fill={brass} />
    {/* head */}
    <Ellipse cx={50} cy={56} rx={32} ry={30} fill={ink} />
    {/* snout */}
    <Mouth>
      <G>
        <Ellipse cx={50} cy={68} rx={14} ry={10} fill={bone} />
        <Ellipse cx={50} cy={64} rx={3.5} ry={2.5} fill={ink} />
      </G>
    </Mouth>
    <Eyes leftPivot={{ x: 38, y: 50 }} rightPivot={{ x: 62, y: 50 }} eyes={eyes}>
      <Circle cx={38} cy={50} r={2.8} fill={brass} />
      <Circle cx={62} cy={50} r={2.8} fill={brass} />
    </Eyes>
  </G>
);

const Cat: FaceRender = ({ palette: { brass, ink }, eyes }) => (
  <>
    <G>
      <Polygon points="14,32 30,8 36,32" fill={ink} />
      <Polygon points="22,28 30,15 32,28" fill={brass} />
    </G>
    <G>
      <Polygon points="64,32 70,8 86,32" fill={ink} />
      <Polygon points="68,28 70,15 78,28" fill={brass} />
    </G>
    {/* head */}
    <Ellipse cx={50} cy={56} rx={34} ry={30} fill={ink} />
    <Eyes leftPivot={{ x: 36, y: 48 }} rightPivot={{ x: 64, y: 48 }} eyes={eyes}>
      <G>
        <Path d="M28,48 Q36,42 44,48 Q36,54 28,48 Z" fill={brass} />
        <Ellipse cx={36} cy={48} rx={1.5} ry={3} fill={ink} />
      </G>
      <G>
        <Path d="M56,48 Q64,42 72,48 Q64,54 56,48 Z" fill={brass} />
        <Ellipse cx={64} cy={48} rx={1.5} ry={3} fill={ink} />
      </G>
    </Eyes>
    <Mouth>
      <Polygon points="46,62 54,62 50,68" fill={brass} />
    </Mouth>
  </>
);

const Bat: FaceRender = ({ palette: { brass, bone, ink }, eyes }) => (
  <>
    {/* wings */}
    <G>
      <Path d="M50,46 L20,30 L8,42 L18,46 L8,54 L24,58 L50,52 Z" fill={ink} />
    </G>
    <G>
      <Path d="M50,46 L80,30 L92,42 L82,46 L92,54 L76,58 L50,52 Z" fill={ink} />
    </G>
    {/* head */}
    <Ellipse cx={50} cy={52} rx={14} ry={13} fill={ink} />
    <Polygon points="40,38 46,28 48,40" fill={ink} />
    <Polygon points="52,40 54,28 60,38" fill={ink} />
    <Eyes leftPivot={{ x: 44, y: 50 }} rightPivot={{ x: 56, y: 50 }} eyes={eyes}>
      <Circle cx={44} cy={50} r={2} fill={brass} />
      <Circle cx={56} cy={50} r={2} fill={brass} />
    </Eyes>
    <Mouth>
      <G>
        <Polygon points="46,58 48,64 50,58" fill={bone} />
        <Polygon points="50,58 52,64 54,58" fill={bone} />
      </G>
    </Mouth>
  </>
);

export const FACES: Record<FaceId, FaceRender> = {
  fox: Fox,
  owl: Owl,
  pigeon: Pigeon,
  hare: Hare,
  stag: Stag,
  whale: Whale,
  moth: Moth,
  octopus: Octopus,
  heron: Heron,
  bear: Bear,
  cat: Cat,
  bat: Bat,
};
