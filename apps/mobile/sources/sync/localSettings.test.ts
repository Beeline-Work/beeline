import { describe, expect, it } from 'vitest';
import { applyLocalSettings, localSettingsDefaults, localSettingsParse } from './localSettings';

describe('local settings', () => {
  it('defaults UI size to the existing medium presentation', () => {
    expect(localSettingsDefaults.uiSize).toBe('medium');
    expect(localSettingsParse({ appearance: 'light' }).uiSize).toBe('medium');
  });

  it('retains a valid UI size and rejects an invalid one atomically', () => {
    expect(localSettingsParse({ uiSize: 'large' }).uiSize).toBe('large');
    expect(localSettingsParse({ uiSize: 'huge' })).toEqual(localSettingsDefaults);
  });

  it('defaults the room-open trace overlay off on every device', () => {
    expect(localSettingsDefaults.roomOpenTraceOverlay).toBe(false);
    expect(localSettingsParse({}).roomOpenTraceOverlay).toBe(false);
    expect(localSettingsParse({ roomOpenTraceOverlay: true }).roomOpenTraceOverlay).toBe(true);
  });

  it('applies a local UI size update without changing appearance', () => {
    expect(applyLocalSettings({ ...localSettingsDefaults }, { uiSize: 'small' })).toEqual({
      ...localSettingsDefaults,
      uiSize: 'small',
    });
  });
});
