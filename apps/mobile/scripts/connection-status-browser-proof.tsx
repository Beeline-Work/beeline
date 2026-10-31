import React from 'react';
// @ts-expect-error Standalone proof uses installed react-dom.
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { ConnectionStatus } from '../sources/components/buzz/ConnectionStatus';

const dark = new URLSearchParams(window.location.search).get('theme') === 'obsidian';
const proofInk = dark ? '#f0f0f3' : '#171310';
const proofBorder = dark ? '#3b3048' : '#c9bba0';

function StatusSurface({ title }: { title: string }) {
  return <View style={{ borderWidth: 1, borderColor: proofBorder, margin: 12 }}>
    <Text style={{ color: proofInk, fontSize: 16, padding: 12 }}>{title}</Text>
    <ConnectionStatus />
    <Text style={{ color: proofInk, fontSize: 13, padding: 12 }}>Saved Room content stays visible below this line.</Text>
  </View>;
}

function Proof() {
  return <View>
    <Text style={{ color: proofInk, fontSize: 16, padding: 12 }}>Rendered stand-in: disconnected shared status</Text>
    <StatusSurface title="Room list" />
    <StatusSurface title="Room screen" />
  </View>;
}

createRoot(document.getElementById('root')!).render(<Proof />);
setTimeout(() => {
  const glyphs = document.querySelectorAll('[data-testid="connection-status-disconnected-glyph"]');
  const rows = document.querySelectorAll('[data-testid="connection-status-disconnected"]');
  document.getElementById('result')!.textContent = glyphs.length === 2 && rows.length === 2
    ? 'PASS: Room list and Room screen render the shared disconnected glyph.'
    : `FAIL: expected two glyphs and rows, got ${glyphs.length} glyphs and ${rows.length} rows.`;
}, 300);
