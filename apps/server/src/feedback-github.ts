import { GitHubRequestError, type GitHubAppClient } from '@beeline/auth/github';
import type { FeedbackIssueSummary } from '@beeline/api-contract/daemon';
import type { SqlDatabase } from './database.js';
import type { FeedbackIssueHost } from './feedback.js';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function issueSummary(value: unknown): FeedbackIssueSummary & {
  state: string;
  pullRequest: boolean;
} {
  const issue = record(value);
  if (typeof issue.number !== 'number' || typeof issue.html_url !== 'string')
    throw new Error('GitHub issue response is invalid');
  return {
    number: issue.number,
    title: typeof issue.title === 'string' ? issue.title : '',
    url: issue.html_url,
    labels: Array.isArray(issue.labels)
      ? issue.labels
          .map((label) => (typeof label === 'string' ? label : record(label).name))
          .filter((name): name is string => typeof name === 'string')
      : [],
    state: typeof issue.state === 'string' ? issue.state : 'open',
    pullRequest: issue.pull_request !== undefined,
  };
}

/**
 * The feedback loop's Issues calls, made with a Beeline GitHub App
 * installation token scoped to the configured repository and `issues: write`.
 * The repository must already be in the App's installed catalog.
 */
export class FeedbackGitHub implements FeedbackIssueHost {
  constructor(
    private readonly database: SqlDatabase,
    private readonly app: GitHubAppClient,
  ) {}

  private async request(
    repository: string,
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const installed = (
      await this.database.query<{ installation_id: string; repository_id: string; full_name: string }>(
        `SELECT installation_id,repository_id,full_name FROM github_repositories
         WHERE lower(full_name)=lower($1) AND active LIMIT 1`,
        [repository],
      )
    ).rows[0];
    if (!installed)
      throw new Error(`${repository} is not installed for the Beeline GitHub App`);
    const token = await this.app.installationToken(Number(installed.installation_id), {
      repositoryIds: [Number(installed.repository_id)],
      permissions: { issues: 'write' },
    });
    return this.app.issuesRequest(token.token, installed.full_name, method, path, body);
  }

  async createIssue(
    repository: string,
    issue: { title: string; body: string; labels: readonly string[] },
  ): Promise<{ number: number; url: string }> {
    const created = issueSummary(
      await this.request(repository, 'POST', 'issues', {
        title: issue.title,
        body: issue.body,
        labels: [...issue.labels],
      }),
    );
    return { number: created.number, url: created.url };
  }

  async readIssue(repository: string, number: number) {
    return issueSummary(await this.request(repository, 'GET', `issues/${number}`));
  }

  async listOpenIssues(repository: string, label: string): Promise<FeedbackIssueSummary[]> {
    const listed = await this.request(
      repository,
      'GET',
      `issues?state=open&per_page=100&labels=${encodeURIComponent(label)}`,
    );
    return (Array.isArray(listed) ? listed : [])
      .map(issueSummary)
      .filter((issue) => !issue.pullRequest)
      .map(({ number, title, url, labels }) => ({ number, title, url, labels }));
  }

  async createComment(repository: string, number: number, body: string): Promise<{ id: number }> {
    const created = record(
      await this.request(repository, 'POST', `issues/${number}/comments`, { body }),
    );
    if (typeof created.id !== 'number') throw new Error('GitHub comment response is invalid');
    return { id: created.id };
  }

  async updateComment(repository: string, commentId: number, body: string): Promise<boolean> {
    try {
      await this.request(repository, 'PATCH', `issues/comments/${commentId}`, { body });
      return true;
    } catch (error) {
      if (error instanceof GitHubRequestError && error.status === 404) return false;
      throw error;
    }
  }
}
