/** Prefer Beeline names while retaining existing operator configuration. */
export function readEnv(env: NodeJS.ProcessEnv, suffix: string): string | undefined {
  return env[`BEELINE_${suffix}`] ?? env[`BUZZY_${suffix}`];
}

/** Export both spellings for helpers that update independently. */
export function envPair(suffix: string, value: string): Record<string, string> {
  return { [`BEELINE_${suffix}`]: value, [`BUZZY_${suffix}`]: value };
}
