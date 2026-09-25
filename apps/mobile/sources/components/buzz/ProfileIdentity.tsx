import React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { RoomViewIdentity } from '@beeline/api-contract/phone';
import { IDENTITY_SETTINGS_TILE, workspacePictureSeat } from '@/buzz/workspace-tile';
import { Typography } from '@/constants/Typography';
import { IdentityMark } from './IdentityMark';
const tile = IDENTITY_SETTINGS_TILE;
const seat = workspacePictureSeat(tile);
export function ProfileIdentity({
  identity,
  ownerHandle,
  role,
}: {
  identity: RoomViewIdentity;
  ownerHandle?: string;
  role?: string;
}) {
  return (
    <View style={styles.identity}>
      <View style={styles.tile} testID="profile-avatar-bezel">
        <View style={styles.seat}>
          <IdentityMark
            kind={identity.kind}
            seed={identity.pubkey}
            name={identity.name}
            face={identity.face}
            avatarUrl={identity.avatar}
            size={seat.pictureSize}
          />
        </View>
      </View>
      <Text style={styles.handle} testID="profile-handle">
        {identity.handle ? (
          <>
            <Text style={styles.at}>@</Text>
            {identity.handle}
          </>
        ) : (
          'Handle unavailable'
        )}
      </Text>
      {ownerHandle && (
        <Text style={styles.copy} testID="profile-owner">
          owned by <Text style={styles.at}>@</Text>
          {ownerHandle}
        </Text>
      )}
      {role && (
        <Text style={styles.copy} testID="profile-workspace-role">
          {role}
        </Text>
      )}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  identity: {
    alignItems: 'center',
    gap: theme.buzz.space.md,
    paddingVertical: theme.buzz.space.lg,
  },
  tile: {
    width: tile.size,
    height: tile.size,
    borderRadius: tile.radius,
    borderWidth: tile.borderWidth,
    borderColor: theme.buzz.accent,
    backgroundColor: theme.buzz.bgRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  seat: {
    width: seat.pictureSize,
    height: seat.pictureSize,
    borderRadius: seat.pictureRadius,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  handle: {
    ...Typography.default(),
    ...theme.buzz.type.bodyStrong,
    color: theme.buzz.textPrimary,
    textAlign: 'center',
  },
  at: { color: theme.buzz.accent },
  copy: { ...Typography.default(), ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
}));
