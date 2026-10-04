import React, { useState } from 'react';
import { Linking, Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
  AgentSignInCardView,
  AgentSignInHarness,
  AgentSignInKeyProvider,
} from '@beeline/api-contract/phone';
import { AppMark } from './AppMark';
import { Button } from './Button';
import { HullLivePulse } from './MonoHull';
import { TranscriptCard } from './TranscriptCard';
import { WorkflowStepCircle } from './WorkflowRunLine';

/** The company each harness signs in to: its name, logo domain, and site. */
const HARNESS_SERVICE: Record<
  Exclude<AgentSignInHarness, 'opencode' | 'pi' | 'goose'>,
  { name: string; domain: string; site: string; harness: string }
> = {
  claude: { name: 'Claude', domain: 'claude.ai', site: 'claude.ai', harness: 'Claude Code' },
  codex: { name: 'ChatGPT', domain: 'openai.com', site: 'the sign-in page', harness: 'Codex' },
  grok: { name: 'Grok', domain: 'x.ai', site: 'the sign-in page', harness: 'Grok' },
  cursor: { name: 'Cursor', domain: 'cursor.com', site: 'cursor.com', harness: 'Cursor' },
};

const KEY_HARNESS_LABEL: Record<'opencode' | 'pi' | 'goose', string> = {
  opencode: 'OpenCode',
  pi: 'Pi',
  goose: 'Goose',
};

// Mirrors `AGENT_SIGN_IN_PROVIDER_LABELS` (api-contract); kept local so this
// screen never depends on a freshly built package export.
const PROVIDER_LABEL: Record<AgentSignInKeyProvider, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  xai: 'xAI',
};

const PROVIDER_DOMAIN: Record<AgentSignInKeyProvider, string> = {
  openrouter: 'openrouter.ai',
  openai: 'openai.com',
  anthropic: 'anthropic.com',
  google: 'ai.google.dev',
  xai: 'x.ai',
};

const CLAUDE_CODE_SHAPE = /^[\w-]{8,}#[\w-]{8,}$/;

function article(label: string): string {
  return /^[AEIOU]/.test(label) || label === 'xAI' ? 'an' : 'a';
}

