import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { ChangedFile } from '@/sync/transport';
import { groknight } from '@/buzz/groknight';
import { Typography } from '@/constants/Typography';

export interface ChangeReviewReader {
  workspaceFilesRead(sessionId: string): Promise<ChangedFile[]>;
  changedFileRead(
    sessionId: string,
    path: string,
  ): Promise<{ content: string; isBinary?: boolean } | null>;
}

interface ChangeReviewPanelProps {
  transport: ChangeReviewReader;
  sessionId: string;
  tip: string;
}

function statusLetter(status?: string): string {
  switch (status) {
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'copied':
      return 'C';
    case 'type-changed':
      return 'T';
    case 'unmerged':
      return 'U';
    default:
      return 'M';
  }
}

function lineTone(line: string) {
  const isHeader =
    line.startsWith('@@') ||
    line.startsWith('diff ') ||
    line.startsWith('---') ||
    line.startsWith('+++') ||
    line.startsWith('index ');
  if (isHeader) return styles.diffHeaderLine;
  if (line.startsWith('+')) return styles.diffAddedLine;
  if (line.startsWith('-')) return styles.diffRemovedLine;
  return styles.diffContextLine;
}

export function ChangeReviewPanel({ transport, sessionId, tip }: ChangeReviewPanelProps) {
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ChangedFile | null>(null);
  const [patch, setPatch] = useState<string | null>(null);
  const [isBinary, setIsBinary] = useState(false);
  const [loadingPatch, setLoadingPatch] = useState(false);
  const [patchError, setPatchError] = useState<string | null>(null);
  const requestNumber = useRef(0);

  const loadFiles = useCallback(async () => {
    setLoadingFiles(true);
    setFilesError(null);
    setSelected(null);
    setPatch(null);
    try {
      setFiles(await transport.workspaceFilesRead(sessionId));
    } catch (error) {
      setFilesError(String(error));
    } finally {
      setLoadingFiles(false);
    }
  }, [transport, sessionId, tip]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  const openFile = useCallback(
    async (file: ChangedFile) => {
      const request = ++requestNumber.current;
      setSelected(file);
      setPatch(null);
      setIsBinary(Boolean(file.isBinary));
      setPatchError(null);
      setLoadingPatch(true);
      try {
        const result = await transport.changedFileRead(sessionId, file.path);
        if (request !== requestNumber.current) return;
        if (!result) throw new Error('Diff metadata is unavailable for this file');
        setPatch(result.content);
        setIsBinary(Boolean(result.isBinary));
      } catch (error) {
        if (request === requestNumber.current) setPatchError(String(error));
      } finally {
        if (request === requestNumber.current) setLoadingPatch(false);
      }
    },
    [transport, sessionId],
  );

  const lines = useMemo(() => patch?.split('\n') ?? [], [patch]);
  const totalAdded = files.reduce((sum, file) => sum + (file.linesAdded ?? 0), 0);
  const totalRemoved = files.reduce((sum, file) => sum + (file.linesRemoved ?? 0), 0);

  if (loadingFiles) {
    return (
      <View style={styles.loading} testID="change-review-loading">
        <ActivityIndicator size="small" color={groknight.accent} />
        <Text style={styles.mutedText}>Loading changed files…</Text>
      </View>
    );
  }

  if (filesError) {
    return (
      <View style={styles.errorState} testID="change-review-error">
        <Text style={styles.errorTitle}>Changed files could not be loaded</Text>
        <Text style={styles.mutedText} numberOfLines={2}>
          {filesError}
        </Text>
        <TouchableOpacity
          onPress={loadFiles}
          style={styles.retryButton}
          testID="change-review-retry"
        >
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (selected) {
    return (
      <View style={styles.panel} testID="change-review-diff">
        <View style={styles.diffToolbar}>
          <TouchableOpacity
            onPress={() => {
              requestNumber.current += 1;
              setSelected(null);
              setPatch(null);
            }}
            style={styles.filesButton}
            testID="change-review-back"
          >
            <Text style={styles.filesButtonText}>‹ {files.length} files</Text>
          </TouchableOpacity>
          <Text style={styles.selectedPath} numberOfLines={1}>
            {selected.path}
          </Text>
          <Text style={styles.fileStats}>
            +{selected.linesAdded ?? 0} −{selected.linesRemoved ?? 0}
          </Text>
        </View>
        {loadingPatch ? (
          <View style={styles.diffLoading}>
            <ActivityIndicator size="small" color={groknight.accent} />
            <Text style={styles.mutedText}>Loading diff…</Text>
          </View>
        ) : patchError ? (
          <View style={styles.diffLoading}>
            <Text style={styles.errorTitle}>Diff unavailable</Text>
            <Text style={styles.mutedText} numberOfLines={2}>
              {patchError}
            </Text>
          </View>
        ) : isBinary ? (
          <View style={styles.diffLoading}>
            <Text style={styles.binaryTitle}>Binary file changed</Text>
            <Text style={styles.mutedText}>A text diff is not available.</Text>
          </View>
        ) : (
          <FlatList
            data={lines}
            keyExtractor={(_, index) => `${selected.path}-${index}`}
            style={styles.diffList}
            initialNumToRender={30}
            maxToRenderPerBatch={40}
            windowSize={7}
            renderItem={({ item, index }) => (
              <Text
                style={[styles.diffLine, lineTone(item)]}
                selectable
                testID={`change-review-line-${index}`}
              >
                {item || ' '}
              </Text>
            )}
          />
        )}
      </View>
    );
  }

  return (
    <View style={styles.panel} testID="change-review-files">
      <View style={styles.summaryRow}>
        <Text style={styles.summaryTitle}>
          {files.length} changed {files.length === 1 ? 'file' : 'files'}
        </Text>
        <Text style={styles.summaryStats}>
          +{totalAdded} −{totalRemoved}
        </Text>
      </View>
      {files.length === 0 ? (
        <Text style={styles.emptyText}>This change has no file differences.</Text>
      ) : (
        <FlatList
          data={files}
          keyExtractor={(file) => file.path}
          style={styles.fileList}
          initialNumToRender={12}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.fileRow}
              onPress={() => void openFile(item)}
              testID={`change-review-file-${item.path}`}
              accessibilityLabel={`Review diff for ${item.path}`}
            >
              <Text style={styles.statusBadge}>{statusLetter(item.status)}</Text>
              <View style={styles.pathColumn}>
                <Text style={styles.filePath} numberOfLines={1}>
                  {item.path}
                </Text>
                {item.previousPath && (
                  <Text style={styles.previousPath} numberOfLines={1}>
                    from {item.previousPath}
                  </Text>
                )}
              </View>
              {item.isBinary ? (
                <Text style={styles.fileStats}>binary</Text>
              ) : (
                <Text style={styles.fileStats}>
                  +{item.linesAdded ?? 0} −{item.linesRemoved ?? 0}
                </Text>
              )}
              <Text style={styles.chevron}>›</Text>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderWidth: 1,
    borderColor: groknight.border,
    borderRadius: 5,
    overflow: 'hidden',
    backgroundColor: groknight.bgCode,
  },
  loading: {
    minHeight: 72,
    borderWidth: 1,
    borderColor: groknight.border,
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  errorState: {
    borderWidth: 1,
    borderColor: groknight.borderActive,
    borderRadius: 5,
    padding: 12,
    gap: 5,
  },
  errorTitle: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 11,
    fontWeight: '700',
  },
  mutedText: {
    ...Typography.default(),
    color: groknight.muted,
    fontSize: 10,
    lineHeight: 14,
  },
  retryButton: { alignSelf: 'flex-start', paddingVertical: 5, paddingRight: 12 },
  retryText: {
    ...Typography.default('semiBold'),
    color: groknight.accent,
    fontSize: 11,
    fontWeight: '700',
  },
  summaryRow: {
    minHeight: 38,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  summaryTitle: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 11,
    fontWeight: '700',
  },
  summaryStats: {
    ...Typography.mono(),
    color: groknight.textSecondary,
    fontSize: 10,
  },
  fileList: { maxHeight: 190 },
  fileRow: {
    minHeight: 46,
    paddingHorizontal: 9,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: groknight.border,
    gap: 8,
  },
  statusBadge: {
    ...Typography.mono(),
    width: 18,
    color: groknight.accent,
    fontSize: 10,
    fontWeight: '700',
    textAlign: 'center',
  },
  pathColumn: { flex: 1, minWidth: 0 },
  filePath: {
    ...Typography.mono(),
    color: groknight.textSecondary,
    fontSize: 10,
  },
  previousPath: {
    ...Typography.mono(),
    color: groknight.dim,
    fontSize: 8,
    marginTop: 2,
  },
  fileStats: {
    ...Typography.mono(),
    color: groknight.muted,
    fontSize: 9,
  },
  chevron: {
    ...Typography.default(),
    color: groknight.steel,
    fontSize: 16,
  },
  emptyText: {
    ...Typography.default(),
    color: groknight.muted,
    fontSize: 10,
    padding: 12,
  },
  diffToolbar: {
    minHeight: 42,
    paddingHorizontal: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  filesButton: { paddingVertical: 6, paddingRight: 2 },
  filesButtonText: {
    ...Typography.default('semiBold'),
    color: groknight.accent,
    fontSize: 10,
    fontWeight: '700',
  },
  selectedPath: {
    ...Typography.mono(),
    color: groknight.textPrimary,
    fontSize: 10,
    flex: 1,
  },
  diffList: { height: 300, backgroundColor: groknight.bgTerminal },
  diffLine: {
    ...Typography.mono(),
    paddingHorizontal: 9,
    fontSize: 10,
    lineHeight: 16,
  },
  diffHeaderLine: { color: groknight.chrome, backgroundColor: groknight.bgHighlight },
  diffAddedLine: { color: groknight.textPrimary, backgroundColor: groknight.selection },
  diffRemovedLine: { color: groknight.muted, backgroundColor: groknight.bgCode },
  diffContextLine: { color: groknight.textSecondary, backgroundColor: groknight.bgTerminal },
  diffLoading: {
    height: 180,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 16,
  },
  binaryTitle: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
});
