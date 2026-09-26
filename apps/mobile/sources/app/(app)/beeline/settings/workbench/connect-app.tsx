import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { useIsDesktop } from '@/utils/responsive';
import { PageHeader } from '@/components/buzz/PageHeader';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import type { WorkbenchHelper } from '@/buzz/workbench';

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Connect an app — the ONE front door, from a person. There is no route
 * picker: the person names the app and the machine, and the server chooses
 * the route in its fixed order (an app already in the Workbench, the app's
 * official MCP server, then Trusty Squire). Any sign-in or sign-up is handed
 * to that machine's agent, which completes it through Trusty Squire; the
 * Workbench row states progress from there. The machine is always chosen
 * explicitly, exactly as pairing a tool asks for it.
 */
export default function ConnectAppScreen() {
  const params = useLocalSearchParams<{ workspaceId?: string | string[] }>();
  const workspaceId = firstParam(params.workspaceId) ?? '';
  const desktop = useIsDesktop();
  const insets = useSafeAreaInsets();
  const { theme } = useUnistyles();
  const [app, setApp] = useState('');
  const [helpers, setHelpers] = useState<readonly WorkbenchHelper[] | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getWorkbenchSource()
      .listHelpers({ workspaceId })
      .then((result) => {
        if (!cancelled) setHelpers(result);
      })
      .catch(() => {
        if (!cancelled) setError('Helpers are unavailable right now');
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const named = app.trim();
  const connect = useCallback(
    async (helperId: string) => {
      if (!named || working) return;
      setWorking(helperId);
      setError(null);
      try {
        await getWorkbenchSource().connectApp({ workspaceId, app: named, helperId });
        router.back();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Connecting failed');
      } finally {
        setWorking(null);
      }
    },
    [named, working, workspaceId],
  );

  return (
    <View style={[styles.container, { paddingTop: desktop ? 0 : insets.top }]}>
      <PageHeader
        backAccessibilityLabel="Back to Workbench"
        eyebrow="Workbench"
        onBack={() => router.back()}
        testID="connect-app-header"
        title="Connect an app"
      />
      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.contentInner}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.field}>
          <TextInput
            accessibilityLabel="App name or website"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            maxLength={200}
            onChangeText={setApp}
            placeholder="App name or website"
            placeholderTextColor={theme.buzz.dim}
            returnKeyType="done"
            style={styles.input}
            testID="connect-app-input"
            value={app}
          />
          <Text style={styles.note} testID="connect-app-route-note">
            Beeline picks the route: an app already in your Workbench, the app’s official MCP
            server, or Trusty Squire. Squire handles any sign-in on the machine you choose.
          </Text>
        </View>
        {helpers === null && !error ? (
          <View style={styles.loading} testID="connect-app-loading">
            <SurfaceGlyphLoader testID="connect-app-loader" />
          </View>
        ) : null}
        {helpers !== null && helpers.length === 0 ? (
          <View testID="connect-app-no-helper">
            <Text style={styles.empty}>No helpers found</Text>
            <View style={styles.commandBlock}>
              <Text style={styles.command}>npx usebeeline connect</Text>
              <Text style={styles.note}>
                Run this on the machine that will use the app, then come back.
              </Text>
            </View>
          </View>
        ) : null}
        {helpers !== null && helpers.length > 0 ? (
          <View testID="connect-app-machine-picker">
            <Text style={styles.sectionLabel}>Helpers</Text>
            {helpers.map((helper) => {
              const ready = helper.online && named.length > 0 && working === null;
              return (
                <SettingsRow
                  key={helper.id}
                  action={
                    helper.online ? (working === helper.id ? 'connecting' : 'connect') : undefined
                  }
                  description={helper.online ? 'online' : 'offline'}
                  disabled={!ready}
                  onPress={() => void connect(helper.id)}
                  testID={`connect-app-machine-${helper.id}`}
                  title={helper.name}
                  value={helper.online ? undefined : 'offline'}
                />
              );
            })}
          </View>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={styles.errorText} testID="connect-app-error">
            {error}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    container: { flex: 1, backgroundColor: hull.bgTerminal },
    content: { flex: 1 },
    contentInner: {
      padding: hull.space.md,
      gap: hull.layout.sectionGap,
      paddingTop: hull.layout.screenTop,
      paddingBottom: hull.space.xxl,
    },
    field: { gap: hull.space.sm },
    // The one box on the page: the field the person must fill.
    input: {
      ...Typography.default(),
      ...hull.type.body,
      minHeight: 44,
      paddingHorizontal: hull.space.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: hull.border,
      borderRadius: hull.radius,
      color: hull.textPrimary,
    },
    loading: { alignItems: 'center', paddingVertical: hull.space.xl },
    sectionLabel: { ...Typography.default(), ...hull.type.sectionHead, color: hull.textMuted },
    note: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted },
    empty: {
      ...Typography.default(),
      ...hull.type.body,
      color: hull.textPrimary,
      textAlign: 'center',
      paddingVertical: hull.space.md,
    },
    commandBlock: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: hull.border,
      borderRadius: hull.radius,
      padding: hull.space.md,
      gap: hull.space.sm,
    },
    command: { ...Typography.mono(), ...hull.type.body, color: hull.textPrimary },
    errorText: { ...Typography.default(), ...hull.type.meta, color: hull.dialogDanger },
  };
});
