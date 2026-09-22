export async function readFileBytes(uri: string): Promise<Uint8Array> {
  if (uri.startsWith('blob:') || uri.startsWith('data:')) {
    const response = await fetch(uri);
    if (!response.ok) {
      throw new Error(`readFileBytes: fetch failed with status ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  const { File } = await import('expo-file-system');
  return new File(uri).bytes();
}
