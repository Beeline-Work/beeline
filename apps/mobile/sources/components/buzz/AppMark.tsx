import React, { useState } from 'react';
import { Image, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { serviceFaviconUrl } from './ServiceMark';
import { appBoardColors } from '@/buzz/app-board-style';

// Product marks from Google's public product-logo CDN. A domain favicon for
// these products is the generic Google G, which misidentifies the app.
const PRODUCT_MARKS: Record<string, string> = {
  gmail: 'https://fonts.gstatic.com/s/i/productlogos/gmail_2020q4/v10/web-64dp/logo_gmail_2020q4_color_2x_web_64dp.png',
  'google calendar': 'https://fonts.gstatic.com/s/i/productlogos/calendar_2020q4/v13/web-64dp/logo_calendar_2020q4_color_2x_web_64dp.png',
  'google drive': 'https://fonts.gstatic.com/s/i/productlogos/drive_2020q4/v2/web-64dp/logo_drive_2020q4_color_2x_web_64dp.png',
  'google docs': 'https://fonts.gstatic.com/s/i/productlogos/docs_2020q4/v12/web-64dp/logo_docs_2020q4_color_2x_web_64dp.png',
  'google sheets': 'https://fonts.gstatic.com/s/i/productlogos/sheets_2020q4/v1/web-64dp/logo_sheets_2020q4_color_2x_web_64dp.png',
};

/** A consistent tile for apps, with the official public favicon when available. */
export function AppMark({ name, domain, size = 36, white = false }: { name: string; domain?: string; size?: number; white?: boolean }) {
  const [failed, setFailed] = useState(false);
  const imageSize = Math.round(size * 0.56);
  const productMark = PRODUCT_MARKS[name.toLowerCase()];
  return <View style={[styles.tile, { width: size, height: size, borderRadius: Math.round(size * .22), ...(white ? { backgroundColor: '#FFFFFF' } : {}) }]}>
    <Text style={styles.fallback}>{name.slice(0, 1).toUpperCase()}</Text>
    {(productMark || domain) && !failed ? <Image accessibilityIgnoresInvertColors source={{ uri: productMark ?? serviceFaviconUrl(domain!) }} onError={() => setFailed(true)} style={{ width: imageSize, height: imageSize, position: 'absolute' }} /> : null}
  </View>;
}

const styles = StyleSheet.create((theme) => {
  const board = appBoardColors(theme.buzz);
  return {
    tile: { alignItems: 'center', justifyContent: 'center', backgroundColor: board.tile, overflow: 'hidden' },
    fallback: { ...Typography.default('semiBold'), fontSize: 16, color: board.ink },
  };
});
