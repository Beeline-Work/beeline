import { describe, expect, it } from 'vitest';
import readings from '../../evidence/android-dictation-rms/readings.json';
import { dictationWaveformLevel, voiceWaveformLevel, waveformLevelFromDb } from './waveform-level';

describe('waveform volume mapping', () => {
  it.each([
    ['silence', -60, -2, 0, 0, 0.05],
    ['quiet', -40, 2, 0.01, 0.25, 0.4],
    ['normal', -30, 4, 10 ** (-30 / 20), 0.5, 0.7],
    ['loud', -15, 7, 10 ** (-15 / 20), 1, 1],
  ])('%s uses native-range inputs and reaches its display band', (_, db, raw, amplitude, min, max) => {
    for (const level of [waveformLevelFromDb(db), dictationWaveformLevel(raw, 'ios'),
      voiceWaveformLevel(amplitude)]) {
      expect(level).toBeGreaterThanOrEqual(min);
      expect(level).toBeLessThanOrEqual(max);
    }
  });

  it.each(['ios'])('normal %s speech stays visible without saturating between syllables', platform => {
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

  it('rejects invalid readings', () => {
    for (const value of [NaN, Infinity, -Infinity]) expect(waveformLevelFromDb(value)).toBe(0);
    expect(voiceWaveformLevel(0)).toBe(0);
    expect(voiceWaveformLevel(-1)).toBe(0);
  });
});

// R1: actual Google recognizer callbacks, sampled at the composer's 120 ms cadence.
// The native engine can already report 10 for normal syllables; keep display headroom.
describe('R1 Android Google recognizer readings', () => {
  const phases = ['soft', 'normal', 'loud'] as const;
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };

  it('keeps every recorded normal syllable below full height, with visible contrast', () => {
    const levels = readings.normal.samples.map(value => dictationWaveformLevel(value, 'android'));
    expect(Math.max(...levels)).toBeLessThan(0.9);
    expect(median(levels)).toBeGreaterThan(0.4);
    expect(new Set(levels.filter(value => value > 0)).size).toBeGreaterThan(10);
  });

  it('shows louder speech taller than softer speech without hiding soft speech', () => {
    const medians = phases.map(phase => median(readings[phase].samples
      .filter(value => value > 0).map(value => dictationWaveformLevel(value, 'android'))));
    expect(medians[0]).toBeGreaterThan(0.2);
    expect(medians[0]).toBeLessThan(medians[1]);
    expect(medians[1]).toBeLessThan(medians[2]);
  });

  it('returns to silence dots after every measured take and rejects invalid readings', () => {
    for (const phase of phases) {
      expect(dictationWaveformLevel(readings[phase].finalValue, 'android')).toBe(0);
    }
    for (const value of [-2, -1, 0, NaN, Infinity, -Infinity]) {
      expect(dictationWaveformLevel(value, 'android')).toBe(0);
    }
  });
});
