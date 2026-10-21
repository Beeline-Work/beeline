import { captureGooglePreviewUrl } from '@/auth/google-preview';

export async function redirectSystemPath({ path }: { path: string; initial: boolean }): Promise<string> {
  const captured = captureGooglePreviewUrl(path);
  await captured.saved.catch(() => undefined);
  return captured.url;
}
