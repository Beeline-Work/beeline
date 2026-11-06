/** These refusals require an adapter upgrade, sign-in, or configuration change. */
export function isStandingRuntimeFault(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /\bACP error -(?:32600|32601|32602)\b|\bACP error -32000: Authentication required|command protocol|refusing intake/i.test(text);
}

