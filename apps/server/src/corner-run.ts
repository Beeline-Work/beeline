/** Read-only compatibility names. The machine owns the only persisted state. */
export function cornerRunStateSql(cornerId: string): string {
  return `(SELECT machine->>'state' FROM corner_facts WHERE corner_id=${cornerId})`;
}
export function cornerRunOutcomeSql(cornerId: string): string {
  return `(SELECT machine->>'outcome' FROM corner_facts WHERE corner_id=${cornerId})`;
}