/** Show a URL host-first and let the middle give way. */
function displayUrl(url: string): string {
  return url.replace(/^https:\/\//, '');
}

function maskMiddle(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 5)}…${value.slice(-4)}`;
}

async function copyText(value: string): Promise<void> {
  await (await import('expo-clipboard')).setStringAsync(value);
}

async function pasteText(): Promise<string> {
  return (await import('expo-clipboard')).getStringAsync();
}

type Props = {
  card: AgentSignInCardView;
  agentName: string;
  /** The viewer owns this agent: only they see the link, the code, and the field. */
  isOwner: boolean;
  stamp?: string;
  /** Relay a pasted code or key to the agent's machine. Rejects with the reason. */
  onSubmit: (value: string) => Promise<void>;
  testID?: string;
};

/**
 * `@agent login`: the harness's own login, at the call site (DESIGN.md →
 * Transcript cards). The head carries the company's logo; steps use the
 * workflow circles; waiting breathes; a code or key is sent once, never
 * posted, drafted, or shown back.
 */
export function AgentSignInCard({ card, agentName, isOwner, stamp, onSubmit, testID = 'agent-sign-in' }: Props) {
  const { theme } = useUnistyles();
  const [value, setValue] = useState('');
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const keyHarness = card.harness in KEY_HARNESS_LABEL;
  const service = keyHarness ? undefined : HARNESS_SERVICE[card.harness as keyof typeof HARNESS_SERVICE];
  const provider = card.provider ? PROVIDER_LABEL[card.provider] : undefined;
  const harnessLabel = service?.harness ?? KEY_HARNESS_LABEL[card.harness as keyof typeof KEY_HARNESS_LABEL];
  const logo = service
    ? { name: service.name, domain: service.domain }
    : card.provider
      ? { name: provider!, domain: PROVIDER_DOMAIN[card.provider] }
      : undefined;

  const signedIn = card.status === 'signed-in';
  const title = signedIn
    ? service
      ? `Signed in to ${service.name}`
      : provider
        ? `Saved a new ${provider} key`
        : 'Saved a new key'
    : service
      ? `Sign in to ${service.name}`
      : provider
        ? `Add ${article(provider)} ${provider} key`
        : 'Add a new key';
  const subline = signedIn
    ? `${agentName} uses it next turn`
    : isOwner
      ? `${agentName} · ${harnessLabel}`
      : `${agentName} · waiting for its owner`;
  const ask = isOwner && !signedIn;

  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      setValue('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const open = (url: string) => {
    setOpened(true);
    void Linking.openURL(url);
  };
  const paste = async () => {
    const text = (await pasteText().catch(() => '')).trim();
    if (text) setValue(text);
  };

  const failure = error ?? (card.status === 'failed' ? card.errorMessage ?? 'Sign-in failed.' : null);
  const waitingForLink = card.status === 'starting';
  const canAct = card.status === 'pending' || card.status === 'failed' || card.status === 'signing-in';
  const sending = busy || card.status === 'signing-in';

  const failureLine = failure ? (
    <View accessibilityRole="alert" style={styles.failure} testID={`${testID}-error`}>
      <Text style={styles.failureMark}>✗</Text>
      <Text style={styles.failureText}>{failure}</Text>
    </View>
  ) : null;

  const linkStep = (
    index: number,
    label: { ahead: string; done: string },
    url: string,
    button: string,
    last: boolean,
  ) => (
    <View style={[styles.step, last && styles.stepLast]}>
      <WorkflowStepCircle status={opened ? 'done' : 'current'} />
      <View style={styles.stepBody}>
        <Text style={styles.stepTitle}>{opened ? label.done : label.ahead}</Text>
        <Text ellipsizeMode="middle" numberOfLines={1} style={styles.url} testID={`${testID}-url`}>
          {displayUrl(url)}
        </Text>
        <Button label={button} onPress={() => open(url)} testID={`${testID}-open`} variant="secondary" />
        {index === 1 && card.kind === 'paste-code' ? (
          <Text style={styles.meta}>{`Made by ${agentName}'s machine · holds no password or token`}</Text>
        ) : null}
      </View>
    </View>
  );

  const waitLine = (text: string) => (
    <View style={styles.wait}>
      <HullLivePulse>
        <View style={styles.pulse} />
      </HullLivePulse>
      <Text style={styles.meta}>{text}</Text>
    </View>
  );

  const field = (placeholder: string, secure: boolean) => (
    <View style={styles.field}>
      <TextInput
        accessibilityLabel={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!sending}
        onChangeText={setValue}
        onSubmitEditing={() => void submit()}
        placeholder={placeholder}
        placeholderTextColor={theme.buzz.textMuted}
        secureTextEntry={secure}
        style={[styles.input, value ? styles.inputFilled : null]}
        testID={`${testID}-input`}
        value={value}
      />
      <Button
        label={value ? 'Clear' : 'Paste'}
        onPress={() => (value ? setValue('') : void paste())}
        testID={`${testID}-paste`}
        variant="secondary"
      />
    </View>
  );

  let steps: React.ReactNode = null;
  if (ask && waitingForLink) {
    steps = waitLine(`Asking ${agentName}'s machine to start its sign-in…`);
  } else if (ask && canAct && card.kind === 'paste-code' && card.authorizeUrl && service) {
    steps = (
      <>
        {linkStep(
          1,
          { ahead: `Approve on ${service.site}`, done: `Approved on ${service.site}` },
          card.authorizeUrl,
          `Open ${service.site}`,
          false,
        )}
        <View style={[styles.step, styles.stepLast]}>
          <WorkflowStepCircle status={opened || value ? 'current' : 'pending'} />
          <View style={styles.stepBody}>
            <Text style={[styles.stepTitle, !(opened || value) && styles.stepTitleAhead]}>
              {`Paste the code ${service.site} shows`}
            </Text>
            {field(`Code from ${service.site}`, false)}
            {value && CLAUDE_CODE_SHAPE.test(value) ? (
              <Text style={styles.meta} testID={`${testID}-shape`}>
                {`✓ Looks like a ${service.name} login code · ${maskMiddle(value)}`}
              </Text>
            ) : null}
            {failureLine}
            <Button
              disabled={!value.trim()}
              label={sending ? 'Signing in' : 'Sign in'}
              loading={sending}
              onPress={() => void submit()}
              testID={`${testID}-submit`}
            />
          </View>
        </View>
      </>
    );
  } else if (ask && canAct && card.kind === 'device-code' && card.authorizeUrl && card.userCode && service) {
    const minutes = card.expiresAt ? Math.max(1, Math.round((card.expiresAt - Date.now()) / 60_000)) : undefined;
    steps = (
      <>
        {linkStep(
          1,
          { ahead: 'Open the sign-in page', done: 'Opened the sign-in page' },
          card.authorizeUrl,
          'Open sign-in page',
          false,
        )}
        <View style={[styles.step, styles.stepLast]}>
          <WorkflowStepCircle status={opened ? 'current' : 'pending'} />
          <View style={styles.stepBody}>
            <Text style={styles.stepTitle}>Enter this code there</Text>
            <View style={styles.code}>
              <Text selectable style={styles.codeText} testID={`${testID}-code`}>
                {card.userCode}
              </Text>
              <Button
                label="Copy code"
                onPress={() => void copyText(card.userCode!)}
                testID={`${testID}-copy`}
                variant="secondary"
              />
            </View>
            {card.status === 'failed' ? failureLine : waitLine(minutes ? `Waiting for approval · expires in ${minutes} min` : 'Waiting for approval')}
            {card.harness === 'codex' ? (
              <Text style={styles.meta}>Device-code sign-in must be on in ChatGPT → Settings → Security.</Text>
            ) : null}
          </View>
        </View>
      </>
    );
  } else if (ask && canAct && card.kind === 'approve-wait' && card.authorizeUrl && service) {
    steps = (
      <>
        {linkStep(
          1,
          { ahead: `Approve on ${service.site}`, done: `Opened ${service.site}` },
          card.authorizeUrl,
          `Open ${service.site}`,
          true,
        )}
        {card.status === 'failed' ? failureLine : waitLine('Waiting for approval')}
      </>
    );
  } else if (ask && canAct && card.kind === 'api-key' && provider) {
    steps = (
      <View style={[styles.step, styles.stepLast]}>
        <WorkflowStepCircle status="current" />
        <View style={styles.stepBody}>
          <Text style={styles.stepTitle}>{`Paste your ${provider} API key`}</Text>
          {field(`${provider} API key`, true)}
          <Text style={styles.meta}>
            {`Checked with ${provider}, then saved on ${agentName}'s machine only. Never posted here.`}
          </Text>
          {failureLine}
          <Button
            disabled={!value.trim()}
            label={sending ? 'Saving key' : 'Save key'}
            loading={sending}
            onPress={() => void submit()}
            testID={`${testID}-submit`}
          />
        </View>
      </View>
    );
  } else if (ask) {
    steps = failureLine;
  }

  return (
    <TranscriptCard
      identity={logo ? <AppMark domain={logo.domain} name={logo.name} size={26} white /> : undefined}
      stamp={stamp}
      subline={subline}
      testID={testID}
      tier={ask ? 'ask' : 'record'}
      title={title}
    >
      {steps}
    </TranscriptCard>
  );
}

