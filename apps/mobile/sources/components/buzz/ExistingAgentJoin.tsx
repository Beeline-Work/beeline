import React, { useState } from 'react';
import { Image, Pressable, Text, TouchableOpacity, View, type ImageSourcePropType } from 'react-native';
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

const CONNECTOR_LINE = 'Join my Beeline workspace using the MCP connector https://server.usebeeline.app/mcp';
/** Meta Muse's preregistered client in apps/server/src/rooms-mcp-preregistered.ts. */
const MUSE_CLIENT_ID = '6Zxge0aVJeCxF8Jvshy-oYTjYPJmrFHdTnwVfvkaF0o';
const ROOM_LINE = 'Join my Beeline Room: usebeeline.app/room';

type ExistingAgent = {
  id: string;
  name: string;
  logo: ImageSourcePropType;
  /** Brand tile behind a logo that is drawn smaller than its tile. */
  tile?: 'dark' | 'white';
  line: string;
};

export const EXISTING_AGENTS: readonly ExistingAgent[] = [
  { id: 'grok', name: 'Grok Bot', logo: grokLogo, tile: 'dark', line: CONNECTOR_LINE },
  {
    id: 'muse',
    name: 'Muse',
    logo: museLogo,
    tile: 'white',
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

/** The "Existing agent" half of the add-agent sheet: tap a logo, copy its one join line. */
export function ExistingAgentJoin({ onCopy }: { onCopy?: (line: string) => void }) {
  const [selectedId, setSelectedId] = useState(EXISTING_AGENTS[0].id);
  const selected = EXISTING_AGENTS.find((agent) => agent.id === selectedId) ?? EXISTING_AGENTS[0];
  return (
    <View testID="existing-agent-join">
      <Text accessibilityRole="header" style={styles.heading}>Existing agent</Text>
      <Text style={styles.subheading}>Paste into existing session</Text>
      <View style={styles.grid}>
        {EXISTING_AGENTS.map((agent) => {
          const on = agent.id === selected.id;
          return (
            <Pressable
              accessibilityLabel={agent.name}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              key={agent.id}
              onPress={() => setSelectedId(agent.id)}
              style={styles.cell}
              testID={`existing-agent-${agent.id}`}
            >
              <View style={[styles.ring, on && styles.ringOn]}>
                <View
                  style={[
                    styles.tile,
                    agent.tile === 'dark' && styles.tileDark,
                    agent.tile === 'white' && styles.tileWhite,
                  ]}
                >
                  <Image source={agent.logo} style={agent.tile ? styles.logoInset : styles.logoFull} />
                </View>
              </View>
              <Text style={[styles.name, on && styles.nameOn]}>{agent.name}</Text>
            </Pressable>
          );
        })}
      </View>
      <TouchableOpacity
        accessibilityLabel={`Copy ${selected.name} join line`}
        onPress={() => onCopy?.(selected.line)}
        style={styles.lineRow}
      >
        <Text selectable style={styles.line} testID="existing-agent-line">
          {selected.line}
        </Text>
        <Text style={styles.copyLabel}>Copy</Text>
      </TouchableOpacity>
    </View>
  );
}

const TILE = 40;

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    heading: { ...hull.type.body, ...Typography.default('medium'), fontSize: 16, color: hull.textPrimary },
    subheading: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted, marginTop: 3 },
    grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 12, marginTop: 16, marginBottom: 14 },
    cell: { width: '20%', alignItems: 'center', gap: 6 },
    // A brass ring 2pt off the tile marks the chosen logo without moving the grid.
    ring: {
      margin: -3.5,
      padding: 2,
      borderWidth: 1.5,
      borderColor: 'transparent',
      borderRadius: 13.5,
    },
    ringOn: { borderColor: hull.accent },
    tile: {
      width: TILE,
      height: TILE,
      borderRadius: 10,
      overflow: 'hidden',
      alignItems: 'center',
      justifyContent: 'center',
    },
    tileDark: { backgroundColor: '#111111' },
    tileWhite: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: hull.border },
    logoFull: { width: TILE, height: TILE, resizeMode: 'contain' },
    logoInset: { width: TILE * 0.78, height: TILE * 0.78, resizeMode: 'contain' },
    name: { ...Typography.default(), fontSize: 11, lineHeight: 14, color: hull.textMuted },
    nameOn: { ...Typography.default('medium'), color: hull.textPrimary },
    lineRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      padding: 12,
      borderWidth: 1,
      borderColor: hull.border,
      borderRadius: hull.radius,
    },
    line: { ...Typography.mono(), fontSize: 12, lineHeight: 17, color: hull.textPrimary, flex: 1 },
    copyLabel: { ...Typography.default(), ...hull.type.meta, color: hull.accent },
  };
});
