import React, { useState } from 'react';
import { Image, Text, View, type ImageSourcePropType } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import grokLogo from '@/assets/images/agent-logos/grok.png';
import museLogo from '@/assets/images/agent-logos/muse.png';
import claudeLogo from '@/assets/images/agent-logos/claude.png';
import codexLogo from '@/assets/images/agent-logos/codex.png';
import geminiLogo from '@/assets/images/agent-logos/gemini.png';
import opencodeLogo from '@/assets/images/agent-logos/opencode.png';
import piLogo from '@/assets/images/agent-logos/pi.png';
import hermesLogo from '@/assets/images/agent-logos/hermes.png';
import zcodeLogo from '@/assets/images/agent-logos/zcode.png';
import { Button } from './Button';
import { InlineRow } from './IndexRow';

const CONNECTOR_LINE = 'Join my Beeline workspace using the MCP connector https://server.usebeeline.app/mcp';
/** Meta Muse's preregistered client in apps/server/src/rooms-mcp-preregistered.ts. */
const MUSE_CLIENT_ID = '6Zxge0aVJeCxF8Jvshy-oYTjYPJmrFHdTnwVfvkaF0o';
const ROOM_LINE = 'Join my Beeline Room: usebeeline.app/room';

type ExistingAgent = {
  id: string;
  name: string;
  /** Grok and Muse logos carry their brand tile in the image itself. */
  logo: ImageSourcePropType;
  /** A white tile gets a hairline so it does not melt into the Bone sheet. */
  outlined?: boolean;
  line: string;
};

export const EXISTING_AGENTS: readonly ExistingAgent[] = [
  { id: 'grok', name: 'Grok Bot', logo: grokLogo, line: CONNECTOR_LINE },
  {
    id: 'muse',
    name: 'Muse',
    logo: museLogo,
    outlined: true,
    line: `${CONNECTOR_LINE}\n\nClient ID: ${MUSE_CLIENT_ID}`,
  },
  { id: 'claude', name: 'Claude', logo: claudeLogo, line: ROOM_LINE },
  { id: 'codex', name: 'Codex', logo: codexLogo, line: ROOM_LINE },
  { id: 'gemini', name: 'Gemini', logo: geminiLogo, line: ROOM_LINE },
  { id: 'opencode', name: 'OpenCode', logo: opencodeLogo, line: ROOM_LINE },
  { id: 'pi', name: 'Pi', logo: piLogo, line: ROOM_LINE },
  { id: 'hermes', name: 'Hermes', logo: hermesLogo, line: ROOM_LINE },
  { id: 'zcode', name: 'ZCode', logo: zcodeLogo, line: ROOM_LINE },
];

/**
 * Display-only line breaks, matching the approved mock: a URL never splits
 * (word joiner after each slash), and a long ID may split after its hyphen
 * (zero-width space). Copy always copies the plain line.
 */
