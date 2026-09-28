/** A development checkout identifies itself below every published release. */
export function helperVersion(value?: string): string {
  return value && /^v\d+\.\d+\.\d+$/.test(value) ? value : 'v0.0.0';
}

export function helperVersionHeader(value?: string): { 'x-beeline-helper-version': string } {
  return { 'x-beeline-helper-version': helperVersion(value) };
}
