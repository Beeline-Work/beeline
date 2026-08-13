export const CHAT_BOTTOM_FOLLOW_THRESHOLD = 96;

export type ChatScrollMetrics = {
  contentHeight: number;
  viewportHeight: number;
  offsetY: number;
};

export function isNearChatBottom(
  { contentHeight, viewportHeight, offsetY }: ChatScrollMetrics,
  threshold = CHAT_BOTTOM_FOLLOW_THRESHOLD,
): boolean {
  if (contentHeight <= viewportHeight) return true;
  return contentHeight - viewportHeight - offsetY <= threshold;
}
