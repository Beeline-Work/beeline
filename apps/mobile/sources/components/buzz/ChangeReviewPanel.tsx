import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { ChangedFile } from '@/sync/transport';
import { groknight } from '@/buzz/groknight';
import { Typography } from '@/constants/Typography';
import { BrittlePress, HullSurface, PixelLoader } from '@/components/buzz/MonoHull';
import { darkTheme } from '@/theme';

/** Buzz UI is a fixed dark theme (groknight), so the diff pulls the dark
 * variant of the legacy diff colors directly rather than through the
 * light/dark-aware unistyles theme hook. */
const diffColors = darkTheme.colors.diff;

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
  onFilesLoaded?: (files: ChangedFile[]) => void;
}

export const CHANGE_REVIEW_LOAD_TIMEOUT_MS = 12_000;

/** A relay/read failure must turn into a retry state, never an eternal spinner. */
export function withChangeReviewTimeout<T>(
  operation: Promise<T>,
  timeoutMs = CHANGE_REVIEW_LOAD_TIMEOUT_MS,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('Timed out while loading file diffs.')), timeoutMs);
  });
  return Promise.race([operation, deadline]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
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

type DiffLineKind = 'header' | 'added' | 'removed' | 'context';

function diffLineKind(line: string): DiffLineKind {
  const isHeader =
    line.startsWith('@@') ||
    line.startsWith('diff ') ||
    line.startsWith('---') ||
    line.startsWith('+++') ||
    line.startsWith('index ');
  if (isHeader) return 'header';
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  return 'context';
}

function diffLineStyle(kind: DiffLineKind) {
  switch (kind) {
    case 'header':
      return styles.diffHeaderLine;
    case 'added':
      return styles.diffAddedLine;
    case 'removed':
      return styles.diffRemovedLine;
    case 'context':
      return styles.diffContextLine;
  }
}

/** Monospace glyph width estimate at diffLine's 11px font, used to size the
 * horizontally-scrollable diff row so long lines never wrap or clip. */
const DIFF_CHAR_WIDTH_PX = 6.6;
const DIFF_MIN_CONTENT_WIDTH_PX = 320;

export function ChangeReviewPanel({
  transport,
  sessionId,
  tip,
  onFilesLoaded,
}: ChangeReviewPanelProps) {
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ChangedFile | null>(null);
  const [patch, setPatch] = useState<string | null>(null);
  const [isBinary, setIsBinary] = useState(false);
  const [loadingPatch, setLoadingPatch] = useState(false);
  const [patchError, setPatchError] = useState<string | null>(null);
  const requestNumber = useRef(0);
  const filesRequestNumber = useRef(0);

  const loadFiles = useCallback(async () => {
    const request = ++filesRequestNumber.current;
    setLoadingFiles(true);
    setFilesError(null);
    setSelected(null);
    setPatch(null);
    try {
      const nextFiles = await withChangeReviewTimeout(transport.workspaceFilesRead(sessionId));
      if (request !== filesRequestNumber.current) return;
      setFiles(nextFiles);
      onFilesLoaded?.(nextFiles);
    } catch (error) {
      if (request === filesRequestNumber.current) setFilesError(String(error));
    } finally {
      if (request === filesRequestNumber.current) setLoadingFiles(false);
    }
  }, [onFilesLoaded, sessionId, tip, transport]);

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
  const diffContentWidth = useMemo(() => {
    const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
    return Math.max(DIFF_MIN_CONTENT_WIDTH_PX, longest * DIFF_CHAR_WIDTH_PX + 18);
  }, [lines]);
  const totalAdded = files.reduce((sum, file) => sum + (file.linesAdded ?? 0), 0);
  const totalRemoved = files.reduce((sum, file) => sum + (file.linesRemoved ?? 0), 0);

  if (loadingFiles) {
    return (
      <HullSurface strength="raised" style={styles.loading} testID="change-review-loading">
        <PixelLoader compact />
        <Text style={styles.mutedText}>LOADING CHANGES</Text>
      </HullSurface>
    );
  }

  if (filesError) {
    return (
      <HullSurface strength="raised" style={styles.errorState} testID="change-review-error">
        <Text style={styles.errorTitle}>! CHANGES UNAVAILABLE</Text>
        <Text style={styles.mutedText} numberOfLines={2}>
          We couldn’t load these changes. Try again.
        </Text>
        <TouchableOpacity
          onPress={loadFiles}
          style={styles.retryButton}
          testID="change-review-retry"
        >
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </HullSurface>
    );
  }

  if (selected) {
    return (
      <HullSurface strength="code" style={styles.panel} testID="change-review-diff">
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
            <PixelLoader compact />
            <Text style={styles.mutedText}>LOADING CHANGE</Text>
          </View>
        ) : patchError ? (
          <View style={styles.diffLoading}>
            <Text style={styles.errorTitle}>! CHANGE UNAVAILABLE</Text>
            <Text style={styles.mutedText} numberOfLines={2}>
              We couldn’t load this file change. Try again from the file list.
            </Text>
          </View>
        ) : isBinary ? (
          <View style={styles.diffLoading}>
            <Text style={styles.binaryTitle}>Binary file updated</Text>
            <Text style={styles.mutedText}>This file can’t be shown as text.</Text>
          </View>
        ) : (
          <ScrollView
            horizontal
            nestedScrollEnabled
            showsHorizontalScrollIndicator
            style={styles.diffScrollHorizontal}
            contentContainerStyle={{ minWidth: diffContentWidth }}
            testID="change-review-diff-scroll"
          >
            <FlatList
              data={lines}
              keyExtractor={(_, index) => `${selected.path}-${index}`}
              style={[styles.diffList, { width: diffContentWidth }]}
              nestedScrollEnabled
              initialNumToRender={30}
              maxToRenderPerBatch={40}
              windowSize={7}
              renderItem={({ item, index }) => {
                const kind = diffLineKind(item);
                return (
                  <Text
                    style={[styles.diffLine, diffLineStyle(kind), { width: diffContentWidth }]}
                    numberOfLines={1}
                    selectable
                    testID={`change-review-line-${index}`}
                  >
                    {item || ' '}
                  </Text>
                );
              }}
            />
          </ScrollView>
        )}
      </HullSurface>
    );
  }

  return (
    <HullSurface strength="code" style={styles.panel} testID="change-review-files">
      <View style={styles.summaryRow}>
        <Text style={styles.summaryTitle}>
          {files.length} {files.length === 1 ? 'file' : 'files'}
        </Text>
        <Text style={styles.summaryStats}>
          +{totalAdded} −{totalRemoved}
        </Text>
      </View>
      {files.length === 0 ? (
        <Text style={styles.emptyText}>This corner has no file differences.</Text>
      ) : (
        <FlatList
          data={files}
          keyExtractor={(file) => file.path}
          style={styles.fileList}
          initialNumToRender={12}
          renderItem={({ item }) => (
            <BrittlePress
              contentStyle={styles.fileRow}
              onPress={() => void openFile(item)}
              testID={`change-review-file-${item.path}`}
              accessibilityLabel={`View changes to ${item.path}`}
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
            </BrittlePress>
          )}
        />
      )}
    </HullSurface>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderWidth: 1,
    borderColor: groknight.border,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: groknight.bgTerminal,
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
    borderColor: groknight.borderStrong,
    borderRadius: 5,
    padding: 12,
    gap: 5,
  },
  errorTitle: {
    ...Typography.mono('semiBold'),
    color: groknight.textPrimary,
    fontSize: 11,
    lineHeight: 15,
  },
  mutedText: {
    ...Typography.mono(),
    color: groknight.textMuted,
    fontSize: 11,
    lineHeight: 15,
  },
  retryButton: {
    minHeight: 44,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    paddingRight: 12,
  },
  retryText: {
    ...Typography.mono('semiBold'),
    color: groknight.textPrimary,
    fontSize: 11,
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
    ...Typography.mono('semiBold'),
    color: groknight.textPrimary,
    fontSize: 11,
  },
  summaryStats: {
    ...Typography.mono(),
    color: groknight.textSecondary,
    fontSize: 11,
  },
  fileList: { maxHeight: 190 },
  fileRow: {
    minHeight: 48,
    paddingHorizontal: 9,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
    gap: 8,
  },
  statusBadge: {
    ...Typography.mono(),
    width: 18,
    color: groknight.textPrimary,
    fontSize: 11,
    textAlign: 'center',
  },
  pathColumn: { flex: 1, minWidth: 0 },
  filePath: {
    ...Typography.mono(),
    color: groknight.textSecondary,
    fontSize: 11,
  },
  previousPath: {
    ...Typography.mono(),
    color: groknight.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  fileStats: {
    ...Typography.mono(),
    color: groknight.textMuted,
    fontSize: 11,
  },
  chevron: {
    ...Typography.mono(),
    color: groknight.steel,
    fontSize: 16,
  },
  emptyText: {
    ...Typography.mono(),
    color: groknight.textMuted,
    fontSize: 11,
    padding: 12,
  },
  diffToolbar: {
    minHeight: 44,
    paddingHorizontal: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  filesButton: { minHeight: 44, justifyContent: 'center', paddingRight: 8 },
  filesButtonText: {
    ...Typography.mono('semiBold'),
    color: groknight.textSecondary,
    fontSize: 11,
  },
  selectedPath: {
    ...Typography.mono(),
    color: groknight.textPrimary,
    fontSize: 11,
    flex: 1,
  },
  diffScrollHorizontal: { height: 300, backgroundColor: groknight.bgTerminal },
  diffList: { height: 300, backgroundColor: groknight.bgTerminal },
  diffLine: {
    ...Typography.mono(),
    paddingHorizontal: 9,
    fontSize: 11,
    lineHeight: 17,
  },
  // Diffs are a deliberate color exception to Grok Mono Hull's zero-chroma
  // rule (captain override) — conventional green additions / red deletions,
  // reusing the legacy diff renderer's dark-theme tokens. Hunk headers and
  // context lines stay on the neutral grayscale palette.
  diffHeaderLine: {
    ...Typography.mono('semiBold'),
    color: groknight.textMuted,
    backgroundColor: groknight.bgHover,
  },
  diffAddedLine: {
    ...Typography.mono('semiBold'),
    color: diffColors.addedBorder,
    backgroundColor: diffColors.addedBg,
  },
  diffRemovedLine: {
    color: diffColors.removedBorder,
    backgroundColor: diffColors.removedBg,
  },
  diffContextLine: { color: groknight.textSecondary, backgroundColor: groknight.bgTerminal },
  diffLoading: {
    height: 180,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 16,
  },
  binaryTitle: {
    ...Typography.mono('semiBold'),
    color: groknight.textPrimary,
    fontSize: 12,
  },
});
