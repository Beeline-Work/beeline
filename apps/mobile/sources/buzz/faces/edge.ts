/**
 * Speakeasy's per-theme contrast outline (their #12), ported verbatim from
 * `speakeasy/apps/mobile/src/avatars/components.tsx`.
 *
 * The marks hard-code BONE ("white") and INK ("black") with no theme
 * awareness. The signature hue reads cleanly on both grounds, so it never
 * needs an edge. Only the shape whose fill matches the *background* loses
 * contrast: BONE shapes vanish on a light plate, INK shapes on a dark one.
 *
 * Fix: render the mark a SECOND time BEHIND the real one, but edge ONLY the
 * shapes whose fill is the vanishing colour for the current mode (`target`) —
 * recoloured to the contrast colour (`edgeColor`) and grown by an even stroke,
 * so a hairline pokes out past those shapes' silhouette. Every other shape is
 * dropped from the edge layer. Because the edge sits behind the real mark, an
 * edge that pokes out only shows where that shape is the OUTER silhouette — so
 * a hue-bodied animal (octopus, fox) gets no visible hairline at all, while a
 * bone-bodied heron/hare/moth (light) or ink-bodied bear/cat/bat/whale (dark)
 * gets the outline it needs.
 *
 * Pure fill/stroke (NOT a filter — react-native-svg filters don't paint on
 * Android; NOT a scale — that gives an uneven edge). `recolorEdge` clones the
 * mark's element tree (zero per-mark edits).
 */

import React from 'react';

export const EDGE_GROW = 3;

/** Case-insensitive hex compare — marks paint via the BONE/INK consts. */
function sameColor(a: string | undefined, b: string): boolean {
  return typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
}

export function recolorEdge(
  node: React.ReactNode,
  edgeColor: string,
  target: string,
): React.ReactNode {
  if (!React.isValidElement(node)) return null;
  const p = node.props as {
    fill?: string;
    stroke?: string;
    strokeWidth?: number | string;
    children?: React.ReactNode;
  };
  const kids =
    p.children !== undefined
      ? React.Children.map(p.children, (c) => recolorEdge(c, edgeColor, target))
      : undefined;

  const hasFill = p.fill !== undefined && p.fill !== 'none';
  const hasStroke = p.stroke !== undefined && p.stroke !== 'none';
  const fillMatches = hasFill && sameColor(p.fill, target);
  // A stroke-only shape (heron neck, mouth line) contributes its silhouette
  // via the stroke; edge it when that stroke is the vanishing colour.
  const strokeMatches = !hasFill && hasStroke && sameColor(p.stroke, target);

  if (fillMatches) {
    const patch: Record<string, unknown> = { fill: edgeColor, stroke: edgeColor };
    patch.strokeWidth =
      hasStroke && typeof p.strokeWidth === 'number' ? p.strokeWidth + EDGE_GROW : EDGE_GROW;
    return React.cloneElement(node, patch, kids);
  }
  if (strokeMatches) {
    const patch: Record<string, unknown> = {
      stroke: edgeColor,
      strokeWidth: typeof p.strokeWidth === 'number' ? p.strokeWidth + EDGE_GROW : EDGE_GROW,
    };
    return React.cloneElement(node, patch, kids);
  }

  // Non-matching. Structural nodes (groups / fragments that carry no own
  // paint) are KEPT so matching descendants still draw — their own paint is
  // neutralized. Non-matching leaves (hue shapes, eyes, the already-
  // contrasting colour) are dropped from the edge layer entirely.
  if (p.children !== undefined) {
    const patch: Record<string, unknown> = {};
    if (hasFill) patch.fill = 'none';
    if (hasStroke) patch.stroke = 'none';
    return React.cloneElement(node, patch, kids);
  }
  return null;
}
