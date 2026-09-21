import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { groknight } from '../sources/buzz/groknight';
import IdentitySettings from '../sources/app/(app)/beeline/settings/identity';

const PICTURE =
  'data:image/svg+xml;base64,' +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">' +
      '<rect width="96" height="96" fill="#ffffff"/>' +
      '<rect x="0" y="0" width="28" height="28" fill="#000000"/>' +
      '<rect x="68" y="0" width="28" height="28" fill="#000000"/>' +
      '<rect x="0" y="68" width="28" height="28" fill="#000000"/>' +
      '<rect x="68" y="68" width="28" height="28" fill="#000000"/>' +
      '</svg>',
  );

const before = new URLSearchParams(location.search).get('mode') === 'before';

/**
 * The shipping defect: a 64px square photo inset in the 76px brass bezel,
 * overflow hidden on the tile (which the inset picture never reaches), and
 * no radius on the picture. Square corners point into the rounded bezel.
 */
function BeforeSettings() {
  return (
    <View
      style={{
        width: 390,
        minHeight: 844,
        backgroundColor: groknight.bgTerminal,
      }}
    >
      <View
        style={{
          minHeight: 66,
          paddingHorizontal: 12,
          flexDirection: 'row',
          alignItems: 'center',
          borderBottomWidth: 1,
          borderBottomColor: groknight.border,
        }}
      >
        <Text style={{ color: groknight.textPrimary, fontSize: 22, width: 48 }}>{'‹'}</Text>
        <Text style={{ color: groknight.textPrimary, fontSize: 22, fontWeight: '600' }}>
          Settings
        </Text>
      </View>
      <View style={{ alignItems: 'center', paddingTop: 24, paddingBottom: 24, gap: 16 }}>
        <View
          style={{
            width: 76,
            height: 76,
            borderRadius: 20,
            borderWidth: 2,
            borderColor: groknight.accent,
            backgroundColor: groknight.bgRaised,
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
          }}
        >
          <img
            alt=""
            data-testid="identity-face-mark"
            height={64}
            src={PICTURE}
            style={{ width: 64, height: 64, display: 'block' }}
            width={64}
          />
        </View>
        <Text style={{ color: groknight.accent, fontSize: 16, fontWeight: '600' }}>
          @<Text style={{ color: groknight.textPrimary }}>captain</Text>
        </Text>
      </View>
    </View>
  );
}

const page = {
  width: 390,
  minHeight: 844,
  backgroundColor: groknight.bgTerminal,
} as const;

createRoot(document.getElementById('root')!).render(
  before ? (
    <BeforeSettings />
  ) : (
    <View style={page}>
      <IdentitySettings />
    </View>
  ),
);
