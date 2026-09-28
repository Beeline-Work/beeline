import React, { useState } from 'react';
import { Image, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { serviceFaviconUrl } from './ServiceMark';
import { appBoardColors } from '@/buzz/app-board-style';

// Product marks from Google's public product-logo CDN. A domain favicon for
// these products is the generic Google G, which misidentifies the app.
const PRODUCT_MARKS: Record<string, ReturnType<typeof require>> = {
  gmail: require('../../../assets/app-logos/gmail.png'),
  'google calendar': require('../../../assets/app-logos/calendar.png'),
  'google drive': require('../../../assets/app-logos/drive.png'),
  'google docs': require('../../../assets/app-logos/docs.png'),
  'google sheets': require('../../../assets/app-logos/sheets.png'),
};

/** A consistent tile for apps, with the official public favicon when available. */
export function AppMark({ name, domain, size = 36, white = false }: { name: string; domain?: string; size?: number; white?: boolean }) {
  const [failed, setFailed] = useState(false);
  const imageSize = Math.round(size * 0.56);
  const productMark = PRODUCT_MARKS[name.toLowerCase()];
  return <View style={[styles.tile, { width: size, height: size, borderRadius: Math.round(size * .22), ...(white ? { backgroundColor: '#FFFFFF' } : {}) }]}>
    <Text style={styles.fallback}>{name.slice(0, 1).toUpperCase()}</Text>
    {productMark ? <Image accessibilityIgnoresInvertColors source={productMark} style={{ width: imageSize, height: imageSize, position: 'absolute' }} /> : domain && !failed ? <Image accessibilityIgnoresInvertColors source={{ uri: serviceFaviconUrl(domain) }} onError={() => setFailed(true)} style={{ width: imageSize, height: imageSize, position: 'absolute' }} /> : null}
  </View>;
}

const styles = StyleSheet.create((theme) => {
  const board = appBoardColors(theme.buzz);
  return {
    tile: { alignItems: 'center', justifyContent: 'center', backgroundColor: board.tile, overflow: 'hidden' },
    fallback: { ...Typography.default('semiBold'), fontSize: 16, color: board.ink },
  };
});
