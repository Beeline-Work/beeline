import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { typeRoles } from '@/buzz/groknight';

type Brief = {
  revision: number;
  content: string;
  attachments: readonly { title: string; purpose: string; required: boolean; url: string }[];
};

export function CornerBriefDisclosure({
  brief,
  validation,
  onOpenFile,
}: {
  brief?: Brief;
  validation?: readonly { stage: string; status: string; evidence: string }[];
  onOpenFile(url: string): void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!brief) return null;
  return (
    <View style={styles.wrap} testID="corner-brief">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Assignment revision ${brief.revision}, ${expanded ? 'hide' : 'show'} brief`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={styles.toggle}
        testID="corner-brief-toggle"
      >
        <Text style={styles.label}>
          Assignment · revision {brief.revision} {expanded ? '−' : '+'}
        </Text>
      </Pressable>
      {expanded && (
        <View style={styles.detail} testID="corner-brief-detail">
          <Text style={styles.content} selectable>
            {brief.content}
          </Text>
          {brief.attachments.map((file) => (
            <Pressable
              key={file.url}
              accessibilityRole="link"
              accessibilityLabel={`${file.title}, ${file.purpose}${file.required ? ', required' : ''}`}
              onPress={() => onOpenFile(file.url)}
              style={styles.file}
            >
              <Text style={styles.fileTitle}>{file.title}</Text>
              <Text style={styles.filePurpose}>
                {file.purpose}
                {file.required ? ' · required' : ''}
              </Text>
            </Pressable>
          ))}
          {validation?.length ? (
            <View testID="corner-validation" style={styles.validation}>
              <Text style={styles.fileTitle}>Validation</Text>
              {validation.map((entry) => (
                <View key={entry.stage}>
                  <Text style={styles.fileTitle}>
                    {entry.stage.replaceAll('_', ' ')} · {entry.status.replaceAll('_', ' ')}
                  </Text>
                  <Text style={styles.filePurpose}>{entry.evidence}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: { paddingHorizontal: 22 },
  toggle: { minHeight: 44, justifyContent: 'center' },
  label: { ...typeRoles.meta, color: theme.buzz.textSecondary },
  detail: { paddingBottom: 12, gap: 12 },
  content: { ...typeRoles.body, color: theme.buzz.textPrimary },
  file: { minHeight: 44, justifyContent: 'center' },
  fileTitle: { ...typeRoles.body, color: theme.buzz.textPrimary },
  filePurpose: { ...typeRoles.meta, color: theme.buzz.textSecondary },
  validation: { gap: 8 },
}));
