/** Present a model identifier without its provider path. */
export function displayModel(model: string): string {
  return model.slice(model.lastIndexOf('/') + 1);
}
