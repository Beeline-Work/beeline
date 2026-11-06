import { ExternalServiceTimeoutError } from './external-fetch.js';
import { GitHubAppClient, GitHubAppConfig, jsonObject, githubHeaders, repositoryPath, GitHubHttpError, responseRetryAfter, GitHubCheckPermissionError, GitHubRequestError, GitHubInstallationRepository, GitHubInstallationAccount, GitHubOrganizationMembership } from './github.js';



  /** A completed Actions job's log is available before its workflow run finishes. */
  export async function gitHubAppClientReadJobLog(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> }, accessToken: string, fullName: string, jobId: number): Promise<string> {
    if (!Number.isSafeInteger(jobId) || jobId <= 0) throw new Error('invalid GitHub job id');
    const response = await ctx.service.request(
      `${ctx.config.apiBaseUrl}/repos/${repositoryPath(fullName)}/actions/jobs/${jobId}/logs`,
      { headers: githubHeaders(accessToken), signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok) throw new GitHubHttpError('GitHub job log', response.status, responseRetryAfter(response));
    return response.text();
  }


  export async function gitHubAppClientReadRepositoryJson(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> },
    accessToken: string,
    fullName: string,
    path: string,
  ): Promise<Record<string, unknown>> {
    const response = await ctx.service.request(
      `${ctx.config.apiBaseUrl}/repos/${repositoryPath(fullName)}/${path}`,
      {
        headers: githubHeaders(accessToken),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      // Only retain bounded diagnostic fields, never the raw response or auth headers.
      const diagnostic = (value: unknown): string | undefined => typeof value === 'string'
        ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500) || undefined
        : undefined;
      const details: string[] = [];
      let providerMessage: unknown;
      try {
        const body: unknown = await response.json();
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          providerMessage = (body as { message?: unknown }).message;
          const message = diagnostic(providerMessage);
          if (message) details.push(message);
        }
      } catch {
        // A non-JSON refusal must still preserve the HTTP status and retry headers.
      }
      const requestId = diagnostic(response.headers.get('x-github-request-id'));
      const permissions = diagnostic(response.headers.get('x-accepted-github-permissions'));
      if (requestId) details.push(`request ID: ${requestId}`);
      if (permissions) details.push(`accepted permissions: ${permissions}`);
      const checkPermission = path.startsWith('actions/runs?') ? 'actions=read'
        : /^commits\/[a-f0-9]{40,64}\/check-suites\?/.test(path) ? 'checks=read' : undefined;
      const ErrorType = response.status === 403 && providerMessage === 'Resource not accessible by integration' &&
        checkPermission && permissions?.split(/[;,]/).some(value => value.trim() === checkPermission)
        ? GitHubCheckPermissionError : GitHubRequestError;
      throw new ErrorType(
        `GitHub PR checks GET /repos/${repositoryPath(fullName)}/${path}`,
        response.status, details.join('; ') || undefined, responseRetryAfter(response),
      );
    }
    return (await response.json()) as Record<string, unknown>;
  }


  /** Read live repository and branch protection before destructive cleanup. */
  export async function gitHubAppClientBranchDeletionSafety(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> }, accessToken: string, fullName: string, branch: string) {
    const response = await ctx.service.request(`${ctx.config.apiBaseUrl}/repos/${repositoryPath(fullName)}`, {
      headers: githubHeaders(accessToken), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new GitHubHttpError('GitHub repository', response.status, responseRetryAfter(response));
    const repository = await response.json() as { default_branch?: unknown };
    if (typeof repository.default_branch !== 'string') throw new Error('GitHub default branch is missing');
    let details: Record<string, unknown>;
    try {
      details = await ctx.service.readRepositoryJson(accessToken, fullName, `branches/${encodeURIComponent(branch)}`);
    } catch (error) {
      if (error instanceof GitHubHttpError && (error.status === 404 || error.status === 422)) return undefined;
      throw error;
    }
    if (typeof details.protected !== 'boolean') throw new Error('GitHub branch protection is missing');
    const pulls = await ctx.service.readRepositoryJson(accessToken, fullName,
      `pulls?state=open&base=${encodeURIComponent(branch)}&per_page=1`);
    if (!Array.isArray(pulls)) throw new Error('GitHub branch pull requests are invalid');
    const comparison = await ctx.service.readRepositoryJson(accessToken, fullName,
      `compare/${encodeURIComponent(repository.default_branch)}...${encodeURIComponent(branch)}?per_page=1`);
    if (!Number.isSafeInteger(comparison.ahead_by) || Number(comparison.ahead_by) < 0)
      throw new Error('GitHub branch commit comparison is missing');
    return { defaultBranch: repository.default_branch, protected: details.protected,
      openBasePullRequest: pulls.length > 0, aheadBy: Number(comparison.ahead_by) };
  }


  /** Delete one installation-scoped branch after its corner has been archived. */
  export async function gitHubAppClientDeleteBranch(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> },
    installationId: number,
    repositoryId: number,
    fullName: string,
    branch: string,
  ): Promise<void> {
    const token = await ctx.service.installationToken(installationId, {
      repositoryIds: [repositoryId],
      permissions: { contents: 'write' },
    });
    const repositoryPath = fullName
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');
    const branchPath = branch
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');
    const response = await ctx.service.request(
      `${ctx.config.apiBaseUrl}/repos/${repositoryPath}/git/refs/heads/${branchPath}`,
      { method: 'DELETE', headers: githubHeaders(token.token), signal: AbortSignal.timeout(15_000) },
    );
    // A 404 means GitHub's delete-on-merge setting already removed the ref.
    if (!response.ok && response.status !== 404 && response.status !== 422) {
      throw new GitHubHttpError('GitHub branch deletion', response.status);
    }
  }


  /** Read the provider's queue entry, including the combined commit under test. */
  export async function gitHubAppClientReadPullRequestQueue(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> }, accessToken: string, fullName: string, number: number) {
    const [owner, name] = fullName.split('/');
    const data = await ctx.service.queueGraphql(accessToken, `query($owner:String!,$name:String!,$number:Int!){
      repository(owner:$owner,name:$name){pullRequest(number:$number){id headRefOid
        mergeQueueEntry{id headCommit{oid}}
      }}
    }`, { owner, name, number });
    const repository = data.repository as Record<string, unknown> | undefined;
    const pr = repository?.pullRequest as {
      id?: string; headRefOid?: string; mergeQueueEntry?: { id: string; headCommit?: { oid: string } } | null;
    } | undefined;
    if (!pr?.id || !pr.headRefOid || !('mergeQueueEntry' in pr))
      throw new Error('GitHub queue read returned no pull request or queue state');
    return { id: pr.id, headSha: pr.headRefOid, entry: pr.mergeQueueEntry ?? null };
  }


  export async function gitHubAppClientQueueGraphql(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> }, token: string, query: string, variables: Record<string, unknown>, label = 'GitHub merge queue') {
    const response = await ctx.service.request(`${ctx.config.apiBaseUrl}/graphql`, {
      method: 'POST', headers: { ...githubHeaders(token), 'content-type': 'application/json' },
      signal: AbortSignal.timeout(15_000), body: JSON.stringify({ query, variables }),
    });
    const body = await jsonObject(response, label);
    if (Array.isArray(body.errors) && body.errors.length) throw new Error(`${label} returned errors`);
    if (!body.data || typeof body.data !== 'object') throw new Error(`${label} returned no data`);
    return body.data as Record<string, unknown>;
  }


  export async function gitHubAppClientDequeuePullRequest(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> }, accessToken: string, id: string): Promise<void> {
    await ctx.service.queueGraphql(accessToken, `mutation($id:ID!){dequeuePullRequest(input:{pullRequestId:$id}){clientMutationId}}`, { id });
  }


  /** Squash-merge one PR using an exact-repository installation grant. */
  export async function gitHubAppClientMergePullRequest(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> },
    installationId: number,
    repositoryId: number,
    fullName: string,
    pullRequestNumber: number,
    expectedHeadSha: string,
  ): Promise<'queued' | void> {
    const token = await ctx.service.installationToken(installationId, {
      repositoryIds: [repositoryId],
      // A squash that rewrites a workflow file needs workflows write, even when
      // the PR's own diff only matches what main already had.
      permissions: { contents: 'write', pull_requests: 'write', workflows: 'write' },
    });
    const pr = await ctx.service.readPullRequest(token.token, fullName, pullRequestNumber);
    if (pr.headSha !== expectedHeadSha || !pr.baseRef) throw new Error('GitHub merge target moved');
    const [owner, name] = fullName.split('/');
    const configuration = await ctx.service.queueGraphql(token.token, `query($owner:String!,$name:String!,$branch:String!){
      repository(owner:$owner,name:$name){mergeQueue(branch:$branch){id}}
    }`, { owner, name, branch: pr.baseRef });
    const repository = configuration.repository as { mergeQueue?: { id: string } | null } | undefined;
    if (!repository || !('mergeQueue' in repository)) throw new Error('GitHub queue configuration unavailable');
    if (repository.mergeQueue) {
      const queue = await ctx.service.readPullRequestQueue(token.token, fullName, pullRequestNumber);
      if (queue.headSha !== expectedHeadSha) throw new Error('GitHub queue target moved');
      if (!queue.entry) {
        try {
          await ctx.service.queueGraphql(token.token, `mutation($id:ID!,$head:GitObjectID!){
            enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head}){mergeQueueEntry{id}}
          }`, { id: queue.id, head: expectedHeadSha });
        } catch (error) {
          // A lost response can conceal an accepted enqueue. Recovery must
          // inspect GitHub before releasing the exact-head merge claim.
          throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { queueAttempted: true });
        }
      }
      return 'queued';
    }
    const encodedRepositoryPath = fullName
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');
    const response = await ctx.service.request(
      `${ctx.config.apiBaseUrl}/repos/${encodedRepositoryPath}/pulls/${pullRequestNumber}/merge`,
      {
        method: 'PUT',
        headers: { ...githubHeaders(token.token), 'content-type': 'application/json' },
        body: JSON.stringify({ merge_method: 'squash', sha: expectedHeadSha }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      let reason = '';
      try {
        const body = (await response.json()) as { message?: unknown };
        if (typeof body.message === 'string') reason = `: ${body.message}`;
      } catch {}
      const error = new GitHubHttpError('GitHub pull request merge', response.status);
      error.message += reason;
      throw Object.assign(error, { mergeAttempted: true });
    }
  }


  /** Close one PR without merging; its branch and commits stay on GitHub. */
  export async function gitHubAppClientClosePullRequest(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> },
    installationId: number,
    repositoryId: number,
    fullName: string,
    pullRequestNumber: number,
  ): Promise<void> {
    const token = await ctx.service.installationToken(installationId, {
      repositoryIds: [repositoryId],
      permissions: { pull_requests: 'write' },
    });
    const current = await ctx.service.readRepositoryJson(token.token, fullName, `pulls/${pullRequestNumber}`);
    if (current.merged === true) throw new Error('The pull request is already merged');
    if (current.state === 'closed') return;
    const head = current.head as { ref?: unknown } | undefined;
    if (current.state !== 'open' || typeof head?.ref !== 'string')
      throw new Error('GitHub pull request state or branch is missing');
    const dependents = await ctx.service.readRepositoryJson(token.token, fullName,
      `pulls?state=open&base=${encodeURIComponent(head.ref)}&per_page=1`);
    if (!Array.isArray(dependents)) throw new Error('GitHub dependent pull requests are invalid');
    if (dependents.length) throw new Error('The pull request branch is the base of an open pull request');
    const response = await ctx.service.request(
      `${ctx.config.apiBaseUrl}/repos/${repositoryPath(fullName)}/pulls/${pullRequestNumber}`,
      {
        method: 'PATCH',
        headers: { ...githubHeaders(token.token), 'content-type': 'application/json' },
        body: JSON.stringify({ state: 'closed' }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      let reason = '';
      try {
        const body = (await response.json()) as { message?: unknown };
        if (typeof body.message === 'string') reason = `: ${body.message}`;
      } catch {}
      throw new Error(`GitHub pull request close failed: HTTP ${response.status}${reason}`);
    }
  }


  /**
   * One Issues REST call on `fullName` (the feedback loop's filing path).
   * `path` is relative to the repository, e.g. `issues` or
   * `issues/comments/7`. A refusal carries GitHub's own `message` so the
   * caller can hand the reason back unchanged.
   */
  export async function gitHubAppClientIssuesRequest(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> },
    accessToken: string,
    fullName: string,
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await ctx.service.request(
      `${ctx.config.apiBaseUrl}/repos/${repositoryPath(fullName)}/${path}`,
      {
        method,
        headers: {
          ...githubHeaders(accessToken),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      },
    );
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const message =
        parsed && typeof parsed === 'object' && typeof (parsed as { message?: unknown }).message === 'string'
          ? (parsed as { message: string }).message
          : undefined;
      throw new GitHubRequestError('GitHub issues', response.status, message);
    }
    return parsed;
  }


  /** Compatibility helper for older callers. */
  export async function gitHubAppClientInstallationAccountId(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> }, installationId: number): Promise<string> {
    return (await ctx.service.installationAccount(installationId)).id;
  }


  export async function gitHubAppClientListRepositories(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> }, installationId: number): Promise<GitHubInstallationRepository[]> {
    const installation = await ctx.service.installationToken(installationId);
    const repositories: GitHubInstallationRepository[] = [];
    for (let page = 1; ; page++) {
      const body = await jsonObject(
        await ctx.service.request(
          `${ctx.config.apiBaseUrl}/installation/repositories?per_page=100&page=${page}`,
          { headers: githubHeaders(installation.token) },
        ),
        'GitHub installation repositories',
      );
      if (!Array.isArray(body.repositories)) throw new Error('GitHub repository list is invalid');
      const parsed = body.repositories.map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          throw new Error('GitHub repository entry is invalid');
        }
        const repo = entry as Record<string, unknown>;
        const id = typeof repo.id === 'number' ? repo.id : NaN;
        const name = typeof repo.name === 'string' ? repo.name : '';
        const fullName = typeof repo.full_name === 'string' ? repo.full_name : '';
        const remote = typeof repo.clone_url === 'string' ? repo.clone_url : '';
        const defaultBranch = typeof repo.default_branch === 'string' ? repo.default_branch : '';
        if (!Number.isSafeInteger(id) || !name || !fullName || !remote || !defaultBranch) {
          throw new Error('GitHub repository entry is invalid');
        }
        return {
          id,
          installationId,
          name,
          fullName,
          remote,
          defaultBranch,
          private: repo.private !== false,
          allowAutoMerge: repo.allow_auto_merge === true,
        };
      });
      repositories.push(...parsed);
      if (body.repositories.length < 100) return repositories;
    }
  }


  export async function gitHubAppClientCreateRepository(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> },
    installationId: number,
    account: Pick<GitHubInstallationAccount, 'login' | 'type'>,
    input: { name: string; description?: string; private?: boolean },
    userAccessToken?: string,
  ): Promise<GitHubInstallationRepository> {
    const token =
      account.type === 'User'
        ? userAccessToken
        : (await ctx.service.installationToken(installationId)).token;
    if (!token)
      throw new Error('GitHub user authorization is required to create a personal repository');
    const path =
      account.type === 'Organization'
        ? `/orgs/${encodeURIComponent(account.login)}/repos`
        : '/user/repos';
    let body: Record<string, unknown>;
    try {
      body = await jsonObject(
        await ctx.service.request(`${ctx.config.apiBaseUrl}${path}`, {
          method: 'POST',
          headers: { ...githubHeaders(token), 'content-type': 'application/json' },
          // GitHub creates README.md and the default-branch first commit in the
          // same repository creation request. The Room can then fetch main on
          // its first start, including for a selected installation account.
          body: JSON.stringify({ ...input, auto_init: true }),
        }),
        'GitHub repository creation',
      );
    } catch (error) {
      if (error instanceof ExternalServiceTimeoutError)
        throw new ExternalServiceTimeoutError(
          'GitHub did not finish responding. The repository may have been created. The result is unknown; refresh to check before retrying.',
        );
      throw error;
    }
    const id = body.id;
    const name = body.name;
    const fullName = body.full_name;
    const remote = body.clone_url;
    const defaultBranch = body.default_branch;
    if (
      typeof id !== 'number' ||
      !Number.isSafeInteger(id) ||
      typeof name !== 'string' ||
      typeof fullName !== 'string' ||
      typeof remote !== 'string' ||
      typeof defaultBranch !== 'string'
    ) {
      throw new Error('GitHub repository creation response is invalid');
    }
    return {
      id,
      installationId,
      name,
      fullName,
      remote,
      defaultBranch,
      private: body.private !== false,
      allowAutoMerge: body.allow_auto_merge === true,
    };
  }


  export async function gitHubAppClientUserCanAccessInstallation(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> }, accessToken: string, installationId: number): Promise<boolean> {
    return (await ctx.service.userInstallationIds(accessToken, installationId)).targetFound;
  }


  /**
   * Follow GitHub's rename/transfer redirect for a repository address. A moved
   * repository answers GET /repos/{old} with a 301 and describes the NEW
   * location in the body, so this resolves a stale owner/name to the current
   * one without any stored state. Undefined when GitHub has no such repository
   * (or the lookup fails); never throws.
   *
   * LIMITATION: GitHub only issues that redirect to viewers already able to
   * see the repository at its new location, and the App JWT alone reads
   * public repositories. A PRIVATE repo transferred to an account whose
   * installation is not (yet) recorded therefore comes back undefined here —
   * `movedTo` stays unknown and callers must rely on installation
   * reconciliation plus immutable-id healing instead of redirect following.
   */
  export async function gitHubAppClientRepositoryByFullName(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> },
    fullName: string,
  ): Promise<{ id: number; fullName: string } | undefined> {
    const [owner, repository] = fullName.split('/');
    if (!owner || !repository) return undefined;
    try {
      const body = await jsonObject(
        await ctx.service.request(
          `${ctx.config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository.replace(/\.git$/i, ''))}`,
          { headers: githubHeaders(await ctx.service.appJwt()), redirect: 'follow' },
        ),
        'GitHub repository lookup',
      );
      const id = body.id;
      const currentFullName = body.full_name;
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return undefined;
      if (typeof currentFullName !== 'string' || !currentFullName.includes('/')) return undefined;
      return { id, fullName: currentFullName };
    } catch {
      return undefined;
    }
  }


  export async function gitHubAppClientListUserInstallationIds(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> }, accessToken: string): Promise<number[]> {
    return (await ctx.service.userInstallationIds(accessToken)).installationIds;
  }


  /** A linked installation may change owners only with an explicit admin grant. */
  export async function gitHubAppClientOrganizationAdmin(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> }, accessToken: string, organization: string): Promise<boolean> {
    const response = await ctx.service.request(`${ctx.config.apiBaseUrl}/user/memberships/orgs/${encodeURIComponent(organization)}`,
      { headers: githubHeaders(accessToken) });
    if (!response.ok) return false;
    const body = await response.json() as Record<string, unknown>;
    return body.state === 'active' && body.role === 'admin';
  }


  /**
   * What a user's own token can prove about their membership in `organization`.
   *
   * GET /user/memberships/orgs/{org} describes the AUTHENTICATED user only, so
   * it answers the one question the installation listing leaves open: an
   * organization installation missing from GET /user/installations may belong
   * to an org this user is plainly a member of, and membership is the fallback
   * that lets reconciliation claim it (see the caller in server-context.ts).
   *
   * Deliberately total and non-throwing. GitHub answers 404 for a non-member,
   * which is a DEFINITIVE no; every other failure (403 when the App's user
   * token is not allowed to read memberships, a 5xx, a network error) is
   * 'unknown' so callers fall back to their prior behaviour instead of
   * inventing either a claim or a refusal. That matters because the App
   * manifest deliberately requests NO organization permissions — this endpoint
   * may simply be closed to the token, and the fallback must degrade quietly.
   */
  export async function gitHubAppClientOrganizationMembership(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> },
    accessToken: string,
    organization: string,
  ): Promise<GitHubOrganizationMembership> {
    let response: Response;
    try {
      response = await ctx.service.request(
        `${ctx.config.apiBaseUrl}/user/memberships/orgs/${encodeURIComponent(organization)}`,
        { headers: githubHeaders(accessToken) },
      );
    } catch {
      return 'unknown';
    }
    if (response.status === 404) return 'none';
    if (!response.ok) return 'unknown';
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (error instanceof ExternalServiceTimeoutError) throw error;
      return 'unknown';
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'unknown';
    const state = (body as Record<string, unknown>).state;
    if (state === 'active') return 'active';
    // 'pending' is an unaccepted invitation: a real answer, but not membership.
    return state === 'pending' ? 'pending' : 'unknown';
  }


  /**
   * Whether the authenticated user has starred `owner/repo`
   * (GET /user/starred/{owner}/{repo}). 204 is yes and 404 is no. Anything
   * else, including 403 for a token without the Starring permission, is
   * 'unknown'. Never throws.
   */
  export async function gitHubAppClientRepositoryStarred(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> }, accessToken: string, fullName: string): Promise<boolean | 'unknown'> {
    let response: Response;
    try {
      response = await ctx.service.request(`${ctx.config.apiBaseUrl}/user/starred/${fullName}`, {
        headers: githubHeaders(accessToken),
      });
    } catch {
      return 'unknown';
    }
    if (response.status === 204) return true;
    if (response.status === 404) return false;
    return 'unknown';
  }


  /**
   * Star `owner/repo` as the authenticated user (PUT /user/starred/{owner}/{repo}).
   * Returns false when GitHub refuses, e.g. a 403 for a user token whose App
   * install has not approved the Starring permission yet. Never throws.
   */
  export async function gitHubAppClientStarRepository(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> }, accessToken: string, fullName: string): Promise<boolean> {
    try {
      const response = await ctx.service.request(`${ctx.config.apiBaseUrl}/user/starred/${fullName}`, {
        method: 'PUT',
        headers: { ...githubHeaders(accessToken), 'content-length': '0' },
      });
      return response.status === 204;
    } catch {
      return false;
    }
  }


  export async function gitHubAppClientUserInstallationIds(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> },
    accessToken: string,
    targetId?: number,
  ): Promise<{ installationIds: number[]; targetFound: boolean }> {
    const installationIds: number[] = [];
    for (let page = 1; ; page++) {
      const body = await jsonObject(
        await ctx.service.request(`${ctx.config.apiBaseUrl}/user/installations?per_page=100&page=${page}`, {
          headers: githubHeaders(accessToken),
        }),
        'GitHub user installations',
      );
      if (!Array.isArray(body.installations))
        throw new Error('GitHub user installation list is invalid');
      for (const entry of body.installations) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          throw new Error('GitHub user installation entry is invalid');
        }
        const id = (entry as Record<string, unknown>).id;
        if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
          throw new Error('GitHub user installation entry is invalid');
        }
        installationIds.push(id);
      }
      if (targetId !== undefined && installationIds.includes(targetId)) {
        return { installationIds, targetFound: true };
      }
      if (body.installations.length < 100) {
        return { installationIds: [...new Set(installationIds)], targetFound: false };
      }
    }
  }
