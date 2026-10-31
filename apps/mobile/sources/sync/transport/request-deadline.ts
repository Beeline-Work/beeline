let handler: (() => void) | undefined;

export function setRequestDeadlineHandler(next: (() => void) | undefined): void {
  handler = next;
}

export function reportRequestDeadlineMissed(): void {
  handler?.();
}
