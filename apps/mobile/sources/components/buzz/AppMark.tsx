import React, { useState } from 'react';
import { Image, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { serviceFaviconUrl } from './ServiceMark';
import { appBoardColors } from '@/buzz/app-board-style';

/** A consistent tile for apps, with the official public favicon when available. */
export function AppMark({ name, domain, size = 36 }: { name: string; domain?: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const imageSize = Math.round(size * 0.56);
  return <View style={[styles.tile, { width: size, height: size, borderRadius: Math.round(size * .22) }]}>
    <Text style={styles.fallback}>{name.slice(0, 1).toUpperCase()}</Text>
    {domain && !failed ? <Image accessibilityIgnoresInvertColors source={{ uri: serviceFaviconUrl(domain) }} onError={() => setFailed(true)} style={{ width: imageSize, height: imageSize, position: 'absolute' }} /> : null}
  </View>;
}

const styles = StyleSheet.create((theme) => {
  const board = appBoardColors(theme.buzz);
  return {
    tile: { alignItems: 'center', justifyContent: 'center', backgroundColor: board.tile, overflow: 'hidden' },
    fallback: { ...Typography.default('semiBold'), fontSize: 16, color: board.ink },
  };
});
