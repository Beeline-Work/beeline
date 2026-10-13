import React from 'react';
const el =
  (name: string) =>
  ({ children, ...p }: any) =>
    React.createElement(name, p, children);
export default el('svg');
export const G = el('g'),
  Path = el('path'),
  Rect = el('rect'),
  Circle = el('circle'),
  Ellipse = el('ellipse'),
  Defs = el('defs'),
  ClipPath = el('clipPath'),
  Polygon = el('polygon');
export const SvgUri = () => null;
export const Line = el('line');
export const Polyline = el('polyline');
