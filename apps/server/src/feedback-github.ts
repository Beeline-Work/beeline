import { GitHubHttpError, type GitHubAppClient } from '@beeline/auth/github';
import type { SqlDatabase } from './database.js';
import type { FeedbackPullRequests } from './feedback.js';

/**
 * The one GitHub read the feedback loop makes: whether a fix pull request in
 * the configured repository merged, with an installation token downgraded to
 * `pull_requests: read` on that repository. The repository must already be in
 * the Beeline GitHub App's installed catalog.
 */
export class FeedbackGitHub implements FeedbackPullRequests {
  constructor(
    private readonly database: SqlDatabase,
    private readonly app: GitHubAppClient,
  ) {}

  async merged(repository: string, number: number): Promise<boolean> {
    const installed = (
      await this.database.query<{ installation_id: string; repository_id: string; full_name: string }>(
        `SELECT installation_id,repository_id,full_name FROM github_repositories
         WHERE lower(full_name)=lower($1) AND active LIMIT 1`,
        [repository],
      )
    ).rows[0];
    if (!installed) throw new Error(`${repository} is not installed for the Beeline GitHub App`);
    const token = await this.app.installationToken(Number(installed.installation_id), {
      repositoryIds: [Number(installed.repository_id)],
      permissions: { pull_requests: 'read' },
    });
    try {
      return (await this.app.readPullRequest(token.token, installed.full_name, number)).merged;
    } catch (error) {
      if (error instanceof GitHubHttpError && error.status === 404) return false;
      throw error;
    }
  }
}
