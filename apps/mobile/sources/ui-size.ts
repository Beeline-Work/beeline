import type { LocalSettings } from './sync/localSettings';

export type AppUiSize = LocalSettings['uiSize'];

export const APP_UI_SIZE_OPTIONS: readonly AppUiSize[] = ['small', 'medium', 'large'];

export const APP_UI_SIZE_LABELS: Readonly<Record<AppUiSize, string>> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
};

export const APP_UI_SIZE_SCALE: Readonly<Record<AppUiSize, number>> = {
  small: 0.86,
  medium: 1,
  large: 1.2,
};
