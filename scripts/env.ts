/** Prefer Beeline names while retaining existing operator configuration. */
export function readEnv(env: NodeJS.ProcessEnv, suffix: string): string | undefined {
  return env[`BEELINE_${suffix}`] ?? env[`BUZZY_${suffix}`];
}
