import React from 'react';
import { View, Text, Pressable, Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Command } from './types';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';

interface CommandPaletteItemProps {
  command: Command;
  isSelected: boolean;
  onPress: () => void;
  onHover?: () => void;
}

export function CommandPaletteItem({
  command,
  isSelected,
  onPress,
  onHover,
}: CommandPaletteItemProps) {
  const [isHovered, setIsHovered] = React.useState(false);
  const { theme } = useUnistyles();

  const handleMouseEnter = React.useCallback(() => {
    if (Platform.OS === 'web') {
      setIsHovered(true);
      onHover?.();
    }
  }, [onHover]);

  const handleMouseLeave = React.useCallback(() => {
    if (Platform.OS === 'web') {
      setIsHovered(false);
    }
  }, []);

  const pressableProps: any = {
    style: ({ pressed }: any) => [
      styles.container,
      isSelected && styles.selected,
      isHovered && !isSelected && styles.hovered,
      pressed && Platform.OS === 'web' && styles.pressed,
    ],
    onPress,
  };

  // Add mouse events only on web
  if (Platform.OS === 'web') {
    pressableProps.onMouseEnter = handleMouseEnter;
    pressableProps.onMouseLeave = handleMouseLeave;
  }

  return (
    <Pressable {...pressableProps}>
      <View style={styles.content}>
        {command.icon && (
          <View style={styles.iconContainer}>
            <Ionicons
              name={command.icon as any}
              size={20}
              color={isSelected ? theme.buzz.accent : theme.buzz.textSecondary}
            />
          </View>
        )}
        <View style={styles.textContainer}>
          <Text style={[styles.title, Typography.default()]}>{command.title}</Text>
          {command.subtitle && (
            <Text style={[styles.subtitle, Typography.default()]}>{command.subtitle}</Text>
          )}
        </View>
        {command.shortcut && (
          <View style={styles.shortcutContainer}>
            <Text style={[styles.shortcut, Typography.mono()]}>{command.shortcut}</Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    backgroundColor: 'transparent',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
  },
  selected: {
    backgroundColor: theme.buzz.bgPressed,
  },
  pressed: {
    backgroundColor: theme.buzz.bgPressed,
  },
  hovered: {
    backgroundColor: theme.buzz.bgPressed,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  iconContainer: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  textContainer: {
    flex: 1,
    marginRight: 12,
  },
  title: {
    fontSize: 15,
    color: theme.buzz.textPrimary,
    marginBottom: 2,
    letterSpacing: -0.2,
  },
  subtitle: {
    fontSize: 13,
    color: theme.buzz.textSecondary,
    letterSpacing: -0.1,
  },
  shortcutContainer: {
    paddingLeft: 10,
  },
  shortcut: {
    fontSize: 12,
    color: theme.buzz.textDisabled,
    fontWeight: '500',
  },
}));
