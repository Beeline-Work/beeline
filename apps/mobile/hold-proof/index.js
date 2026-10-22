import React, { useState } from 'react';
import { registerRootComponent } from 'expo';
import { View, Text, Pressable, StatusBar } from 'react-native';
import { useFonts } from 'expo-font';
import { CornerHeaderAgentText } from '../sources/components/buzz/HeaderLadder';
import {
  createTranscriptScrollController,
  requestMessageJump,
} from '../sources/buzz/transcript-scroll-controller';
import { beelineThemes } from '../sources/buzz/groknight';
const viewer = 'owner';
function Proof() {
  const [before, setBefore] = useState(true),
    [jump, setJump] = useState('No message reached');
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  const controller = createTranscriptScrollController({
    rows: () => [{ id: 'approval-message' }],
    rowIndex: (destination, rows) => rows.findIndex((row) => row.id === destination.messageId),
    list: () => ({
      toNewest() {},
      toOffset() {},
      toEstimatedRow() {},
      shiftBy() {},
      toRow: () => {
        setJump('Approval message reached');
        return true;
      },
    }),
    schedule: (callback) => callback(),
  });
  const jumpTo = (id) =>
    requestMessageJump(controller, id, () =>
      setJump(
        id === 'hold-uuid'
          ? 'Jump requested for hold UUID; no message reached'
          : 'Approval message reached',
      ),
    );
  const t = beelineThemes.obsidian;
  if (!loaded) return null;
  return (
    <View style={{ flex: 1, backgroundColor: t.bgTerminal, padding: 16, paddingTop: 64, gap: 24 }}>
      <StatusBar barStyle="light-content" />
      <Text style={{ color: t.textPrimary, ...t.type.body }}>settings-tabs-build</Text>
      <CornerHeaderAgentText
        name="Ruby"
        state="waiting"
        waitingReason="approve"
        viewerId={viewer}
        blocker={
          before ? undefined : { kind: 'merge-hold', personId: viewer, personName: 'Lunchbox' }
        }
        onReasonPress={() => jumpTo('hold-uuid')}
      />
      <Text style={{ color: t.textSecondary, ...t.type.meta }}>{jump}</Text>
      <Pressable
        onPress={() => {
          setBefore(!before);
          setJump('No message reached');
        }}
      >
        <Text style={{ color: t.accent, ...t.type.body }}>
          {before ? 'Show fixed projection' : 'Show original projection'}
        </Text>
      </Pressable>
      {!before && (
        <>
          <CornerHeaderAgentText
            name="Ruby"
            state="waiting"
            blocker={{ kind: 'merge-hold', personId: 'other', personName: 'Candy' }}
            viewerId={viewer}
          />
          <CornerHeaderAgentText name="Ruby" state="waiting" blocker={{ kind: 'report' }} />
          <CornerHeaderAgentText
            name="Ruby"
            state="waiting"
            waitingReason="approve"
            blocker={{ kind: 'message' }}
            onReasonPress={() => jumpTo('approval-message')}
          />
        </>
      )}
    </View>
  );
}
registerRootComponent(Proof);
