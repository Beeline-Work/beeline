import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { fenceInscription } from '@/components/buzz/CodeBlock';
import { CodeHighlighter } from '@/components/buzz/CodeHighlighter';
import { HullActionSheet } from '@/components/buzz/HullActionSheet';
import { retrieveTempText } from '@/sync/persistence';
import { t } from '@/text';

type Notice = { title: string; message?: string; exitsScreen?: boolean };

export default function CodeReaderScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const { textId, language, originMessageId } = useLocalSearchParams<{
    textId: string;
    language?: string;
    originMessageId?: string;
  }>();
  const insets = useSafeAreaInsets();
  const [code, setCode] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const title = language?.trim().toLowerCase() || 'text';

  const handleCopy = React.useCallback(async () => {
    if (!code) return;
    try {
      await Clipboard.setStringAsync(code);
      setNotice({ title: t('textSelection.textCopied') });
    } catch {
      setNotice({ title: t('common.error'), message: t('textSelection.failedToCopy') });
    }
  }, [code]);

  React.useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: title,
      headerRight: () => (
        <Pressable
          accessibilityLabel={t('common.copy')}
          accessibilityRole="button"
          disabled={loading || !code}
          onPress={handleCopy}
          style={({ pressed }) => [styles.copyButton, pressed && styles.copyButtonPressed]}
        >
          <Text style={[styles.copyGlyph, (loading || !code) && styles.copyGlyphDisabled]}>⧉</Text>
        </Pressable>
      ),
    });
  }, [code, handleCopy, loading, navigation, title]);

  React.useEffect(() => {
    const content = textId ? retrieveTempText(textId) : null;
    if (content !== null) setCode(content);
    else
      setNotice({
        title: t('common.error'),
        message: t('textSelection.textNotFound'),
        exitsScreen: true,
      });
    setLoading(false);
  }, [textId]);

  const dismissNotice = () => {
    if (notice?.exitsScreen) router.back();
    else setNotice(null);
  };

  return (
    <View style={styles.container} testID="code-reader">
      {loading ? (
        <Text style={styles.loading}>{t('common.loading')}</Text>
      ) : (
        <ScrollView
          accessibilityLabel={`${title} code`}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 18 }]}
          showsVerticalScrollIndicator
          testID={`code-reader-origin-${originMessageId || 'none'}`}
        >
          <Text style={styles.inscription}>{fenceInscription(language ?? null, code)}</Text>
          <CodeHighlighter code={code} language={language ?? null} />
        </ScrollView>
      )}
      {notice ? (
        <View style={styles.overlay} testID="code-reader-notice">
          <View style={styles.scrim} />
          <HullActionSheet style={[styles.sheet, { marginBottom: insets.bottom + 12 }]}>
            <View style={styles.noticeCopy}>
              <Text style={styles.noticeTitle}>{notice.title}</Text>
              {notice.message ? <Text style={styles.noticeBody}>{notice.message}</Text> : null}
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={dismissNotice}
              style={({ pressed }) => [styles.noticeAction, pressed && styles.copyButtonPressed]}
            >
              <Text style={styles.noticeActionText}>{t('common.ok')}</Text>
            </Pressable>
          </HullActionSheet>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.buzz.bgTerminal },
  loading: { marginTop: 50, color: theme.buzz.textMuted, textAlign: 'center' },
  content: { flexGrow: 1, paddingHorizontal: 18, paddingTop: 18 },
  inscription: { ...theme.buzz.type.machine, color: theme.buzz.ledgerBody, marginBottom: 12 },
  copyButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  copyButtonPressed: { backgroundColor: theme.buzz.bgPressed },
  copyGlyph: { color: theme.buzz.chrome, fontFamily: theme.buzz.monoSemibold, fontSize: 20 },
  copyGlyphDisabled: { color: theme.buzz.textMuted },
  overlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end', paddingHorizontal: 12 },
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.buzz.bgTerminal,
    opacity: 0.82,
  },
  sheet: { width: '100%' },
  noticeCopy: { padding: 18 },
  noticeTitle: {
    color: theme.buzz.textPrimary,
    fontFamily: theme.buzz.proseSemibold,
    fontSize: 18,
  },
  noticeBody: { marginTop: 7, color: theme.buzz.textMuted, fontFamily: theme.buzz.proseRegular },
  noticeAction: { minHeight: 50, alignItems: 'center', justifyContent: 'center' },
  noticeActionText: { color: theme.buzz.accent, fontFamily: theme.buzz.monoSemibold, fontSize: 12 },
}));
