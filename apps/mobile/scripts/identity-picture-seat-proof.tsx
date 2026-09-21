import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import IdentitySettings from '../sources/app/(app)/beeline/settings/identity';

const pause = () => new Promise((resolve) => setTimeout(resolve, 250));
const round = (value: number) => Math.round(value * 100) / 100;
const report = (text: string) => {
  const target = document.getElementById('result');
  if (target) target.textContent = text;
};

/**
 * Measures what painted on the Settings identity tile: the picture's box
 * against the bezel it sits in, and the radius of whatever rounds the picture.
 * A seated picture shows the same slab of margin on all four sides, is rounded
 * by its own seat rather than cropped by the bezel, and carries the radius the
 * tile's own geometry derives — the tile radius less the bezel (the inner
 * radius), less that margin.
 */
function readSeat(): string {
  const tileNode = document.querySelector('[data-testid="identity-face-setting"]');
  const markNode = document.querySelector('[data-testid="identity-face-mark"]');
  if (!tileNode || !markNode) {
    return 'settings-identity: NOT RENDERED (identity-face-setting / identity-face-mark)';
  }
  const tileStyle = getComputedStyle(tileNode);
  const tileBox = tileNode.getBoundingClientRect();
  const markBox = markNode.getBoundingClientRect();
  const bezel = parseFloat(tileStyle.borderTopWidth) || 0;
  const tileRadius = parseFloat(tileStyle.borderTopLeftRadius) || 0;
  const seatNode = markNode.parentElement!;
  const seatStyle = getComputedStyle(seatNode);
  const seatRadius = parseFloat(seatStyle.borderTopLeftRadius) || 0;
  const seats = seatNode !== tileNode && seatStyle.overflow === 'hidden';
  const slab = {
    left: round(markBox.left - tileBox.left - bezel),
    top: round(markBox.top - tileBox.top - bezel),
    right: round(tileBox.right - bezel - markBox.right),
    bottom: round(tileBox.bottom - bezel - markBox.bottom),
  };
  const margin = slab.left;
  const even = slab.top === margin && slab.right === margin && slab.bottom === margin && margin > 0;
  const derived = round(tileRadius - bezel - margin);
  const faults: string[] = [];
  if (!seats) faults.push('the picture has no seat — nothing rounds it inside the bezel');
  if (!even) faults.push('the slab is uneven');
  if (Math.abs(seatRadius - derived) > 0.01) {
    faults.push(`seat radius ${round(seatRadius)} is not the derived ${derived}`);
  }
  const measured =
    `settings-identity: tile ${round(tileBox.width)}×${round(tileBox.height)} radius ${tileRadius} bezel ${bezel}, ` +
    `picture ${round(markBox.width)}×${round(markBox.height)} seat radius ${round(seatRadius)} ` +
    `(derived ${derived}), slab ${slab.left}/${slab.top}/${slab.right}/${slab.bottom}`;
  return faults.length === 0
    ? `${measured} — SEATED`
    : `${measured} — NOT SEATED: ${faults.join('; ')}`;
}

async function read() {
  createRoot(document.getElementById('root')!).render(
    <View style={{ width: 390, minHeight: 844, backgroundColor: '#16141f' } as const}>
      <IdentitySettings />
    </View>,
  );
  // The tile is drawn from the device-held identity before any profile read.
  await pause();
  await pause();

  const line = readSeat();
  report(`${line.endsWith('— SEATED') ? 'PASS' : 'FAIL'}\n${line}`);
}

read().catch((error) => report(`FAIL ${String(error)}`));
