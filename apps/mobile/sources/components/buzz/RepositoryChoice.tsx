import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { GitHubInstallationAccess } from '@beeline/buzz-client';
import { githubFullNameFromInput, type RepoCandidate } from '@/buzz/room-repo-picker';
import { Typography } from '@/constants/Typography';
import { CHEVRON_ROW_SIZE, ChevronGlyph } from './ChevronGlyph';

export type RepoMode = 'none' | 'link' | 'create';

const MODES: { mode: RepoMode; label: string }[] = [
  { mode: 'none', label: 'None' },
  { mode: 'link', label: 'Link' },
  { mode: 'create', label: 'Create' },
];

const OWNER_ROW_HEIGHT = 44;
const OWNER_MENU_MAX_ROWS = 4;

function repoFullName(candidate: RepoCandidate): string | null {
  return (
    githubFullNameFromInput(candidate.name) ??
    (candidate.remote ? githubFullNameFromInput(candidate.remote) : null)
  );
}

export function splitFullName(candidate: RepoCandidate): { owner: string | null; name: string } {
  const full = repoFullName(candidate);
  if (!full) return { owner: null, name: candidate.name };
  const [owner, name] = full.split('/');
  return { owner: owner ?? null, name: name ?? candidate.name };
}

/** What both repository sheets derive from the name a new repo would take. */
export function repositoryChoiceFacts({
  name,
  candidates,
  installations,
  installationId,
}: {
  name: string;
  candidates: readonly RepoCandidate[];
  installations: readonly GitHubInstallationAccess[];
  installationId: number | null;
}) {
  const activeInstallations = installations.filter((item) => item.status === 'active');
  const selectedInstallation =
    activeInstallations.find((item) => item.installationId === installationId) ??
    activeInstallations[0];
  const sameName = (candidate: RepoCandidate, owner?: string) => {
    const parts = splitFullName(candidate);
    return (
      parts.name.toLowerCase() === name.toLowerCase() &&
      (!owner || parts.owner?.toLowerCase() === owner.toLowerCase())
    );
  };
  const nameMatch = name ? (candidates.find((candidate) => sameName(candidate)) ?? null) : null;
  const takenRepo =
    name && selectedInstallation
      ? (candidates.find((candidate) => sameName(candidate, selectedInstallation.accountLogin)) ??
        null)
      : null;
  return {
    activeInstallations,
    selectedInstallation,
    nameMatch,
    takenRepo,
    githubConnected: activeInstallations.length > 0,
  };
}

/**
 * Wraps a Connect action so the org it connects comes back selected: the
 * first active installation that was not there when Connect was pressed
 * becomes the owner.
 */
