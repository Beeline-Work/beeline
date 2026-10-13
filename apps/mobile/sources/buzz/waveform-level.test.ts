import { describe, expect, it } from 'vitest';
import { dictationWaveformLevel, smoothWaveformLevel, voiceWaveformLevel, waveformLevelFromDb } from './waveform-level';

describe('waveform volume mapping', () => {
  it('keeps silence and room noise flat, then distinguishes quiet, normal and loud speech', () => {
    const levels = [-80, -55, -40, -20, -5].map(waveformLevelFromDb);
    expect(levels.slice(0, 2)).toEqual([0, 0]);
    expect(levels[2]).toBeGreaterThan(0);
    expect(levels[2]).toBeLessThan(0.2);
    expect(levels[3]).toBeGreaterThan(0.5);
    expect(levels[3]).toBeLessThan(0.7);
    expect(levels[4]).toBe(1);
  });

  it('uses the same dB curve for iOS dictation and linear voice amplitudes', () => {
    for (const db of [-60, -40, -20, -5]) {
      expect(dictationWaveformLevel((db + 60) / 5 - 2, 'ios')).toBeCloseTo(waveformLevelFromDb(db));
      expect(voiceWaveformLevel(10 ** (db / 20))).toBeCloseTo(waveformLevelFromDb(db));
    }
  });

  it('Reproduction WL1: Android values above 10 retain distinct heights', () => {
    const raw = [-2, 12, 20, 30];
    const levels = raw.map(value => dictationWaveformLevel(value, 'android'));
    console.info('Reproduction WL1 injected Android RMS dB:', raw.map((value, index) => ({
      raw: value, oldHeight: 2 + Math.max(0, Math.min(1, (value + 2) / 12)) * 16,
      height: 2 + levels[index] * 16,
    })));
    expect(levels[0]).toBe(0);
    expect(levels[1]).toBeGreaterThan(0);
    expect(levels[1]).toBeLessThan(levels[2]);
    expect(levels[2]).toBeLessThan(1);
    expect(levels[3]).toBe(1);
  });

  it('rejects invalid readings and releases smoothly to silence', () => {
    for (const value of [NaN, Infinity, -Infinity]) expect(waveformLevelFromDb(value)).toBe(0);
    expect(voiceWaveformLevel(0)).toBe(0);
    expect(voiceWaveformLevel(-1)).toBe(0);
    expect(smoothWaveformLevel(0, 1)).toBeCloseTo(0.7);
    expect(smoothWaveformLevel(1, 0)).toBe(0.5);
  });
});
