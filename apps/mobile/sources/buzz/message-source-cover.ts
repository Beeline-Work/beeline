export function shouldCoverMessageSource(input: { desktop: boolean; abandoned: boolean }): boolean {
  return !input.desktop && !input.abandoned;
}

export function shouldReleaseMessageSourceCover(input: {
  abandoned: boolean;
  retryAttempts: number;
}): boolean {
  return input.abandoned || input.retryAttempts >= 8;
}
