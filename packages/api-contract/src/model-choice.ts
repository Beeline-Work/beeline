/** One picker choice as a helper advertises it. */
export type ModelChoice = {
  readonly id: string;
  readonly name?: string;
  /** The harness's own note on the choice. For an alias it names the model it runs. */
  readonly description?: string;
};

type ModelChoiceAxis = { readonly options: readonly ModelChoice[] };

const ALIAS_NAME = /^default\b/i;

/**
 * An alias choice stands for whatever model the harness picks (Claude's
 * `default`, menu text "Default (recommended)"). Its menu text is not a model
 * name, so it must never be shown as one.
 */
export function isModelAliasChoice(choice: Pick<ModelChoice, 'id' | 'name'>): boolean {
  return ALIAS_NAME.test(choice.id.trim()) || ALIAS_NAME.test(choice.name?.trim() ?? '');
}

/**
 * The model an alias runs, read from its description ("Opus" or
 * "Opus 5.5 · Best for everyday tasks"). A bare family name takes the
 * newest matching concrete choice's name, so "Opus" reads "Opus 5.5".
 */
function aliasModelName(axis: ModelChoiceAxis, alias: ModelChoice): string | undefined {
  const described = alias.description?.split('·')[0]?.trim();
  if (!described || ALIAS_NAME.test(described)) return undefined;
  const wanted = described.toLowerCase();
  const concrete = axis.options.filter((choice) => !isModelAliasChoice(choice));
  const exact = concrete.find(
    (choice) => choice.id.toLowerCase() === wanted || choice.name?.trim().toLowerCase() === wanted,
  );
  const family = concrete.find((choice) =>
    choice.name?.trim().toLowerCase().startsWith(`${wanted} `),
  );
  const match = exact ?? family;
  return match ? match.name?.trim() || match.id : described;
}

/**
 * The model name to show for the choice `id` on a model axis. An alias
 * resolves to the model it runs; when that is unknown the result is
 * `undefined`, never the alias's own menu text.
 */
export function modelChoiceLabel(
  axis: ModelChoiceAxis | undefined,
  id: string | null | undefined,
): string | undefined {
  if (!id) return undefined;
  const choice = axis?.options.find((candidate) => candidate.id === id);
  if (!choice) return isModelAliasChoice({ id }) ? undefined : id;
  if (axis && isModelAliasChoice(choice)) return aliasModelName(axis, choice);
  return choice.name?.trim() || choice.id;
}

/** A picker row: an alias reads "Default · Opus 5.5"; any other choice its own name. */
export function modelPickerChoiceLabel(axis: ModelChoiceAxis, choice: ModelChoice): string {
  if (!isModelAliasChoice(choice)) return choice.name?.trim() || choice.id;
  const model = aliasModelName(axis, choice);
  return model ? `Default · ${model}` : 'Default';
}
