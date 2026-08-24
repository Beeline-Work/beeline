import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ChangedFile } from '@/sync/transport';
import { Typography } from '@/constants/Typography';
import { BrittlePress, HullSurface, PixelLoader } from '@/components/buzz/MonoHull';
import { darkTheme } from '@/theme';
import {
  cacheCompleteReviewManifest,
  cacheReviewPatch,
  readCachedReviewGeneration,
  readLatestCachedReviewGeneration,
} from '@/buzz/change-review-cache';

/** Buzz UI is a fixed dark theme (groknight), so the diff pulls the dark
 * variant of the legacy diff colors directly rather than through the
 * light/dark-aware unistyles theme hook. */
const diffColors = darkTheme.colors.diff;

export interface ChangeReviewReader {
  workspaceFilesRead(sessionId: string, reviewTip?: string): Promise<ChangedFile[]>;
  changedFileRead(
    sessionId: string,
    path: string,
    reviewTip?: string,
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

/** The explicit Retry action makes three fresh reads with bounded backoff. */
export async function retryChangeReviewRead<T>(
  operation: () => Promise<T>,
  delaysMs: readonly number[] = [250, 750],
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < delaysMs.length) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, delaysMs[attempt]));
      }
    }
  }
  throw lastError;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error).replace(/^Error:\s*/, '');
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

/** Diff rows are plain Views/Text (no virtualization) so vertical scroll can
 * be a plain ScrollView on Android; cap the render so a huge diff can't blow
 * up memory. */
const DIFF_MAX_RENDERED_LINES = 1500;

