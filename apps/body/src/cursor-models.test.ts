import { describe, expect, it, vi } from 'vitest';

const { enumerateCursorModels } = vi.hoisted(() => ({ enumerateCursorModels: vi.fn() }));

vi.mock('./cursor-models.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./cursor-models.js')>()),
  enumerateCursorModels: (...args: unknown[]) => enumerateCursorModels(...args),
}));

vi.mock('./model-catalog.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./model-catalog.js')>()),
  fetchAgentModelCatalog: vi.fn().mockResolvedValue({ catalog: [], raw: [] }),
}));

const { loadConnectModelCatalog } = await import('./connect-command.js');
const { parseCursorModelsOutput } = await import('./cursor-models.js');

describe('parseCursorModelsOutput', () => {
  it('parses cursor-agent models lines and anchors the default on auto', () => {
    const output = [
      'Available models',
      '',
      'auto - Auto (current, default)',
      'gpt-5.3-codex - GPT-5.3',
      'composer-2.5 - Composer 2.5',
      '',
    ].join('\n');
    expect(parseCursorModelsOutput(output)).toEqual({
      currentValue: 'auto',
      options: [
        { id: 'auto', name: 'Auto' },
        { id: 'gpt-5.3-codex', name: 'GPT-5.3' },
        { id: 'composer-2.5', name: 'Composer 2.5' },
      ],
    });
  });

  it('keeps the NO ZDR suffix and fast variants as part of the label', () => {
    const output = 'claude-fable-5-thinking-high - Claude Fable 5 1M Thinking (NO ZDR)\n';
    expect(parseCursorModelsOutput(output)?.options).toEqual([
      { id: 'claude-fable-5-thinking-high', name: 'Claude Fable 5 1M Thinking (NO ZDR)' },
    ]);
  });

  it('falls back to the first listed model when auto is absent', () => {
    expect(parseCursorModelsOutput('gpt-5.2 - GPT-5.2\n')).toEqual({
      currentValue: 'gpt-5.2',
      options: [{ id: 'gpt-5.2', name: 'GPT-5.2' }],
    });
  });

  it('returns undefined for unparseable output', () => {
    expect(parseCursorModelsOutput('not signed in\n')).toBeUndefined();
    expect(parseCursorModelsOutput('')).toBeUndefined();
  });
});

describe('loadConnectModelCatalog — cursor with no advertised model axis', () => {
  it('enumerates real models from the cursor-agent CLI when ACP advertises none', async () => {
    // cursor-agent-acp's session/new exposes no configOptions, so the ACP
    // catalog is empty; the wizard must offer what `cursor-agent models`
    // prints rather than a single invented default.
    enumerateCursorModels.mockResolvedValue({
      currentValue: 'auto',
      options: [{ id: 'auto', name: 'Auto' }, { id: 'composer-2.5', name: 'Composer 2.5' }],
    });
    const catalog = await loadConnectModelCatalog({ harness: 'cursor' });
    expect(catalog.currentValue).toBe('auto');
    expect(catalog.options.map((option) => option.id)).toEqual(['auto', 'composer-2.5']);
    expect(catalog.note).toBeUndefined();
  });

  it('keeps the fallback picker when the CLI read fails', async () => {
    enumerateCursorModels.mockResolvedValue(undefined);
    const catalog = await loadConnectModelCatalog({ harness: 'cursor' });
    expect(catalog.currentValue).toBe('auto');
    expect(catalog.options).toEqual([{ id: 'auto' }]);
    expect(catalog.note).toContain('did not enumerate models');
  });

  it('does not consult the CLI for harnesses whose ACP axes are simply empty', async () => {
    enumerateCursorModels.mockClear();
    enumerateCursorModels.mockResolvedValue(undefined);
    const catalog = await loadConnectModelCatalog({ harness: 'goose' });
    expect(catalog.note).toContain('did not enumerate models');
    expect(enumerateCursorModels).not.toHaveBeenCalled();
  });
});
