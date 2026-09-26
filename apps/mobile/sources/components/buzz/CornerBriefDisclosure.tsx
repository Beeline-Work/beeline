import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { typeRoles } from '@/buzz/groknight';

type Brief = {
  revision: number;
  revisionHash?: string;
  legacy?: boolean;
  content: string;
  intentVerbatim?: readonly { sourceMessageId: string; snapshot: string }[];
  buildSpec?: string;
  criteria?: readonly { id: string; text: string }[];
  nonGoals?: readonly string[];
  references?: readonly {
    label: string;
    authority: string;
    description: string;
    objectId?: string;
  }[];
  approvalBasis?: {
    kind: string;
    sourceMessageId?: string;
    snapshot?: string;
    approvedBy?: string;
    briefHash: string;
    reason?: string;
  };
  history?: readonly {
    revision: number;
    revisionHash: string;
    change?: string;
    approvalKind: string;
  }[];
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
          {brief.legacy || !brief.intentVerbatim?.length ? (
            <>
              <Text style={styles.filePurpose}>Legacy pre-migration assignment</Text>
              <Text style={styles.content} selectable>
                {brief.content}
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.fileTitle}>Human intent · verbatim</Text>
              {brief.intentVerbatim.map((item) => (
                <View key={item.sourceMessageId}>
                  <Text style={styles.content} selectable>
                    {item.snapshot}
                  </Text>
                  <Text style={styles.filePurpose}>Message {item.sourceMessageId}</Text>
                </View>
              ))}
              <Text style={styles.fileTitle}>Acceptance criteria</Text>
              {brief.criteria?.map((criterion) => (
                <Text key={criterion.id} style={styles.content} selectable>
                  {criterion.id} · {criterion.text}
                </Text>
              ))}
              {brief.nonGoals?.length ? (
                <>
                  <Text style={styles.fileTitle}>Non-goals</Text>
                  {brief.nonGoals.map((item) => (
                    <Text key={item} style={styles.filePurpose} selectable>
                      {item}
                    </Text>
                  ))}
                </>
              ) : null}
              <Text style={styles.fileTitle}>Build spec</Text>
              <Text style={styles.content} selectable>
                {brief.buildSpec ?? brief.content}
              </Text>
              <Text style={styles.fileTitle}>Approval basis</Text>
              <Text style={styles.filePurpose} selectable>
                {brief.approvalBasis?.kind.replaceAll('-', ' ') ?? 'unknown'}
                {brief.approvalBasis?.sourceMessageId
                  ? ` · message ${brief.approvalBasis.sourceMessageId}`
                  : ''}
                {brief.revisionHash ? ` · ${brief.revisionHash.slice(0, 12)}` : ''}
              </Text>
              {brief.approvalBasis?.snapshot ? (
                <Text style={styles.content} selectable>
                  {brief.approvalBasis.snapshot}
                </Text>
              ) : null}
              {brief.references?.length ? (
                <>
                  <Text style={styles.fileTitle}>References</Text>
                  {brief.references.map((reference) => (
                    <View key={`${reference.label}:${reference.objectId ?? reference.description}`}>
                      <Text style={styles.content}>{reference.label}</Text>
                      <Text style={styles.filePurpose} selectable>
                        {reference.authority.replaceAll('-', ' ')} · {reference.description}
                      </Text>
                    </View>
                  ))}
                </>
              ) : null}
            </>
          )}
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
              <Text style={styles.filePurpose}>
                Agent-recorded evidence. Merge permission comes from the current PR checks and
                Beeline merge gate.
              </Text>
              {validation.map((entry) => (
                <View key={entry.stage}>
                  <Text style={styles.fileTitle}>
                    {entry.stage.replaceAll('_', ' ')} ·{' '}
                    {entry.status === 'passed'
                      ? 'reported passed'
                      : entry.status.replaceAll('_', ' ')}
                  </Text>
                  <Text style={styles.filePurpose}>{entry.evidence}</Text>
                </View>
              ))}
            </View>
          ) : null}
          {brief.history && brief.history.length > 1 ? (
            <View testID="corner-brief-history" style={styles.validation}>
              <Text style={styles.fileTitle}>Revision history</Text>
              {brief.history.map((entry) => (
                <View key={entry.revision}>
                  <Text style={styles.content}>Revision {entry.revision}</Text>
                  <Text style={styles.filePurpose} selectable>
                    {entry.change ?? 'Initial assignment'} ·{' '}
                    {entry.approvalKind.replaceAll('-', ' ')}
                    {' · '}
                    {entry.revisionHash.slice(0, 12)}
                  </Text>
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
