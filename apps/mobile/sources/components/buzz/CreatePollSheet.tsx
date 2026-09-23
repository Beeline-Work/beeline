import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HullDialog, HullDialogInput } from './HullDialog';

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
  busy,
  onClose,
  onCreate,
}: {
  visible: boolean;
  busy: boolean;
  onClose: () => void;
  onCreate: (draft: PollDraft) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [ttlSeconds, setTtlSeconds] = useState<number>(3600);
  useEffect(() => {
    if (!visible) {
      setPrompt('');
      setOptions(['', '']);
      setTtlSeconds(3600);
    }
  }, [visible]);
  const ready =
    prompt.trim().length > 0 &&
    prompt.trim().length <= 120 &&
    options.length >= 2 &&
    options.every((option) => option.trim().length > 0 && option.trim().length <= 32);
  return (
    <HullDialog
      visible={visible}
      onRequestClose={onClose}
      title="Create poll"
      testID="create-poll-sheet"
      actions={[
        { label: 'Cancel', onPress: onClose, disabled: busy },
        {
          label: 'Create poll',
          variant: 'primary',
          disabled: busy || !ready,
          busy,
          onPress: () =>
            onCreate({
              prompt: prompt.trim(),
              options: options.map((option) => ({
                label: option.trim(),
                consequence: option.trim(),
              })),
              ttlSeconds,
            }),
          testID: 'create-poll-submit',
        },
      ]}
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
    </HullDialog>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { maxHeight: 430 },
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
