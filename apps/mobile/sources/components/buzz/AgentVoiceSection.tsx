import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  VOICE_PROVIDER_LABELS,
  type AgentVoiceCatalog,
  type AgentVoicePreview,
  type VoiceProvider,
} from '@beeline/api-contract/phone';
import { SettingsRow } from './SettingsRow';
import { Button } from './Button';
import { VoicePreviewPlayer } from './VoicePreviewPlayer';

export type AgentVoiceApi = {
  read: () => Promise<AgentVoiceCatalog>;
  save: (provider: VoiceProvider, voiceId: string) => Promise<AgentVoiceCatalog>;
  preview: (provider: VoiceProvider, voiceId: string) => Promise<AgentVoicePreview>;
};
export function AgentVoiceSection({
  agentId,
  configVersion,
  handle,
  canEdit,
  api,
}: {
  agentId: string;
  configVersion?: string;
  handle: string;
  canEdit: boolean;
  api?: AgentVoiceApi;
}) {
  const [catalog, setCatalog] = useState<AgentVoiceCatalog | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const latest = useRef(api);
  latest.current = api;
  const generation = useRef(0);
  const previewRequest = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = () => {
    previewRequest.current++;
    if (timer.current) clearTimeout(timer.current);
    setPlaying(null);
    setSource(null);
  };
  const reason = (e: unknown) =>
    e && typeof e === 'object' && 'code' in e
      ? String(e.code)
      : e instanceof Error
        ? e.message
        : 'Voice unavailable. Try again.';
  const load = async () => {
    const request = ++generation.current;
    setError(null);
    try {
      const response = await latest.current!.read();
      if (request !== generation.current) return;
      setCatalog(response);
      setDraft(response.currentVoiceId);
    } catch (e) {
      if (request === generation.current) setError(reason(e));
    }
  };
  useEffect(() => {
    // A live configuration echo must not invalidate our in-flight save receipt.
    if (saving) return;
    setCatalog(null);
    setOpen(false);
    stop();
    if (latest.current) void load();
  }, [agentId, configVersion]);
  useEffect(
    () => () => {
      generation.current++;
      previewRequest.current++;
      if (timer.current) clearTimeout(timer.current);
    },
    [agentId],
  );
  const preview = async (id: string) => {
    if (playing === id) {
      stop();
      return;
    }
    stop();
    setError(null);
    setPlaying(id);
    const request = previewRequest.current;
    try {
      const result = await latest.current!.preview(catalog!.provider, id);
      if (request !== previewRequest.current) return;
      setSource('url' in result ? result.url : `data:audio/wav;base64,${result.wavBase64}`);
      timer.current = setTimeout(stop, 8000);
    } catch (e) {
      if (request === previewRequest.current) {
        stop();
        setError(reason(e));
      }
    }
  };
  const save = async () => {
    if (saving || !catalog) return;
    stop();
    setSaving(true);
    setError(null);
    const request = generation.current;
    try {
      const response = await latest.current!.save(catalog.provider, draft);
      if (request !== generation.current) return;
      setCatalog(response);
      setDraft(response.currentVoiceId);
      setOpen(false);
    } catch (e) {
      if (request === generation.current) setError(reason(e));
    } finally {
      if (request === generation.current) setSaving(false);
    }
  };
  const selected = catalog?.choices.find((v) => v.id === catalog.currentVoiceId);
  const changeable = canEdit && catalog?.canChange;
  return (
    <View style={styles.section} testID="voice-section">
      <Text style={styles.heading}>VOICE</Text>
      <SettingsRow
        title={selected?.name ?? (api && !error ? 'Loading voice…' : 'Voice unavailable')}
        description={
          catalog
            ? `${catalog.provider === 'fish-s2.1-pro' ? 'Fish' : VOICE_PROVIDER_LABELS[catalog.provider]} · Workspace voice provider`
            : undefined
        }
        action={changeable ? 'Change' : undefined}
        disabled={saving}
        onPress={
          changeable
            ? () => {
                stop();
                setDraft(catalog.currentVoiceId);
                setOpen((v) => !v);
              }
            : undefined
        }
        testID="change-agent-voice"
      />
      {error && (
        <Text style={styles.copy} accessibilityRole="alert" testID="voice-error">
          {error}
        </Text>
      )}
      {!catalog && error && <SettingsRow title="Retry" tone="action" onPress={() => void load()} />}
      {open && catalog && (
        <>
          <Text style={styles.copy}>Choose a voice for @{handle}</Text>
          <ScrollView
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
            style={styles.library}
            testID="voice-library"
          >
            {catalog.choices.map((voice) => (
              <SettingsRow
                key={voice.id}
                title={voice.name}
                description={
                  draft === voice.id
                    ? 'Selected'
                    : catalog.provider === 'fish-s2.1-pro'
                      ? 'Public licensed library voice'
                      : 'Provider library voice'
                }
                disabled={saving}
                onPress={() => setDraft(voice.id)}
                testID={`voice-option-${voice.id}`}
                value={playing === voice.id ? 'Stop' : '▶ Play'}
                valueTone={draft === voice.id ? 'accent' : undefined}
                trailingPress={{
                  disabled: saving,
                  onPress: () => void preview(voice.id),
                  accessibilityLabel: `${playing === voice.id ? 'Stop' : 'Preview'} ${voice.name}`,
                  testID: `preview-${voice.id}`,
                }}
              />
            ))}
          </ScrollView>
          <View style={styles.trailingActions} testID="voice-confirm-actions">
            <Button
              label="Cancel"
              variant="secondary"
              disabled={saving}
              onPress={() => {
                stop();
                setOpen(false);
              }}
              testID="cancel-agent-voice"
            />
            <Button
              label={saving ? 'Saving…' : 'Save'}
              variant="primary"
              loading={saving}
              onPress={() => void save()}
              testID="save-agent-voice"
            />
          </View>
        </>
      )}
      {source && (
        <VoicePreviewPlayer
          key={source}
          source={source}
          onEnd={stop}
          onError={() => {
            stop();
            setError('Voice preview unavailable. Try again.');
          }}
        />
      )}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  section: { paddingTop: theme.buzz.space.lg, gap: theme.buzz.space.md },
  heading: { ...theme.buzz.type.sectionHead, color: theme.buzz.textMuted },
  copy: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
  library: { maxHeight: theme.buzz.layout.row * 5 },
  trailingActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: theme.buzz.space.sm },
}));
