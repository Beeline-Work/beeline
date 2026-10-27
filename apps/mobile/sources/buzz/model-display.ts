/** Present a concrete model name without its provider path or harness placeholder. */
export function displayModel(model: string): string {
  const name = model.slice(model.lastIndexOf('/') + 1);
  return /^default/i.test(name.trimStart()) ? '' : name;
}