function formattedBytes(bytes?: number): string {
  if (bytes === undefined) return 'This file diff';
  if (bytes < 1_000_000) return `${Math.ceil(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function ChangeReviewPanel({
  transport,
  sessionId,
  tip,
  onFilesLoaded,
}: ChangeReviewPanelProps) {
  const cachedAtMount = useRef(
    readCachedReviewGeneration(sessionId, tip) ?? readLatestCachedReviewGeneration(sessionId, tip),
  ).current;
  const [files, setFiles] = useState<ChangedFile[]>(cachedAtMount?.files ?? []);
  const [displayedTip, setDisplayedTip] = useState<string | null>(cachedAtMount?.tip ?? null);
  const [loadingFiles, setLoadingFiles] = useState(!cachedAtMount);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ChangedFile | null>(null);
  const [patch, setPatch] = useState<string | null>(null);
  const [isBinary, setIsBinary] = useState(false);
  const [loadingPatch, setLoadingPatch] = useState(false);
  const [patchError, setPatchError] = useState<string | null>(null);
  const requestNumber = useRef(0);
  const filesRequestNumber = useRef(0);
  const displayedTipRef = useRef<string | null>(cachedAtMount?.tip ?? null);
  const displayedSessionIdRef = useRef<string | null>(cachedAtMount?.sessionId ?? null);
  const hasDisplayedFilesRef = useRef(Boolean(cachedAtMount));

  const loadFiles = useCallback(
    async (withBackoff = false) => {
      const request = ++filesRequestNumber.current;
      if (!hasDisplayedFilesRef.current) setLoadingFiles(true);
      setFilesError(null);
      try {
        const read = () => withChangeReviewTimeout(transport.workspaceFilesRead(sessionId, tip));
        const nextFiles = await (withBackoff ? retryChangeReviewRead(read) : read());
        if (request !== filesRequestNumber.current) return;
        cacheCompleteReviewManifest(sessionId, tip, nextFiles);
        if (displayedTipRef.current !== tip) {
          requestNumber.current += 1;
          setSelected(null);
          setPatch(null);
          setPatchError(null);
        }
        displayedSessionIdRef.current = sessionId;
        displayedTipRef.current = tip;
        hasDisplayedFilesRef.current = true;
        setDisplayedTip(tip);
        setFiles(nextFiles);
        onFilesLoaded?.(nextFiles);
      } catch (error) {
        if (request === filesRequestNumber.current) setFilesError(errorDetail(error));
      } finally {
        if (request === filesRequestNumber.current) setLoadingFiles(false);
      }
    },
    [onFilesLoaded, sessionId, tip, transport],
  );

  useEffect(() => {
    const cached =
      readCachedReviewGeneration(sessionId, tip) ??
      readLatestCachedReviewGeneration(sessionId, tip);
    if (cached) {
      displayedSessionIdRef.current = sessionId;
      displayedTipRef.current = cached.tip;
      hasDisplayedFilesRef.current = true;
      setDisplayedTip(cached.tip);
      setFiles(cached.files);
      onFilesLoaded?.(cached.files);
    } else if (
      displayedSessionIdRef.current !== sessionId ||
      (displayedTipRef.current && displayedTipRef.current !== tip)
    ) {
      displayedSessionIdRef.current = null;
      displayedTipRef.current = null;
      hasDisplayedFilesRef.current = false;
      setDisplayedTip(null);
      setFiles([]);
    }
    void loadFiles();
  }, [loadFiles]);

  const openFile = useCallback(
    async (file: ChangedFile, withBackoff = false) => {
      const request = ++requestNumber.current;
      const reviewTip = displayedTipRef.current ?? tip;
      const cached = readCachedReviewGeneration(sessionId, reviewTip)?.patches[file.path];
      setSelected(file);
      setPatch(cached?.content ?? null);
      setIsBinary(Boolean(cached?.isBinary ?? file.isBinary));
      setPatchError(null);
      if (file.renderUnavailableReason === 'too-large') {
        setLoadingPatch(false);
        return;
      }
      setLoadingPatch(!cached);
      try {
        const read = () => transport.changedFileRead(sessionId, file.path, reviewTip);
        const result = await (withBackoff ? retryChangeReviewRead(read) : read());
        if (request !== requestNumber.current) return;
        if (!result) throw new Error(`Missing diff chunks for ${file.path}`);
        cacheReviewPatch(sessionId, reviewTip, file.path, result);
        setPatch(result.content);
        setIsBinary(Boolean(result.isBinary));
      } catch (error) {
        if (request === requestNumber.current) setPatchError(errorDetail(error));
      } finally {
        if (request === requestNumber.current) setLoadingPatch(false);
      }
    },
    [transport, sessionId, tip],
  );

  const lines = useMemo(() => patch?.split('\n') ?? [], [patch]);
  const visibleLines = useMemo(() => lines.slice(0, DIFF_MAX_RENDERED_LINES), [lines]);
  const truncatedLineCount = lines.length - visibleLines.length;
  const diffContentWidth = useMemo(() => {
    const longest = visibleLines.reduce((max, line) => Math.max(max, line.length), 0);
    return Math.max(DIFF_MIN_CONTENT_WIDTH_PX, longest * DIFF_CHAR_WIDTH_PX + 18);
  }, [visibleLines]);
  const totalAdded = files.reduce((sum, file) => sum + (file.linesAdded ?? 0), 0);
  const totalRemoved = files.reduce((sum, file) => sum + (file.linesRemoved ?? 0), 0);

  if (loadingFiles && files.length === 0) {
    return (
      <HullSurface strength="raised" style={styles.loading} testID="change-review-loading">
        <PixelLoader compact />
        <Text style={styles.mutedText}>LOADING CHANGES</Text>
      </HullSurface>
    );
  }

  if (filesError && files.length === 0) {
    return (
      <HullSurface strength="raised" style={styles.errorState} testID="change-review-error">
        <Text style={styles.errorTitle}>! CHANGES UNAVAILABLE</Text>
        <Text style={styles.mutedText} numberOfLines={3} testID="change-review-error-detail">
          {filesError}
        </Text>
        <TouchableOpacity
          onPress={() => void loadFiles(true)}
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
        {patchError && patch !== null ? (
          <Text style={styles.preparingText} testID="change-review-patch-cache-warning">
            SAVED DIFF SHOWN · {patchError}
          </Text>
        ) : null}
        {loadingPatch ? (
          <View style={styles.diffLoading}>
            <PixelLoader compact />
            <Text style={styles.mutedText}>LOADING CHANGE</Text>
          </View>
        ) : patchError && patch === null ? (
          <View style={styles.diffLoading}>
            <Text style={styles.errorTitle}>! CHANGE UNAVAILABLE</Text>
            <Text style={styles.mutedText} numberOfLines={3}>
              {patchError}
            </Text>
            <TouchableOpacity
              onPress={() => void openFile(selected, true)}
              style={styles.retryButton}
              testID="change-review-patch-retry"
            >
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : selected.renderUnavailableReason === 'too-large' ? (
          <View style={styles.diffLoading} testID="change-review-too-large">
            <Text style={styles.binaryTitle}>Diff too large to render</Text>
            <Text style={styles.mutedText}>
              {formattedBytes(selected.patchBytes)} is included in this change but can’t be shown
              here.
            </Text>
          </View>
        ) : isBinary ? (
          <View style={styles.diffLoading}>
            <Text style={styles.binaryTitle}>Binary file updated</Text>
            <Text style={styles.mutedText}>This file can’t be shown as text.</Text>
          </View>
        ) : (
          // Vertical-outer + horizontal-inner nesting: this is the
          // Android-supported direction for nested scrolling (same-axis
          // nesting hands off correctly via nestedScrollEnabled; the prior
          // vertical-FlatList-inside-horizontal-ScrollView shape never let
          // vertical drags reach the inner list). No virtualization here —
          // rows are plain Text, capped by DIFF_MAX_RENDERED_LINES instead.
          <ScrollView
            nestedScrollEnabled
            showsVerticalScrollIndicator
            style={styles.diffScrollVertical}
            testID="change-review-diff-scroll"
          >
            <ScrollView
              horizontal
              nestedScrollEnabled
              showsHorizontalScrollIndicator
              contentContainerStyle={{ minWidth: diffContentWidth }}
            >
              <View style={{ width: diffContentWidth }}>
                {visibleLines.map((item, index) => {
                  const kind = diffLineKind(item);
                  return (
                    <Text
                      key={`${selected.path}-${index}`}
                      style={[styles.diffLine, diffLineStyle(kind), { width: diffContentWidth }]}
                      numberOfLines={1}
                      selectable
                      testID={`change-review-line-${index}`}
                    >
                      {item || ' '}
                    </Text>
                  );
                })}
                {truncatedLineCount > 0 && (
                  <Text style={styles.diffTruncatedFooter}>
                    diff truncated — showing {visibleLines.length} of {lines.length} lines
                  </Text>
                )}
              </View>
            </ScrollView>
          </ScrollView>
        )}
      </HullSurface>
    );
  }

  return (
    <HullSurface strength="code" style={styles.panel} testID="change-review-files">
      {displayedTip !== tip ? (
        <View style={styles.preparingRow} testID="change-review-preparing-newer">
          <Text style={styles.preparingText}>NEWER CHANGES PREPARING…</Text>
          {filesError ? (
            <Text style={styles.preparingDetail} numberOfLines={2}>
              {filesError}
            </Text>
          ) : null}
          <TouchableOpacity onPress={() => void loadFiles(true)} style={styles.preparingRetry}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : filesError ? (
        <View style={styles.preparingRow} testID="change-review-refresh-warning">
          <Text style={styles.preparingText}>SAVED CHANGES SHOWN</Text>
          <Text style={styles.preparingDetail} numberOfLines={2}>
            {filesError}
          </Text>
          <TouchableOpacity onPress={() => void loadFiles(true)} style={styles.preparingRetry}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : null}
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
              {item.renderUnavailableReason === 'too-large' ? (
                <Text style={styles.fileStats}>too large</Text>
              ) : item.isBinary ? (
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

const styles = StyleSheet.create((theme) => ({
  panel: {
    borderWidth: 1,
    borderColor: theme.buzz.border,
    borderRadius: theme.buzz.radius,
    overflow: 'hidden',
    backgroundColor: theme.buzz.bgTerminal,
  },
  loading: {
    minHeight: 72,
    borderWidth: 1,
    borderColor: theme.buzz.border,
    borderRadius: theme.buzz.radius,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  errorState: {
    borderWidth: 1,
    borderColor: theme.buzz.borderStrong,
    borderRadius: theme.buzz.radius,
    padding: 12,
    gap: 5,
  },
  errorTitle: {
    ...Typography.mono('semiBold'),
    color: theme.buzz.textPrimary,
    fontSize: 11,
    lineHeight: 15,
  },
  mutedText: {
    ...Typography.mono(),
    color: theme.buzz.textMuted,
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
    color: theme.buzz.textPrimary,
    fontSize: 11,
  },
  preparingRow: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: theme.buzz.border,
    gap: 2,
  },
  preparingText: {
    ...Typography.mono('semiBold'),
    color: theme.buzz.textSecondary,
    fontSize: 10,
    lineHeight: 14,
  },
  preparingDetail: {
    ...Typography.mono(),
    color: theme.buzz.textMuted,
    fontSize: 9,
    lineHeight: 13,
  },
  preparingRetry: { minHeight: 28, alignSelf: 'flex-start', justifyContent: 'center' },
  summaryRow: {
    minHeight: 38,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: theme.buzz.border,
  },
  summaryTitle: {
    ...Typography.mono('semiBold'),
    color: theme.buzz.textPrimary,
    fontSize: 11,
  },
  summaryStats: {
    ...Typography.mono(),
    color: theme.buzz.textSecondary,
    fontSize: 11,
  },
  fileList: { maxHeight: 190 },
  fileRow: {
    minHeight: 48,
    paddingHorizontal: 9,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: theme.buzz.border,
    gap: 8,
  },
  statusBadge: {
    ...Typography.mono(),
    width: 18,
    color: theme.buzz.textPrimary,
    fontSize: 11,
    textAlign: 'center',
  },
  pathColumn: { flex: 1, minWidth: 0 },
  filePath: {
    ...Typography.mono(),
    color: theme.buzz.textSecondary,
    fontSize: 11,
  },
  previousPath: {
    ...Typography.mono(),
    color: theme.buzz.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  fileStats: {
    ...Typography.mono(),
    color: theme.buzz.textMuted,
    fontSize: 11,
  },
  chevron: {
    ...Typography.mono(),
    color: theme.buzz.steel,
    fontSize: 16,
  },
  emptyText: {
    ...Typography.mono(),
    color: theme.buzz.textMuted,
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
    borderBottomColor: theme.buzz.border,
  },
  filesButton: { minHeight: 44, justifyContent: 'center', paddingRight: 8 },
  filesButtonText: {
    ...Typography.mono('semiBold'),
    color: theme.buzz.textSecondary,
    fontSize: 11,
  },
  selectedPath: {
    ...Typography.mono(),
    color: theme.buzz.textPrimary,
    fontSize: 11,
    flex: 1,
  },
  diffScrollVertical: { height: 300, backgroundColor: theme.buzz.bgTerminal },
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
    color: theme.buzz.textMuted,
    backgroundColor: theme.buzz.bgHover,
  },
  diffAddedLine: {
    ...Typography.mono('semiBold'),
    color: theme.buzz.diffAdded,
    backgroundColor: diffColors.addedBg,
  },
  diffRemovedLine: {
    color: theme.buzz.diffRemoved,
    backgroundColor: diffColors.removedBg,
  },
  diffContextLine: { color: theme.buzz.textSecondary, backgroundColor: theme.buzz.bgTerminal },
  diffTruncatedFooter: {
    ...Typography.mono(),
    color: theme.buzz.textMuted,
    fontSize: 10,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  diffLoading: {
    height: 180,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 16,
  },
  binaryTitle: {
    ...Typography.mono('semiBold'),
    color: theme.buzz.textPrimary,
    fontSize: 12,
  },
}));
