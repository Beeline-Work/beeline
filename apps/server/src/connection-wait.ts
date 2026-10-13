/** Helper work is announced only after commit; keep its transaction out of this wait. */
export async function waitForConnection<T>(read: () => Promise<T | undefined>, timeoutMs = 85_000): Promise<T | undefined> {
  const until = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < until);
  return undefined;
}
