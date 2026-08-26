import React, { useEffect, useRef, useState } from 'react';
import { Platform, TextInput, type KeyboardTypeOptions } from 'react-native';
import { HullDialog, HullDialogInput } from '@/components/buzz/HullDialog';
import { PromptModalConfig } from '../types';

interface WebPromptModalProps {
  config: PromptModalConfig;
  onConfirm: (value: string | null) => void;
}

/** Historical export name; every platform now uses the Hull input dialog. */
export function WebPromptModal({ config, onConfirm }: WebPromptModalProps) {
  const [inputValue, setInputValue] = useState(config.defaultValue || '');
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, []);

  const keyboardType: KeyboardTypeOptions =
    config.inputType === 'email-address'
      ? 'email-address'
      : config.inputType === 'numeric'
        ? 'numeric'
        : 'default';

  return (
    <HullDialog
      actions={[
        { label: config.cancelText || 'Cancel', onPress: () => onConfirm(null), variant: 'quiet' },
        {
          label: config.confirmText || 'OK',
          onPress: () => onConfirm(inputValue),
          variant: 'primary',
        },
      ]}
      body={config.message}
      dismissOnBackdrop={false}
      onRequestClose={() => onConfirm(null)}
      testID="hull-prompt-dialog"
      title={config.title}
      visible
    >
      <HullDialogInput
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={Platform.OS === 'web'}
        keyboardType={keyboardType}
        onChangeText={setInputValue}
        onSubmitEditing={() => onConfirm(inputValue)}
        placeholder={config.placeholder}
        ref={inputRef}
        returnKeyType="done"
        secureTextEntry={config.inputType === 'secure-text'}
        testID="hull-prompt-input"
        value={inputValue}
      />
    </HullDialog>
  );
}
