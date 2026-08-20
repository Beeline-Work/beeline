/** Copy the durable turn body exactly as it was committed. */
export async function copyEntireTurn(
  text: string,
  write: (contents: string) => Promise<unknown>,
): Promise<void> {
  await write(text);
}
