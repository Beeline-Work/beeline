import React from 'react';
import { Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HullFloatingSurface } from '@/components/buzz/HullDialog';
import { CommandPaletteInput } from './CommandPaletteInput';
import { CommandPaletteResults } from './CommandPaletteResults';
import { useCommandPalette } from './useCommandPalette';
import { Command } from './types';

interface CommandPaletteProps {
  commands: Command[];
  onClose: () => void;
}

export function CommandPalette({ commands, onClose }: CommandPaletteProps) {
  const {
    searchQuery,
    selectedIndex,
    filteredCategories,
    inputRef,
    handleSearchChange,
    handleSelectCommand,
    handleKeyPress,
    setSelectedIndex,
  } = useCommandPalette(commands, onClose);

  // Only render on web
  if (Platform.OS !== 'web') {
    return null;
  }

  return (
    <HullFloatingSurface style={styles.container} testID="command-palette-surface">
      <CommandPaletteInput
        value={searchQuery}
        onChangeText={handleSearchChange}
        onKeyPress={handleKeyPress}
        inputRef={inputRef}
      />
      <CommandPaletteResults
        categories={filteredCategories}
        selectedIndex={selectedIndex}
        onSelectCommand={handleSelectCommand}
        onSelectionChange={setSelectedIndex}
      />
    </HullFloatingSurface>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    width: '100%',
    maxWidth: 800, // Increased from 640 for wider input
    // Use viewport-based height for better layout
    ...(Platform.OS === 'web'
      ? ({
          maxHeight: '60vh', // Takes up to 60% of viewport height
        } as any)
      : {
          maxHeight: 500, // Fallback for native
        }),
    overflow: 'hidden',
  },
}));
