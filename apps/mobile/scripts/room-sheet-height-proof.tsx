import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { HullActionSheet, HullActionSheetRow } from '../sources/components/buzz/HullActionSheet';
// @ts-expect-error Source-derived module supplied by the browser test.
import { SchedulesSection } from 'room-sheet-section';

createRoot(document.getElementById('root')!).render(
  <View style={{ width: 390 }}>
    <HullActionSheet title="#experiments">
    <HullActionSheetRow label="Repository" metadata="beeline" chevron="right" testID="repository" />
    <HullActionSheetRow label="Reviewer" metadata="None" chevron="right" testID="reviewer" />
    <HullActionSheetRow label="Mute notifications" description="Silences this Room and its corners. Tags, replies and DMs still reach you." toggle={{ value: false, onValueChange: () => {} }} testID="mute" />
    <HullActionSheetRow label="Members" metadata="21 members" chevron="right" testID="members" />
    <SchedulesSection />
    <HullActionSheetRow label="Delete Room" destructive testID="delete" />
    <HullActionSheetRow label="Leave Room" destructive testID="leave" />
    </HullActionSheet>
    <View style={{ position: 'absolute', top: 1000, width: 390 }}>
      <HullActionSheetRow label="Close corner" destructive testID="close-corner" />
    </View>
  </View>,
);

setTimeout(() => {
  const rect = (id: string) => document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
  const schedules = rect('room-schedules-action');
  document.getElementById('result')!.textContent = JSON.stringify({
    heights: ['repository', 'reviewer', 'members', 'room-schedules-action', 'close-corner'].map(id => rect(id).height),
    schedulesFootprint: rect('delete').top - schedules.top,
    gapAfterSchedules: rect('delete').top - schedules.bottom,
    muteHeight: rect('mute').height,
    chevron: document.querySelector('[data-testid="room-schedules-action"] svg') !== null,
  });
}, 500);
