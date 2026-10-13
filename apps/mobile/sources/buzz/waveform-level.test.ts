import { describe, expect, it } from 'vitest';
import { dictationWaveformLevel, smoothWaveformLevel, voiceWaveformLevel, waveformLevelFromDb } from './waveform-level';

describe('waveform volume mapping', () => {
  it.each([
    ['silence', -60, -2, 0, 0, 0.05],
    ['quiet', -40, 2, 0.01, 0.25, 0.4],
    ['normal', -30, 4, 10 ** (-30 / 20), 0.5, 0.7],
    ['loud', -15, 7, 10 ** (-15 / 20), 1, 1],
  ])('%s uses native-range inputs and reaches its display band', (_, db, raw, amplitude, min, max) => {
    for (const level of [waveformLevelFromDb(db), dictationWaveformLevel(raw, 'ios'),
      dictationWaveformLevel(raw, 'android'), voiceWaveformLevel(amplitude)]) {
      expect(level).toBeGreaterThanOrEqual(min);
      expect(level).toBeLessThanOrEqual(max);
    }
  });

  it.each(['android', 'ios'])('normal %s speech stays visible without saturating between syllables', platform => {
    const levels = [3.5, 4, 4.5].map(value => dictationWaveformLevel(value, platform));
    expect(levels[0]).toBeGreaterThan(0.4);
    expect(levels[2]).toBeLessThan(0.8);
    expect(levels[0]).toBeLessThan(levels[1]);
    expect(levels[1]).toBeLessThan(levels[2]);
  });

  it('normal voice speech moves between syllables without flattening or saturation', () => {
    const levels = [-32.5, -30, -27.5].map(db => voiceWaveformLevel(10 ** (db / 20)));
    expect(levels[0]).toBeGreaterThan(0.4);
    expect(levels[2]).toBeLessThan(0.8);
    expect(levels[0]).toBeLessThan(levels[1]);
    expect(levels[1]).toBeLessThan(levels[2]);
  });

  it('uses the same dB curve for iOS dictation and linear voice amplitudes', () => {
    for (const db of [-60, -40, -20, -5]) {
      expect(dictationWaveformLevel((db + 60) / 5 - 2, 'ios')).toBeCloseTo(waveformLevelFromDb(db));
      expect(voiceWaveformLevel(10 ** (db / 20))).toBeCloseTo(waveformLevelFromDb(db));
    }
  });

  it('rejects invalid readings and releases smoothly to silence', () => {
    for (const value of [NaN, Infinity, -Infinity]) expect(waveformLevelFromDb(value)).toBe(0);
    expect(voiceWaveformLevel(0)).toBe(0);
    expect(voiceWaveformLevel(-1)).toBe(0);
    expect(smoothWaveformLevel(0, 1)).toBeCloseTo(0.7);
    expect(smoothWaveformLevel(1, 0)).toBe(0.5);
  });
});