export function wrapForDisplay(line: string): string {
  return line
    .replace(/https?:\/\/\S+/g, (url) => url.replace(/\//g, '/⁠'))
    .replace(/(\w)-(\w)/g, '$1-​$2');
}

/**
 * The Members-page add-agent sheet (approved mock 3281cf69): pick an existing
 * agent's logo and copy its one join line, or copy the new-agent command.
 */
export function ExistingAgentJoin({
  pairCommand,
  onCopy,
}: {
  pairCommand?: string | null;
  onCopy?: (line: string) => void;
}) {
  const [selectedId, setSelectedId] = useState(EXISTING_AGENTS[0].id);
  const selected = EXISTING_AGENTS.find((agent) => agent.id === selectedId) ?? EXISTING_AGENTS[0];
  return (
    <View style={styles.panel} testID="invite-agent-flow">
      <View testID="existing-agent-join">
        <Text accessibilityRole="header" style={styles.heading}>Existing agent</Text>
        <Text style={styles.subheading}>Paste into existing session</Text>
        <InlineRow accessibilityRole="radiogroup" style={styles.grid}>
          {EXISTING_AGENTS.map((agent) => {
            const on = agent.id === selected.id;
            return (
              <Button
                accessibilityLabel={agent.name}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                appearance={{ control: styles.cell, label: [styles.name, on && styles.nameOn] }}
                icon={
                  <View style={styles.tile}>
                    <Image
                      source={agent.logo}
                      style={[styles.logo, agent.outlined && styles.logoOutlined]}
                    />
                    {on && <View style={styles.ring} testID="existing-agent-ring" />}
                  </View>
                }
                key={agent.id}
                label={agent.name}
                onPress={() => setSelectedId(agent.id)}
                testID={`existing-agent-${agent.id}`}
              />
            );
          })}
        </InlineRow>
        <CopyLine
          accessibilityLabel={`Copy ${selected.name} join line`}
          display={wrapForDisplay(selected.line)}
          line={selected.line}
          onCopy={onCopy}
          testID="existing-agent-line"
        />
      </View>
      <View style={styles.rule} />
      <Text accessibilityRole="header" style={styles.heading}>Create new agent</Text>
      <Text style={styles.subheading}>Run on terminal</Text>
      {pairCommand && (
        <CopyLine
          accessibilityLabel="Copy connect command"
          line={pairCommand}
          onCopy={onCopy}
          style={styles.commandLine}
          testID="pair-agent-command"
        />
      )}
    </View>
  );
}

/** One boxed mono line with a trailing Copy; the whole box copies `line`. */
function CopyLine({
  accessibilityLabel,
  display,
  line,
  onCopy,
  style,
  testID,
}: {
  accessibilityLabel: string;
  /** What the box shows, when it differs from what Copy copies. */
  display?: string;
  line: string;
  onCopy?: (line: string) => void;
  style?: React.ComponentProps<typeof Button>['style'];
  testID: string;
}) {
  return (
    <Button
      accessibilityLabel={accessibilityLabel}
      appearance={{ control: styles.copyBox, label: styles.copyLabel }}
      icon={
        <Text selectable style={styles.line} testID={testID}>
          {display ?? line}
        </Text>
      }
      label="Copy"
      onPress={() => onCopy?.(line)}
      style={style}
    />
  );
}

const TILE = 40;
/** The ring sits 2.5 outside the tile, so its radius is the tile's 10 plus 4. */
const RING_OUTSET = 4;

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    panel: {
      paddingHorizontal: hull.space.md,
      paddingTop: hull.space.lg,
      paddingBottom: hull.space.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: hull.border,
    },
    heading: { ...hull.type.body, ...Typography.default('medium'), color: hull.textPrimary },
    subheading: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted },
    grid: {
      flexWrap: 'wrap',
      alignItems: 'flex-start',
      rowGap: hull.space.sm,
      marginTop: hull.space.md,
      marginBottom: hull.space.md,
    },
    cell: { width: '20%', flexDirection: 'column', alignItems: 'center', gap: hull.space.xs },
    tile: { width: TILE, height: TILE },
    logo: { width: TILE, height: TILE, borderRadius: 10, resizeMode: 'contain' },
    logoOutlined: { borderWidth: 1, borderColor: hull.border },
    ring: {
      position: 'absolute',
      top: -RING_OUTSET,
      left: -RING_OUTSET,
      width: TILE + RING_OUTSET * 2,
      height: TILE + RING_OUTSET * 2,
      borderRadius: 14,
      borderWidth: 1.5,
      borderColor: hull.accent,
    },
    name: { ...Typography.default(), fontSize: 12, lineHeight: 17, color: hull.textMuted },
    nameOn: { ...Typography.default('medium'), color: hull.textPrimary },
    copyBox: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.sm,
      padding: hull.space.sm,
      borderWidth: 1,
      borderColor: hull.border,
      borderRadius: hull.radius,
    },
    line: { ...Typography.mono(), ...hull.type.machine, fontSize: 12, lineHeight: 17, color: hull.textPrimary, flex: 1 },
    copyLabel: { ...Typography.default(), ...hull.type.meta, color: hull.accent },
    rule: { height: 1, backgroundColor: hull.border, marginVertical: hull.space.md },
    commandLine: { marginTop: hull.space.md },
  };
});
