import { useEffect } from 'react';
import type { VoicePreviewPlayer as NativeVoicePreviewPlayer } from './VoicePreviewPlayer.native';
/** The browser uses its audio element; native uses the existing WebView audio host. */
export function VoicePreviewPlayer({
  source,
  onEnd,
  onError,
}: Parameters<typeof NativeVoicePreviewPlayer>[0]) {
  useEffect(() => {
    const audio = new Audio(source);
    audio.onended = onEnd;
    audio.onerror = onError;
    void audio.play().catch(onError);
    return () => {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.src = '';
    };
  }, [source]);
  return null;
}
