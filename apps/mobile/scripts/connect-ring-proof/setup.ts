import { StyleSheet } from 'react-native-unistyles';
import { boneTheme, obsidianTheme, boneSmallTheme, boneLargeTheme, obsidianSmallTheme, obsidianLargeTheme } from '../../sources/theme';
StyleSheet.configure({ themes: { bone: boneTheme, obsidian: obsidianTheme,
  boneSmall: boneSmallTheme, boneLarge: boneLargeTheme,
  obsidianSmall: obsidianSmallTheme, obsidianLarge: obsidianLargeTheme }, settings: { initialTheme: 'bone' } });
