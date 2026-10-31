import React, { useState } from 'react';
import { Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { StyleSheet } from 'react-native-unistyles';
import { MCP_STARTER_ROUTINE } from '@beeline/api-contract/phone';
import { SettingsRow } from './SettingsRow';

/** Owner-facing saved instructions for a connected outside agent. */
export function McpStarterRoutine() {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async () => {
    try {
      await Clipboard.setStringAsync(MCP_STARTER_ROUTINE);
      setCopied(true);
      setFailed(false);
    } catch {
      setCopied(false);
      setFailed(true);
    }
  };
  return (
    <View style={styles.section} testID="mcp-starter-routine">
      <SettingsRow title="Starter instructions"
        description={failed ? 'Could not copy. Try again or select the text below.' : 'Paste into this agent’s saved instructions or existing routine prompt.'}
        descriptionTone={failed ? 'danger' : undefined}
        actionControl={{ label: copied ? 'Copied' : 'Copy', onPress: () => void copy() }} />
      <Text selectable style={styles.prompt} testID="mcp-starter-routine-text">{MCP_STARTER_ROUTINE}</Text>
    </View>
  );
}

const styles = StyleSheet.create(theme => ({
  section: { paddingTop: theme.buzz.space.lg, gap: theme.buzz.space.xs },
  prompt: { ...theme.buzz.type.body, color: theme.buzz.textSecondary, paddingHorizontal: theme.buzz.space.sm },
}));
