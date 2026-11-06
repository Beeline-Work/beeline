import React from 'react';
import { createRoot } from 'react-dom/client';
import { View, Text } from 'react-native';
import { RepositoryLifecycleRow } from '../../../sources/components/buzz/PrLifecycleCard';
import { beelineThemes } from '../../../sources/buzz/groknight';
const buzz = beelineThemes[new URLSearchParams(location.search).get('theme') || 'bone'];
document.body.style.background = buzz.bgBase;
createRoot(document.getElementById('root')).render(
  <View style={{ padding: 16, gap: 24 }}>
    {[
      'corner-glyph-alignment',
      'mock-embedded-fonts',
      'a-long-corner-name-that-must-truncate-without-moving-either-icon',
    ].map((title, i) => (
      <RepositoryLifecycleRow
        key={title}
        item={{
          id: String(i),
          title,
          kind: 'corner',
          kindLine: 'corner',
          state: 'Opened',
          cornerId: title,
          actor: '',
          updatedBy: '',
        }}
        onOpenCorner={(id) => {
          document.getElementById('destination').textContent = id;
        }}
        onOpenUrl={() => {}}
      />
    ))}
    <Text nativeID="destination" />
  </View>,
);
