import { useTextDraft } from '@/buzz/use-text-draft';
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HullDialogInput } from './HullDialog';
import { HULL_SHEET_INSET, HullActionSheetCancel, HullActionSheetModal } from './HullActionSheet';
import { MonoButton } from './MonoHull';

const CLOSING_TIMES = [
  { label: '5 min', seconds: 300 },
  { label: '15 min', seconds: 900 },
  { label: '1 hour', seconds: 3600 },
  { label: '4 hours', seconds: 14400 },
  { label: '1 day', seconds: 86400 },
] as const;

export type PollDraft = {
  prompt: string;
  options: { label: string; consequence: string }[];
  ttlSeconds: number;
};

export function CreatePollSheet({
  visible,
  draftContext = 'global',
  busy,
  onClose,
  onCreate,
}: {
  visible: boolean;
  draftContext?: string;
  busy: boolean;
  onClose: () => void;
  onCreate: (draft: PollDraft) => Promise<boolean>;
}) {
  const [prompt, setPrompt, promptDraft] = useTextDraft(`poll:${draftContext}:prompt`, '');
  const [options, setOptions, optionsDraft] = useTextDraft(`poll:${draftContext}:options`, ['', '']);
  const [ttlSeconds, setTtlSeconds] = useState<number>(3600);
  useEffect(() => {
    if (!visible) {
      setTtlSeconds(3600);
    }
  }, [visible]);
  const ready =
    prompt.trim().length > 0 &&
    prompt.trim().length <= 120 &&
    options.length >= 2 &&
    options.every((option) => option.trim().length > 0 && option.trim().length <= 32);
  return (
    <HullActionSheetModal
      visible={visible}
      onClose={busy ? () => undefined : onClose}
      dismissOnBackdrop={!busy}
      scrollBody={false}
      title="Create poll"
      testID="create-poll-sheet"
      footer={
        <View>
          <View style={styles.submitInset}>
            <MonoButton
              disabled={busy || !ready}
              label="Create poll"
              loading={busy}
              onPress={async () => {
                const clearPrompt = promptDraft.capture();
                const clearOptions = optionsDraft.capture();
                const succeeded = await onCreate({
                  prompt: prompt.trim(),
                  options: options.map((option) => ({
                    label: option.trim(),
                    consequence: option.trim(),
                  })),
                  ttlSeconds,
                });
                if (succeeded) {
                  clearPrompt();
                  clearOptions();
                }
              }}
              testID="create-poll-submit"
              variant="primary"
            />
          </View>
          <HullActionSheetCancel disabled={busy} onPress={onClose} />
        </View>
      }
    >
      <ScrollView keyboardShouldPersistTaps="handled" style={styles.content}>
        <Text style={styles.label}>Question</Text>
        <HullDialogInput
          value={prompt}
          onChangeText={setPrompt}
          placeholder="What should we decide?"
          maxLength={120}
          testID="create-poll-question"
        />
        <Text style={styles.label}>Options</Text>
        {options.map((option, index) => (
          <View key={index} style={styles.optionRow}>
            <Text style={styles.optionLetter}>{String.fromCharCode(65 + index)}</Text>
            <View style={styles.optionInput}>
              <HullDialogInput
                value={option}
                onChangeText={(value) =>
                  setOptions((current) => current.map((item, i) => (i === index ? value : item)))
                }
                placeholder={`Option ${index + 1}`}
                maxLength={32}
                testID={`create-poll-option-${index}`}
              />
            </View>
            {options.length > 2 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove option ${index + 1}`}
                onPress={() => setOptions((current) => current.filter((_, i) => i !== index))}
                style={styles.remove}
              >
                <Text style={styles.actionText}>Remove</Text>
              </Pressable>
            ) : null}
          </View>
        ))}
        {options.length < 4 ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => setOptions((current) => [...current, ''])}
            style={styles.add}
            testID="create-poll-add-option"
          >
            <Text style={styles.actionText}>Add option</Text>
          </Pressable>
        ) : null}
        <Text style={styles.label}>Closes after</Text>
        <View style={styles.times}>
          {CLOSING_TIMES.map((time) => (
            <Pressable
              key={time.seconds}
              accessibilityRole="radio"
              accessibilityState={{ selected: ttlSeconds === time.seconds }}
              onPress={() => setTtlSeconds(time.seconds)}
              style={[styles.time, ttlSeconds === time.seconds && styles.timeSelected]}
            >
              <Text style={styles.actionText}>{time.label}</Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </HullActionSheetModal>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { maxHeight: 470, paddingHorizontal: HULL_SHEET_INSET },
  submitInset: { paddingHorizontal: HULL_SHEET_INSET, paddingTop: 12, paddingBottom: 8 },
  label: {
    ...theme.buzz.type.meta,
    color: theme.buzz.textPrimary,
    fontWeight: '600',
    marginTop: 16,
    marginBottom: 6,
  },
  optionRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  optionLetter: { color: theme.buzz.textPrimary, width: 18 },
  optionInput: { flex: 1 },
  remove: { minHeight: 44, justifyContent: 'center' },
  add: { minHeight: 44, justifyContent: 'center' },
  actionText: { ...theme.buzz.type.meta, color: theme.buzz.textPrimary },
  times: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  time: {
    minHeight: 44,
    minWidth: 70,
    paddingHorizontal: 10,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.buzz.borderStrong,
    borderRadius: theme.buzz.radius,
  },
  timeSelected: { borderColor: theme.buzz.accent },
}));
