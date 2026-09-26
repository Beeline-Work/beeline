import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import QRCode from 'qrcode';

/**
 * The wallet QR — the pure-JS matrix from `qrcode` painted as a grid of
 * tiles (no canvas, no WebView), shared by the receive screen and the
 * wallet dashboard's receive tab. A payload that cannot encode renders the
 * same-size placeholder frame, never a broken image.
 */
export function WalletQr({ payload, size = 180 }: { payload: string; size?: number }) {
  const [modules, setModules] = useState<{
    size: number;
    get: (row: number, col: number) => number;
  } | null>(null);

  useEffect(() => {
    if (!payload) return;
    try {
      setModules(QRCode.create(payload, { errorCorrectionLevel: 'M' }).modules);
    } catch {
      setModules(null);
    }
  }, [payload]);

  if (!modules) {
    return (
      <View
        style={[
          styles.placeholder,
          { backgroundColor: '#ffffff', height: size, width: size },
        ]}
        testID="wallet-qr-placeholder"
      />
    );
  }
  return (
    <View style={[styles.qr, { backgroundColor: '#ffffff', padding: 6 }]} testID="wallet-qr">
      {Array.from({ length: modules.size }, (_, row) => (
        <View key={row} style={styles.qrRow}>
          {Array.from({ length: modules.size }, (_, col) => (
            <View
              key={col}
              style={[
                styles.tile,
                { backgroundColor: modules.get(row, col) ? '#171310' : '#ffffff' },
              ]}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  qr: { borderRadius: 3 },
  qrRow: { flexDirection: 'row' },
  tile: { height: 6, width: 6 },
    placeholder: {
      borderColor: theme.buzz.textMuted,
      borderRadius: 3,
      borderWidth: StyleSheet.hairlineWidth,
    },
}));
