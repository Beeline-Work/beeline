export function shouldCoverMessageSource(input: {
  desktop: boolean;
  abandoned: boolean;
  targetVisible: boolean;
}): boolean {
  return !input.desktop && !input.abandoned && !input.targetVisible;
}

export function shouldReleaseMessageSourceCover(input: {
  abandoned: boolean;
  targetVisible: boolean;
  retryAttempts: number;
}): boolean {
  return input.abandoned || input.targetVisible || input.retryAttempts >= 8;
}
