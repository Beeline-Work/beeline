/** Process-wide per-repository serialization for irreversible target-ref mutations. */
const repositoryTails = new Map<string, Promise<void>>();

export async function serializeRepoLanding<T>(repo: string, land: () => Promise<T>): Promise<T> {
  const key = repo.trim().toLowerCase();
  const previous = repositoryTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  repositoryTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await land();
  } finally {
    release();
    if (repositoryTails.get(key) === tail) repositoryTails.delete(key);
  }
}
