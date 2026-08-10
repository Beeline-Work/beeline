import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AppState,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as LocalAuthentication from 'expo-local-authentication';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as QRCode from 'qrcode';
import Svg, { Path, Rect } from 'react-native-svg';
import { loadBuzzIdentityNsecForExport } from '@/auth/buzz-identity-storage';
import { groknight } from '@/buzz/groknight';
import { Typography } from '@/constants/Typography';

const TYPED_CONFIRMATION = 'EXPORT';

type ConfirmationMethod = 'checking' | 'biometric' | 'typed';

function QrCode({ value }: { value: string }) {
  const { path, size } = useMemo(() => {
    const qr = QRCode.create(value, { errorCorrectionLevel: 'M' });
    const commands: string[] = [];

    for (let row = 0; row < qr.modules.size; row += 1) {
      let start = -1;
      for (let column = 0; column <= qr.modules.size; column += 1) {
        const filled = column < qr.modules.size && qr.modules.get(row, column) === 1;
        if (filled && start < 0) start = column;
        if (!filled && start >= 0) {
          commands.push(`M${start} ${row}h${column - start}v1H${start}z`);
          start = -1;
        }
      }
    }

    return { path: commands.join(''), size: qr.modules.size };
  }, [value]);

  const quietZone = 4;
  const viewBoxSize = size + quietZone * 2;

  return (
    <View
      accessible
      accessibilityLabel="QR code containing your Nostr secret key"
      style={styles.qrFrame}
    >
      <Svg width="100%" height="100%" viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}>
        <Rect width={viewBoxSize} height={viewBoxSize} fill={groknight.textPrimary} />
        <Path
          d={path}
          fill={groknight.bgTerminal}
          transform={`translate(${quietZone} ${quietZone})`}
        />
      </Svg>
    </View>
  );
}

