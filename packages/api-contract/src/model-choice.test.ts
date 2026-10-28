import { describe, expect, it } from 'vitest';
import { isModelAliasChoice, modelChoiceLabel, modelPickerChoiceLabel } from './model-choice.js';

// Captured from claude-agent-acp 0.97.0 session/new (2026-10-27): the `default`
// alias names its model only in the description, and only by family.
const CLAUDE = {
  options: [
    { id: 'default', name: 'Default (recommended)', description: 'Opus' },
    { id: 'opus', name: 'Opus 5.5', description: 'Opus 5.5 · Best for everyday, complex tasks' },
    { id: 'claude-fable-5-1[1m]', name: 'Fable 5.1', description: 'Fable 5.1 · Most capable' },
    { id: 'sonnet', name: 'Sonnet 5.5', description: 'Sonnet 5.5 · Efficient for routine tasks' },
    { id: 'haiku', name: 'Haiku 5.5', description: 'Haiku 5.5 · Fastest for quick answers' },
  ],
};

describe('modelChoiceLabel', () => {
  it('resolves the default alias to the model it runs', () => {
    expect(modelChoiceLabel(CLAUDE, 'default')).toBe('Opus 5.5');
  });

  it('reads a described model name before the note', () => {
    const axis = { options: [{ id: 'default', name: 'Default (recommended)', description: 'Sonnet 5.5 · Efficient' }] };
    expect(modelChoiceLabel(axis, 'default')).toBe('Sonnet 5.5');
  });

  it('matches a described model id to its concrete choice', () => {
    const axis = {
      options: [
        { id: 'default', name: 'Default (recommended)', description: 'claude-opus-5-5' },
        { id: 'claude-opus-5-5', name: 'Opus 5.5' },
      ],
    };
    expect(modelChoiceLabel(axis, 'default')).toBe('Opus 5.5');
  });

  it('shows nothing, never the alias text, when the model is unknown', () => {
    const stored = { options: [{ id: 'default', name: 'Default (recommended)' }, { id: 'opus', name: 'Opus 5.5' }] };
    expect(modelChoiceLabel(stored, 'default')).toBeUndefined();
    expect(modelChoiceLabel({ options: [] }, 'default')).toBeUndefined();
    expect(modelChoiceLabel(undefined, 'default')).toBeUndefined();
    expect(modelChoiceLabel({}, 'default')).toBeUndefined();
    expect(modelChoiceLabel({}, 'gpt-5.6-codex')).toBe('gpt-5.6-codex');
    const selfDescribed = { options: [{ id: 'default', name: 'Default', description: 'Default (recommended)' }] };
    expect(modelChoiceLabel(selfDescribed, 'default')).toBeUndefined();
  });

  it('keeps every concrete choice name and a vanished concrete id', () => {
    expect(modelChoiceLabel(CLAUDE, 'sonnet')).toBe('Sonnet 5.5');
    expect(modelChoiceLabel({ options: [{ id: 'gpt-5.5' }] }, 'gpt-5.5')).toBe('gpt-5.5');
    expect(modelChoiceLabel(CLAUDE, 'opus[1m]')).toBe('opus[1m]');
    expect(modelChoiceLabel(CLAUDE, undefined)).toBeUndefined();
  });
});

describe('modelPickerChoiceLabel', () => {
  it('reads "Default · Opus 5.5" for the alias and the name for the rest', () => {
    expect(CLAUDE.options.map((choice) => modelPickerChoiceLabel(CLAUDE, choice))).toEqual([
      'Default · Opus 5.5',
      'Opus 5.5',
      'Fable 5.1',
      'Sonnet 5.5',
      'Haiku 5.5',
    ]);
  });

  it('reads plain "Default" when the alias model is unknown', () => {
    const stored = { options: [{ id: 'default', name: 'Default (recommended)' }] };
    expect(modelPickerChoiceLabel(stored, stored.options[0]!)).toBe('Default');
  });
});

describe('isModelAliasChoice', () => {
  it('knows the alias by id or menu text', () => {
    expect(isModelAliasChoice({ id: 'default' })).toBe(true);
    expect(isModelAliasChoice({ id: 'auto', name: 'Default model' })).toBe(true);
    expect(isModelAliasChoice({ id: 'model-default-fast', name: 'Fast' })).toBe(false);
    expect(isModelAliasChoice({ id: 'opus', name: 'Opus 5.5' })).toBe(false);
  });
});