export function useSelectConnectedOwner(
  installations: readonly GitHubInstallationAccess[],
  setInstallationId: (installationId: number) => void,
) {
  const before = useRef<Set<number> | null>(null);
  const activeIds = installations
    .filter((item) => item.status === 'active')
    .map((item) => item.installationId);
  const activeKey = activeIds.join(',');
  useEffect(() => {
    if (!before.current) return;
    const added = activeIds.find((id) => !before.current!.has(id));
    if (added === undefined) return;
    before.current = null;
    setInstallationId(added);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);
  return (connect?: () => void) =>
    connect &&
    (() => {
      before.current = new Set(activeIds);
      connect();
    });
}

type Props = {
  /** Prefix for every testID, e.g. `create-room` gives `create-room-repo-row`. */
  testIDPrefix: string;
  busy: boolean;
  revealed: boolean;
  onReveal: () => void;
  /** The collapsed row's value: `None`, or the linked repo's name. */
  collapsedValue: string;
  mode: RepoMode;
  onChooseMode: (mode: RepoMode) => void;
  loading: boolean;
  githubConnected: boolean;
  onConnect?: () => void;
  linkRepo: RepoCandidate | null;
  onOpenList: () => void;
  activeInstallations: GitHubInstallationAccess[];
  selectedInstallation: GitHubInstallationAccess | undefined;
  onSelectInstallation: (installationId: number) => void;
  ownerMenuOpen: boolean;
  setOwnerMenuOpen: (open: boolean) => void;
  createName: string;
  takenRepo: RepoCandidate | null;
  onLinkInstead: (repo: RepoCandidate) => void;
  error?: string | null;
  notice?: string | null;
  /**
   * Grow the block upward so the owner menu, which hangs over the switch,
   * fits inside it. For a sheet with nothing above the switch for the menu to
   * cover, which would otherwise clip it.
   */
  reserveOwnerMenuSpace?: boolean;
};

/**
 * The Repository control from the New Room mock: one collapsed row that turns
 * into the None / Link / Create switch in place. New Room and the Room header
 * sheet both render it.
 */
export function RepositoryChoice({
  testIDPrefix: p,
  busy,
  revealed,
  onReveal,
  collapsedValue,
  mode,
  onChooseMode,
  loading,
  githubConnected,
  onConnect,
  linkRepo,
  onOpenList,
  activeInstallations,
  selectedInstallation,
  onSelectInstallation,
  ownerMenuOpen,
  setOwnerMenuOpen,
  createName,
  takenRepo,
  onLinkInstead,
  error,
  notice,
  reserveOwnerMenuSpace = false,
}: Props) {
  const { theme } = useUnistyles();
  const [menuHeight, setMenuHeight] = useState(0);
  const [headHeight, setHeadHeight] = useState(0);
  const connectRow = (
    <TouchableOpacity
      accessibilityRole="button"
      disabled={busy || !onConnect}
      onPress={onConnect}
      style={styles.boxRow}
      testID={`${p}-github-connect`}
    >
      <Text style={styles.boxKey}>GitHub</Text>
      <Text style={styles.connectValue}>Connect</Text>
      <ChevronGlyph color={styles.chevron.color} direction="right" size={CHEVRON_ROW_SIZE} />
    </TouchableOpacity>
  );

  const loadingRow = (
    <View style={styles.boxRow} testID={`${p}-repo-loading`}>
      <Text style={styles.quiet}>Loading GitHub…</Text>
    </View>
  );

  const linkRow = () => {
    const parts = linkRepo ? splitFullName(linkRepo) : null;
    return (
      <TouchableOpacity
        accessibilityLabel={
          linkRepo
            ? `Linked repository ${repoFullName(linkRepo) ?? linkRepo.name}`
            : 'Choose a repo'
        }
        accessibilityRole="button"
        disabled={busy}
        onPress={onOpenList}
        style={styles.repoRow}
        testID={`${p}-repo-link`}
      >
        <View style={styles.twoLine}>
          {parts?.owner && (
            <Text numberOfLines={1} style={styles.ownerLine}>
              {parts.owner}
            </Text>
          )}
          <Text numberOfLines={1} style={[styles.nameLine, !parts && styles.placeholderName]}>
            {parts?.name ?? 'Choose a repo'}
          </Text>
        </View>
        <ChevronGlyph color={styles.chevron.color} direction="right" size={CHEVRON_ROW_SIZE} />
      </TouchableOpacity>
    );
  };

  const createRow = () => (
    <View style={[styles.repoRow, takenRepo && styles.takenRow]} testID={`${p}-repo-create`}>
      <View style={styles.twoLine}>
        <View style={styles.ownerLineRow}>
          <TouchableOpacity
            accessibilityLabel={`Owner ${selectedInstallation?.accountLogin ?? ''}, change`}
            accessibilityRole="button"
            accessibilityState={{ expanded: ownerMenuOpen }}
            disabled={busy}
            hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
            onPress={() => setOwnerMenuOpen(!ownerMenuOpen)}
            style={styles.ownerChip}
            testID={`${p}-repo-owner`}
          >
            <Text numberOfLines={1} style={styles.ownerChipText}>
              {selectedInstallation?.accountLogin}
            </Text>
            <ChevronGlyph
              color={styles.chevron.color}
              direction={ownerMenuOpen ? 'up' : 'down'}
              size={12}
            />
          </TouchableOpacity>
        </View>
        <Text numberOfLines={1} style={[styles.nameLine, !createName && styles.placeholderName]}>
          {createName || 'room-name'}
        </Text>
        {takenRepo && (
          <View style={styles.takenLine}>
            <Text style={styles.takenText}>Already exists.</Text>
            <TouchableOpacity
              accessibilityRole="button"
              hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
              onPress={() => onLinkInstead(takenRepo)}
              testID={`${p}-repo-link-instead`}
            >
              <Text style={styles.takenAction}>Link it instead</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );

  const ownerMenu = (
    <View
      onLayout={(event) => setMenuHeight(event.nativeEvent.layout.height)}
      style={styles.ownerMenu}
      testID={`${p}-owner-menu`}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        style={{ maxHeight: OWNER_ROW_HEIGHT * OWNER_MENU_MAX_ROWS }}
      >
        {activeInstallations.map((installation) => (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityState={{
              selected: installation.installationId === selectedInstallation?.installationId,
            }}
            key={installation.installationId}
            onPress={() => {
              onSelectInstallation(installation.installationId);
              setOwnerMenuOpen(false);
            }}
            style={[
              styles.ownerMenuRow,
              installation.installationId === selectedInstallation?.installationId &&
                styles.ownerMenuSelected,
            ]}
            testID={`${p}-owner-${installation.installationId}`}
          >
            <Text numberOfLines={1} style={styles.rowLabel}>
              {installation.accountLogin}
            </Text>
            {installation.installationId === selectedInstallation?.installationId && (
              <Text style={styles.selectedMark}>✓</Text>
            )}
          </TouchableOpacity>
        ))}
      </ScrollView>
      {onConnect && (
        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => {
            setOwnerMenuOpen(false);
            onConnect();
          }}
          style={[styles.ownerMenuRow, styles.ownerMenuConnect]}
          testID={`${p}-owner-connect`}
        >
          <Text style={styles.connectText}>Connect another org</Text>
        </TouchableOpacity>
      )}
    </View>
  );

  const slot = () => {
    if (!githubConnected) return loading ? loadingRow : connectRow;
    return mode === 'link' ? linkRow() : createRow();
  };

  if (!revealed) {
    return (
      <TouchableOpacity
        accessibilityRole="button"
        disabled={busy}
        onPress={onReveal}
        style={[styles.boxRow, styles.collapsedRow]}
        testID={`${p}-repo-row`}
      >
        <Text style={styles.boxKey}>Repository</Text>
        <Text numberOfLines={1} style={styles.boxValue}>
          {collapsedValue}
        </Text>
        <ChevronGlyph color={styles.chevron.color} direction="right" size={CHEVRON_ROW_SIZE} />
      </TouchableOpacity>
    );
  }

  const menuShown = ownerMenuOpen && mode === 'create' && githubConnected;
  // The menu ends `xs` above the slot, which starts `sm` below the switch.
  const reserved =
    reserveOwnerMenuSpace && menuShown
      ? Math.max(0, menuHeight + theme.buzz.space.xs - headHeight - theme.buzz.space.sm)
      : 0;

  return (
    <View style={styles.repoBlock}>
      {reserved > 0 && <View style={{ height: reserved }} testID={`${p}-owner-menu-space`} />}
      <View
        onLayout={(event) => setHeadHeight(event.nativeEvent.layout.height)}
        testID={`${p}-repo-head`}
      >
        <Text style={styles.fieldLabel}>Repository</Text>
        <View style={styles.segments} testID={`${p}-repo-mode`}>
          {MODES.map(({ mode: option, label }) => (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityState={{ selected: mode === option, disabled: busy }}
              disabled={busy}
              key={option}
              onPress={() => onChooseMode(option)}
              style={[styles.segment, mode === option && styles.segmentSelected]}
              testID={`${p}-repo-mode-${option}`}
            >
              <Text style={[styles.segmentText, mode === option && styles.segmentTextSelected]}>
                {label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
      {mode !== 'none' && (
        <View style={styles.slot}>
          {menuShown && ownerMenu}
          {slot()}
        </View>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error} testID={`${p}-repo-error`}>
          {error}
        </Text>
      )}
      {mode !== 'none' && !error && !!notice && (
        <Text accessibilityLiveRegion="polite" style={styles.hint}>
          {notice}
        </Text>
      )}
    </View>
  );
}

/** A read-only Repository row for viewers who cannot change the Room's repo. */
export function RepositoryReadonlyRow({ value, testID }: { value: string; testID: string }) {
  return (
    <View style={[styles.boxRow, styles.collapsedRow]} testID={testID}>
      <Text style={styles.boxKey}>Repository</Text>
      <Text numberOfLines={1} style={styles.boxValue}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    fieldLabel: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.textMuted,
      marginBottom: hull.space.xs,
    },
    hint: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.textMuted,
      marginTop: hull.space.sm,
    },
    rowLabel: { ...Typography.default(), ...hull.type.body, color: hull.textPrimary, flex: 1 },
    chevron: { color: hull.textMuted },
    selectedMark: { ...hull.type.body, color: hull.buttonPrimaryFill },
    // One quiet boxed row: the collapsed Repository choice, GitHub Connect, loading.
    boxRow: {
      minHeight: 46,
      paddingHorizontal: hull.space.md,
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.xs,
      borderWidth: 1,
      borderColor: hull.border,
      borderRadius: hull.radius,
    },
    collapsedRow: { marginBottom: hull.space.xs },
    boxKey: { ...Typography.default(), ...hull.type.meta, color: hull.textSecondary, flex: 1 },
    boxValue: { ...Typography.default(), ...hull.type.meta, color: hull.textPrimary },
    connectValue: {
      ...Typography.default('semiBold'),
      ...hull.type.meta,
      color: hull.buttonPrimaryFill,
    },
    repoBlock: { paddingBottom: hull.space.xs },
    segments: {
      flexDirection: 'row',
      padding: hull.space.xs,
      gap: 0,
      backgroundColor: hull.bgBase,
      borderWidth: 1,
      borderColor: hull.border,
      borderRadius: hull.radius,
    },
    segment: {
      flex: 1,
      minHeight: 36,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: hull.radius,
    },
    segmentSelected: { backgroundColor: hull.buttonPrimaryFill },
    segmentText: { ...Typography.default(), ...hull.type.meta, color: hull.textSecondary },
    segmentTextSelected: {
      ...Typography.default('semiBold'),
      color: hull.buttonPrimaryText,
    },
    // The owner menu hangs above the row it changes and covers the switch.
    slot: { position: 'relative', zIndex: 2, marginTop: hull.space.sm },
    repoRow: {
      paddingTop: hull.space.sm,
      paddingBottom: hull.space.sm,
      paddingHorizontal: hull.space.md,
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.sm,
      borderWidth: 1,
      borderColor: hull.border,
      borderRadius: hull.radius,
    },
    takenRow: { borderColor: hull.warning },
    twoLine: { flex: 1, minWidth: 0, gap: hull.space.xs },
    ownerLineRow: { flexDirection: 'row', alignItems: 'center' },
    ownerLine: { ...Typography.default(), ...hull.type.meta, color: hull.textSecondary },
    ownerChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.xs,
      flexShrink: 1,
      minHeight: 22,
      paddingLeft: hull.space.sm,
      paddingRight: hull.space.xs,
      backgroundColor: hull.bgHighlight,
      borderWidth: 1,
      borderColor: hull.borderStrong,
      borderRadius: hull.radius,
    },
    ownerChipText: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.textPrimary,
      flexShrink: 1,
    },
    takenLine: { flexDirection: 'row', alignItems: 'center', gap: hull.space.xs },
    takenText: { ...Typography.default(), ...hull.type.meta, color: hull.warning },
    takenAction: {
      ...Typography.default('semiBold'),
      ...hull.type.meta,
      color: hull.buttonPrimaryFill,
      textDecorationLine: 'underline',
    },
    nameLine: {
      ...Typography.default('semiBold'),
      ...hull.type.bodyStrong,
      color: hull.textPrimary,
    },
    placeholderName: { ...Typography.default(), ...hull.type.body, color: hull.textMuted },
    quiet: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted, flex: 1 },
    ownerMenu: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: '100%',
      marginBottom: hull.space.xs,
      zIndex: 3,
      padding: hull.space.xs,
      borderWidth: 1,
      borderColor: hull.borderStrong,
      borderRadius: hull.radius,
      backgroundColor: hull.bgRaised,
    },
    ownerMenuRow: {
      minHeight: OWNER_ROW_HEIGHT,
      paddingHorizontal: hull.space.sm,
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.sm,
    },
    ownerMenuSelected: { backgroundColor: hull.bgHighlight },
    ownerMenuConnect: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: hull.border },
    connectText: { ...Typography.default(), ...hull.type.body, color: hull.textSecondary },
    error: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.dialogDanger,
      marginTop: hull.space.sm,
    },
  };
});