export default function BuzzIdentitySettings() {
  const insets = useSafeAreaInsets();
  const [confirmationMethod, setConfirmationMethod] = useState<ConfirmationMethod>('checking');
  const [biometricLabel, setBiometricLabel] = useState('biometrics');
  const [typedConfirmation, setTypedConfirmation] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lockExport = useCallback(() => {
    setSecret(null);
    setRevealed(false);
    setShowQr(false);
    setCopied(false);
    setTypedConfirmation('');
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (Platform.OS === 'web') {
        if (!cancelled) setConfirmationMethod('typed');
        return;
      }

      try {
        const [hasHardware, isEnrolled, types] = await Promise.all([
          LocalAuthentication.hasHardwareAsync(),
          LocalAuthentication.isEnrolledAsync(),
          LocalAuthentication.supportedAuthenticationTypesAsync(),
        ]);
        if (cancelled) return;
        if (hasHardware && isEnrolled) {
          setBiometricLabel(
            types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)
              ? 'Face ID'
              : 'fingerprint',
          );
          setConfirmationMethod('biometric');
        } else {
          setConfirmationMethod('typed');
        }
      } catch {
        if (!cancelled) setConfirmationMethod('typed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') lockExport();
    });
    return () => subscription.remove();
  }, [lockExport]);

  const loadSecret = useCallback(async () => {
    const storedSecret = await loadBuzzIdentityNsecForExport();
    if (!storedSecret) throw new Error('No identity key is stored on this device.');
    setSecret(storedSecret);
    setRevealed(false);
    setShowQr(false);
  }, []);

  const handleConfirm = useCallback(async () => {
    if (confirmationMethod === 'checking' || working) return;
    if (confirmationMethod === 'typed' && typedConfirmation.trim() !== TYPED_CONFIRMATION) {
      setError(`Type ${TYPED_CONFIRMATION} exactly to continue.`);
      return;
    }

    setWorking(true);
    setError(null);
    try {
      if (confirmationMethod === 'biometric') {
        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: 'Export your Beeline identity key',
          promptSubtitle: 'Confirm that it is you',
          cancelLabel: 'Cancel',
          fallbackLabel: 'Use device passcode',
          biometricsSecurityLevel: 'strong',
        });
        if (!result.success) {
          if (result.error !== 'user_cancel' && result.error !== 'system_cancel') {
            setError('Authentication did not complete. Your key is still hidden.');
          }
          return;
        }
      }
      await loadSecret();
    } catch {
      setError('Beeline could not unlock the identity key on this device.');
      lockExport();
    } finally {
      setWorking(false);
    }
  }, [confirmationMethod, loadSecret, lockExport, typedConfirmation, working]);

  const handleCopy = useCallback(async () => {
    if (!secret) return;
    try {
      await Clipboard.setStringAsync(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Beeline could not copy the key. You can reveal and copy it manually.');
    }
  }, [secret]);

  const maskedSecret = secret
    ? `${secret.slice(0, 5)}${'•'.repeat(Math.max(8, secret.length - 5))}`
    : '';

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.header}>
        <TouchableOpacity
          accessibilityLabel="Back"
          onPress={() => router.back()}
          style={styles.backButton}
        >
          <Text style={styles.backButtonText}>‹</Text>
        </TouchableOpacity>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>Identity</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.intro}>
          <Text style={styles.heading}>Export your key</Text>
          <Text style={styles.body}>Save a copy so you can recover your Beeline identity.</Text>
        </View>

        <View style={styles.warning}>
          <Text style={styles.warningGlyph}>!</Text>
          <Text style={styles.warningText}>
            Anyone with this key controls your identity—export it only to a trusted app.
          </Text>
        </View>

        {!secret ? (
          <View style={styles.confirmSection}>
            <Text style={styles.sectionLabel}>Confirm it&apos;s you</Text>
            {confirmationMethod === 'typed' && (
              <>
                <Text style={styles.confirmHint}>
                  Type {TYPED_CONFIRMATION} to unlock the key on this device.
                </Text>
                <TextInput
                  accessibilityLabel={`Type ${TYPED_CONFIRMATION} to confirm`}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  editable={!working}
                  onChangeText={setTypedConfirmation}
                  onSubmitEditing={() => void handleConfirm()}
                  placeholder={TYPED_CONFIRMATION}
                  placeholderTextColor={groknight.dim}
                  style={styles.confirmInput}
                  value={typedConfirmation}
                />
              </>
            )}
            <TouchableOpacity
              accessibilityRole="button"
              disabled={confirmationMethod === 'checking' || working}
              onPress={() => void handleConfirm()}
              style={[
                styles.primaryButton,
                (confirmationMethod === 'checking' || working) && styles.disabled,
              ]}
            >
              <Text style={styles.primaryButtonText}>
                {confirmationMethod === 'checking'
                  ? 'checking device security…'
                  : working
                    ? 'confirming…'
                    : confirmationMethod === 'biometric'
                      ? `confirm with ${biometricLabel}`
                      : 'confirm export'}
              </Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.exportSection}>
            <View style={styles.exportHeadingRow}>
              <Text style={styles.sectionLabel}>Nostr secret key</Text>
              <Text style={styles.unlockedLabel}>Unlocked</Text>
            </View>
            <View style={styles.secretBox}>
              <Text selectable={revealed} style={styles.secretText}>
                {revealed ? secret : maskedSecret}
              </Text>
            </View>
            <View style={styles.actions}>
              <TouchableOpacity
                accessibilityLabel={revealed ? 'Hide secret key' : 'Reveal secret key'}
                onPress={() => setRevealed((value) => !value)}
                style={styles.secondaryButton}
              >
                <Text style={styles.secondaryButtonText}>{revealed ? 'Hide' : 'Reveal'}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => void handleCopy()} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>{copied ? 'Copied' : 'Copy'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityState={{ expanded: showQr }}
                onPress={() => setShowQr((value) => !value)}
                style={styles.primarySmallButton}
              >
                <Text style={styles.primarySmallButtonText}>{showQr ? 'Hide QR' : 'Show QR'}</Text>
              </TouchableOpacity>
            </View>

            {showQr && (
              <View style={styles.qrSection}>
                <QrCode value={secret} />
                <Text style={styles.qrHint}>Scan only with a Nostr signer you trust.</Text>
              </View>
            )}

            <TouchableOpacity onPress={lockExport} style={styles.lockButton}>
              <Text style={styles.lockButtonText}>Lock this screen</Text>
            </TouchableOpacity>
          </View>
        )}

        {error && (
          <Text accessibilityRole="alert" style={styles.errorText}>
            {error}
          </Text>
        )}

        <Text style={styles.footer}>Copy and QR stay on this device.</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: groknight.bgTerminal },
  header: {
    minHeight: 66,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
    backgroundColor: groknight.bgBase,
  },
  backButton: {
    width: 40,
    height: 40,
    marginRight: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backButtonText: {
    ...Typography.default(),
    color: groknight.chrome,
    fontSize: 31,
    lineHeight: 34,
  },
  headerCopy: { flex: 1, minWidth: 0 },
  title: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 17,
    fontWeight: '700',
  },
  content: { paddingHorizontal: 20, paddingTop: 28, paddingBottom: 36 },
  intro: { maxWidth: 560 },
  sectionLabel: {
    ...Typography.default('semiBold'),
    color: groknight.textSecondary,
    fontSize: 13,
    fontWeight: '700',
  },
  heading: {
    ...Typography.default('semiBold'),
    marginTop: 7,
    color: groknight.textPrimary,
    fontSize: 24,
    fontWeight: '800',
  },
  body: {
    ...Typography.default(),
    marginTop: 9,
    color: groknight.textSecondary,
    fontSize: 12,
    lineHeight: 19,
  },
  warning: {
    marginTop: 24,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  warningGlyph: {
    ...Typography.default('semiBold'),
    width: 22,
    height: 22,
    borderWidth: 1,
    borderColor: groknight.chrome,
    borderRadius: 11,
    color: groknight.chrome,
    fontWeight: '800',
    lineHeight: 20,
    textAlign: 'center',
  },
  warningText: {
    ...Typography.default(),
    flex: 1,
    minWidth: 0,
    color: groknight.chrome,
    fontSize: 12,
    lineHeight: 18,
  },
  confirmSection: { marginTop: 28 },
  confirmHint: {
    ...Typography.default(),
    marginTop: 9,
    color: groknight.muted,
    fontSize: 11,
    lineHeight: 17,
  },
  confirmInput: {
    ...Typography.default(),
    minHeight: 44,
    marginTop: 12,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: groknight.borderActive,
    borderRadius: 4,
    color: groknight.textPrimary,
    backgroundColor: groknight.bgBase,
    fontSize: 14,
    letterSpacing: 1.2,
  },
  primaryButton: {
    minHeight: 46,
    marginTop: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
    backgroundColor: groknight.accent,
  },
  primaryButtonText: {
    ...Typography.default('semiBold'),
    color: groknight.bgTerminal,
    fontSize: 13,
    fontWeight: '800',
  },
  disabled: { opacity: 0.45 },
  exportSection: { marginTop: 28 },
  exportHeadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  unlockedLabel: {
    ...Typography.default('semiBold'),
    color: groknight.muted,
    fontSize: 9,
    fontWeight: '600',
  },
  secretBox: {
    minHeight: 74,
    marginTop: 9,
    padding: 13,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: groknight.borderActive,
    borderRadius: 4,
    backgroundColor: groknight.bgBase,
  },
  secretText: {
    ...Typography.mono(),
    color: groknight.textPrimary,
    fontSize: 12,
    lineHeight: 19,
  },
  actions: { marginTop: 10, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  secondaryButton: {
    minHeight: 38,
    paddingHorizontal: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    ...Typography.default('semiBold'),
    color: groknight.chrome,
    fontSize: 12,
    fontWeight: '600',
  },
  primarySmallButton: {
    minHeight: 38,
    paddingHorizontal: 13,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
    backgroundColor: groknight.accent,
  },
  primarySmallButtonText: {
    ...Typography.default('semiBold'),
    color: groknight.bgTerminal,
    fontSize: 12,
    fontWeight: '800',
  },
  qrSection: { marginTop: 22, alignItems: 'center' },
  qrFrame: {
    width: 248,
    height: 248,
    maxWidth: '100%',
    padding: 8,
    borderRadius: 4,
    backgroundColor: groknight.textPrimary,
  },
  qrHint: {
    ...Typography.default(),
    maxWidth: 320,
    marginTop: 12,
    color: groknight.muted,
    fontSize: 10,
    lineHeight: 15,
    textAlign: 'center',
  },
  lockButton: { marginTop: 22, alignSelf: 'center', paddingHorizontal: 14, paddingVertical: 10 },
  lockButtonText: {
    ...Typography.default('semiBold'),
    color: groknight.steel,
    fontSize: 11,
    fontWeight: '600',
  },
  errorText: {
    ...Typography.default(),
    marginTop: 16,
    color: groknight.chrome,
    fontSize: 11,
    lineHeight: 17,
  },
  footer: {
    ...Typography.default(),
    marginTop: 28,
    color: groknight.dim,
    fontSize: 10,
    lineHeight: 16,
    textAlign: 'center',
  },
});
