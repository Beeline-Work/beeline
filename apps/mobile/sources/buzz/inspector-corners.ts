export function inspectorCornerObjective(
  title: string,
  about: string | undefined,
): string | undefined {
  const objective = about?.replace(/\s+/g, ' ').trim();
  if (!objective) return undefined;
  const normalizedTitle = title.replace(/\s+/g, ' ').trim();
  if (
    normalizedTitle &&
    objective.localeCompare(normalizedTitle, undefined, { sensitivity: 'accent' }) === 0
  ) {
    return undefined;
  }
  return objective;
}
