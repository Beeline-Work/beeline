/** The shared repository artifact is named only by the corner identity. */
export function cornerFeatureBranch(cornerId: string): string {
  return `feature/corner-${cornerId.replaceAll('-', '').toLowerCase().slice(0, 12)}`;
}

/** alias is a trusted SQL room alias, never user input. */
export function cornerFeatureBranchSql(alias: string): string {
  return `('feature/corner-' || left(replace(${alias}.id::text,'-',''),12))`;
}
