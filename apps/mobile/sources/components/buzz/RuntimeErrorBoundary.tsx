import * as React from 'react';
import * as Native from 'react-native';
// Destructure outside the import so the Unistyles Babel rewrite cannot wrap
// the emergency view in the same styling runtime that may have failed.
const { Pressable, ScrollView, Text, View } = Native;
import { beelineThemes } from '@/buzz/groknight';
import { errorDiagnostic, reportClientError, type ClientErrorScope } from '@/buzz/client-error-report';

/** Uses plain token styles, with no theme, navigation, modal or safe-area hooks. */
export function RuntimeErrorView({ error, retry, scope }: {
  error: unknown; retry(): void; scope: ClientErrorScope;
}) {
  React.useEffect(() => { void reportClientError(scope, error); }, [scope, error]);
  const theme = Native.Appearance.getColorScheme() === 'dark' ? beelineThemes.obsidian : beelineThemes.bone;
  const diagnostic = errorDiagnostic(error);
  return <View style={{ backgroundColor: theme.bgBase, padding: 16, gap: 8,
    ...(scope === 'app' ? { flex: 1, paddingTop: 48 } : {}) }} testID="runtime-error">
    <Text accessibilityRole="alert" style={{ ...theme.type.bodyStrong, color: theme.textPrimary }}>
      {scope === 'app' ? 'Beeline could not display this screen' : 'Conversation mode could not start'}
    </Text>
    <ScrollView style={{ maxHeight: 256 }}>
      <Text selectable style={{ ...theme.type.body, color: theme.textPrimary }} testID="runtime-error-message">{diagnostic.message}</Text>
      {diagnostic.stack ? <Text selectable style={{ ...theme.type.meta, color: theme.textSecondary }} testID="runtime-error-stack">{diagnostic.stack}</Text> : null}
    </ScrollView>
    <Pressable accessibilityRole="button" accessibilityLabel="Retry" onPress={retry}
      style={{ minHeight: 44, justifyContent: 'center' }} testID="runtime-error-retry">
      <Text style={{ ...theme.type.bodyStrong, color: theme.accent }}>Retry</Text>
    </Pressable>
  </View>;
}

export class RuntimeErrorBoundary extends React.Component<{
  children: React.ReactNode; scope: ClientErrorScope; onError?(): void | Promise<void>; onRetry?(): void | Promise<void>;
}, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch() {
    try { void Promise.resolve(this.props.onError?.()).catch(() => {}); } catch { /* Recovery remains visible. */ }
  }
  private retry = () => {
    this.setState({ error: null });
    try { void Promise.resolve(this.props.onRetry?.()).catch(cause => this.setState({ error: cause instanceof Error ? cause : new Error(String(cause)) })); }
    catch (cause) { this.setState({ error: cause instanceof Error ? cause : new Error(String(cause)) }); }
  };
  render() {
    return this.state.error ? <RuntimeErrorView error={this.state.error} retry={this.retry} scope={this.props.scope} /> : this.props.children;
  }
}
