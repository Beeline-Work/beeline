import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { RoomViewIdentity } from '@beeline/api-contract/phone';
import { IDENTITY_SETTINGS_TILE, workspacePictureSeat } from '@/buzz/workspace-tile';
import { Typography } from '@/constants/Typography';
import { IdentityMark } from './IdentityMark';
const tile = IDENTITY_SETTINGS_TILE;
const seat = workspacePictureSeat(tile);
export const PROFILE_IDENTITY_PICTURE_SIZE = seat.pictureSize;
export function ProfileIdentity({
  identity,
  ownerHandle,
  role,
  avatarFallback,
  avatarAccessibilityLabel = 'Profile picture',
  avatarTestID = 'profile-avatar-bezel',
  hideUnavailableHandle = false,
  handleAccessibilityLabel,
  handleTestID = 'profile-handle',
  identityMarkTestID,
  onAvatarPress,
  onHandlePress,
}: {
  identity: RoomViewIdentity;
  ownerHandle?: string;
  role?: string;
  avatarFallback?: React.ReactNode;
  avatarAccessibilityLabel?: string;
  avatarTestID?: string;
  hideUnavailableHandle?: boolean;
  handleAccessibilityLabel?: string;
  handleTestID?: string;
  identityMarkTestID?: string;
  onAvatarPress?: () => void;
  onHandlePress?: () => void;
}) {
  const portrait = (
    <View style={styles.seat}>
      {avatarFallback ?? (
        <IdentityMark
          kind={identity.kind}
          seed={identity.pubkey}
          name={identity.name}
          face={identity.face}
          avatarUrl={identity.avatar}
          size={seat.pictureSize}
          testID={identityMarkTestID}
        />
      )}
    </View>
  );
  const handle = identity.handle ? (
    <Text style={styles.handle} testID={onHandlePress ? undefined : handleTestID}>
      <Text style={styles.at}>@</Text>
      <Text style={styles.handle}>{identity.handle}</Text>
    </Text>
  ) : hideUnavailableHandle ? null : (
    <Text style={styles.handle} testID={handleTestID}>
      Handle unavailable
    </Text>
  );
  return (
    <View style={styles.identity}>
      {onAvatarPress ? (
        <TouchableOpacity
          accessibilityLabel={avatarAccessibilityLabel}
          accessibilityRole="button"
          onPress={onAvatarPress}
          style={styles.tile}
          testID={avatarTestID}
        >
          {portrait}
        </TouchableOpacity>
      ) : (
        <View style={styles.tile} testID={avatarTestID}>
          {portrait}
        </View>
      )}
      {onHandlePress && handle ? (
        <TouchableOpacity
          accessibilityLabel={handleAccessibilityLabel ?? `@${identity.handle}`}
          accessibilityRole="link"
          onPress={onHandlePress}
          testID={handleTestID}
        >
          {handle}
        </TouchableOpacity>
      ) : (
        handle
      )}
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