const styles = StyleSheet.create((theme) => ({
  step: {
    flexDirection: 'row',
    gap: theme.buzz.space.md,
    paddingVertical: theme.buzz.space.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.buzz.border,
  },
  stepLast: { borderBottomWidth: 0 },
  stepBody: { flex: 1, minWidth: 0, gap: theme.buzz.space.sm },
  stepTitle: { ...theme.buzz.type.body, color: theme.buzz.textPrimary },
  stepTitleAhead: { color: theme.buzz.textMuted },
  url: { ...theme.buzz.type.machine, color: theme.buzz.textSecondary },
  meta: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
  field: { flexDirection: 'row', gap: theme.buzz.space.sm },
  input: {
    ...theme.buzz.type.body,
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    paddingHorizontal: theme.buzz.space.sm,
    borderWidth: 1,
    borderColor: theme.buzz.borderStrong,
    borderRadius: theme.buzz.radius,
    backgroundColor: theme.buzz.bgBase,
    color: theme.buzz.textPrimary,
  },
  inputFilled: { ...theme.buzz.type.machine, color: theme.buzz.textPrimary },
  code: { flexDirection: 'row', alignItems: 'center', gap: theme.buzz.space.sm },
  codeText: { ...theme.buzz.type.machine, flex: 1, color: theme.buzz.textPrimary },
  wait: { flexDirection: 'row', alignItems: 'center', gap: theme.buzz.space.sm },
  pulse: {
    width: theme.buzz.space.sm,
    height: theme.buzz.space.sm,
    borderRadius: theme.buzz.space.sm / 2,
    backgroundColor: theme.buzz.accent,
  },
  failure: { flexDirection: 'row', gap: theme.buzz.space.sm },
  failureMark: { ...theme.buzz.type.meta, color: theme.buzz.accent },
  failureText: { ...theme.buzz.type.meta, flex: 1, color: theme.buzz.textSecondary },
}));
