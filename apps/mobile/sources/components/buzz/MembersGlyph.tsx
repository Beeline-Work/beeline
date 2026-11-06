import React from 'react';
import Svg, { Circle, Polygon } from 'react-native-svg';
import { DECORATIVE_GLYPH_PROPS } from './decorative-glyph';
import brand from '@/buzz/brand.json';

/**
 * Header chrome shares a 24 viewBox with RoomGlyph. 1.75 is the FAB chrome
 * stroke in that viewBox; at the 16px size this was tuned for it paints
 * ~1.17px, in the same band as the Ionicons header peers. A 28px header mark
 * keeps that painted weight by scaling the viewBox stroke down — a stroke
 * left at 1.75 would paint ~2.04px and read heavy.
 */
export const MEMBERS_GLYPH_STROKE_WIDTH = 1.75;
/** The size `MEMBERS_GLYPH_STROKE_WIDTH` was tuned to paint ~1.17px at. */
export const CHROME_STROKE_REF_SIZE = 16;

/** ViewBox stroke that keeps today's painted weight at `size`. */
export function chromeStrokeWidth(size: number): number {
  return MEMBERS_GLYPH_STROKE_WIDTH * (CHROME_STROKE_REF_SIZE / size);
}

const HEAD_CX = 12;
const HEAD_CY = 7.85;
const HEAD_R = 5.45;
/** Apex sits on the head circle at the bottom centre. */
const APEX_X = HEAD_CX;
const APEX_Y = HEAD_CY + HEAD_R;
/**
 * Right-isosceles body: equal legs from the apex, 90° at the apex, horizontal
 * base. The vertical drop equals the half-width so the legs are perpendicular.
 */
const LEG = 7.6;
const BODY_POINTS = `${APEX_X} ${APEX_Y} ${APEX_X + LEG} ${APEX_Y + LEG} ${APEX_X - LEG} ${APEX_Y + LEG}`;
