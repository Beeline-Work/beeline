/** Keep the already minted link available even when platform sharing fails. */
export async function sharePersonInvite(
  url: string,
  share: ((content: { message: string }) => Promise<unknown>) | undefined,
  showFallback: (url: string) => void,
): Promise<void> {
  if (share) {
    try {
      await share({ message: url });
      return;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
    }
  }
  showFallback(url);
}
