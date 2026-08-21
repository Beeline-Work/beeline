export const GITHUB_CONFIG_KEYS = [
  'BEELINE_GITHUB_CLIENT_ID',
  'BEELINE_GITHUB_CLIENT_SECRET',
  'BEELINE_GITHUB_APP_ID',
  'BEELINE_GITHUB_APP_SLUG',
  'BEELINE_GITHUB_APP_PRIVATE_KEY',
  'BEELINE_GITHUB_WEBHOOK_SECRET',
] as const;

export type GitHubEnvironmentConfig = Record<(typeof GITHUB_CONFIG_KEYS)[number], string>;

/** Complete-or-dark: a partial GitHub configuration never exposes the flow. */
export function githubEnvironmentConfig(
  env: NodeJS.ProcessEnv,
): GitHubEnvironmentConfig | undefined {
  const values = Object.fromEntries(
    GITHUB_CONFIG_KEYS.map((key) => [key, env[key]?.trim() ?? '']),
  ) as GitHubEnvironmentConfig;
  return GITHUB_CONFIG_KEYS.every((key) => values[key]) ? values : undefined;
}
