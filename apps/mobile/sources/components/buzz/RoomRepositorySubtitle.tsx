import React from 'react';
import { TouchableOpacity } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HeaderMetaCaps } from '@/components/buzz/HeaderLadder';

export function githubRepositoryUrl(repositoryName: string): string {
  return `https://github.com/${repositoryName.trim()}`;
}

/** The Room header's repository fact is a link, independent of Room settings. */
export function RoomRepositorySubtitle({
  repositoryName,
  onOpenUrl,
}: {
  repositoryName: string | null;
  onOpenUrl: (url: string) => void;
}) {
  const name = repositoryName?.trim();
  if (!name) return null;

  return (
    <TouchableOpacity
      accessibilityLabel={`Open GitHub repository ${name}`}
      accessibilityRole="link"
      hitSlop={{ top: 6, bottom: 3, left: 12, right: 12 }}
      onPress={() => onOpenUrl(githubRepositoryUrl(name))}
      style={styles.subtitle}
      testID="room-repo-chip"
    >
      <HeaderMetaCaps testID="room-repo-chip-text">{name}</HeaderMetaCaps>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  subtitle: { alignSelf: 'flex-start', marginTop: 2, maxWidth: '100%' },
});
