import { ExternalServiceTimeoutError } from './external-fetch.js';
import { importPKCS8, SignJWT } from 'jose';
import { GitHubAppClient, GitHubAppConfig, jsonObject, githubHeaders, GitHubInstallationToken, GitHubDispatchableWorkflow, repositoryPath, isMissingGitHubResource, hasWorkflowDispatch, GitHubHttpError, githubMergeability, jsonArray, responseRetryAfter, GitHubCheckRollup, checkRunAppId, suiteHasUnfinishedRuns, registrationStillOpen, requiredChecks } from './github.js';



  export function gitHubAppClientInstallationUrl(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> }, state: string, selectTarget = false): string {
    const url = new URL(`https://github.com/apps/${ctx.config.slug}/installations/${selectTarget ? 'select_target' : 'new'}`);
    url.searchParams.set('state', state);
    return url.toString();
  }


  /**
   * THIS App's own live configuration (GET /app, App-JWT authenticated):
   * the subscribed events and permission levels the drift check compares
   * against the required set.
   */
  export async function gitHubAppClientFetchApp(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> }): Promise<{ slug: string; events?: unknown; permissions?: unknown }> {
    const body = await jsonObject(
      await ctx.service.request(`${ctx.config.apiBaseUrl}/app`, {
        headers: githubHeaders(await ctx.service.appJwt()),
      }),
      'GitHub app lookup',
    );
    const slug = body.slug;
    if (typeof slug !== 'string' || !slug) {
      throw new Error('GitHub app lookup response is invalid');
    }
    return { slug, events: body.events, permissions: body.permissions };
  }


  export async function gitHubAppClientAppJwt(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> }): Promise<string> {
    const key = await importPKCS8(ctx.config.privateKey.replace(/\\n/g, '\n'), 'RS256');
    const now = Math.floor(Date.now() / 1_000);
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 9 * 60)
      .setIssuer(ctx.config.appId)
      .sign(key);
  }


  export async function gitHubAppClientMintInstallationToken(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> }, installationId: number, options: {
    repositoryIds?: readonly number[]; permissions?: Readonly<Record<string, string>>;
  }): Promise<GitHubInstallationToken> {
    const hasBody = Boolean(options.repositoryIds?.length) || Boolean(options.permissions);
    const response = await ctx.service.request(`${ctx.config.apiBaseUrl}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        ...githubHeaders(await ctx.service.appJwt()),
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
      },
      ...(hasBody
        ? {
            body: JSON.stringify({
              ...(options.repositoryIds?.length ? { repository_ids: options.repositoryIds } : {}),
              ...(options.permissions ? { permissions: options.permissions } : {}),
            }),
          }
        : {}),
    });
    if (!response.ok) {
      try {
        const requestId = response.headers.get('x-github-request-id') ?? '';
        const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
        const mediaType = contentType === 'application/json' || contentType === 'application/vnd.github+json'
          ? 'json' : contentType === 'text/html' ? 'html' : contentType ? 'other' : 'missing';
        // Only bounded correlation metadata; never retain bodies, credentials or request scope.
        console.warn('[github-installation-token]', {
          status: response.status,
          requestId: requestId.length <= 128 && /^[0-9a-f]+(?::[0-9a-f]+)+$/i.test(requestId)
            ? requestId : 'unavailable',
          mediaType,
        });
      } catch { /* Diagnostics must not replace the original GitHub failure. */ }
    }
    const body = await jsonObject(response, 'GitHub installation token');
    const token = typeof body.token === 'string' ? body.token : '';
    const expiresAt = typeof body.expires_at === 'string' ? body.expires_at : '';
    if (!token || !Number.isFinite(Date.parse(expiresAt))) {
      throw new Error('GitHub installation token response is invalid');
    }
    return { token, expiresAt };
  }


  /** List only workflows a person can dispatch, with the latest run on any branch. */
  export async function gitHubAppClientListDispatchableWorkflows(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> },
    accessToken: string,
    fullName: string,
    defaultBranch: string,
  ): Promise<GitHubDispatchableWorkflow[]> {
    const path = repositoryPath(fullName);
    const candidates: { id: number; name: string; path: string; state: string }[] = [];
    for (let page = 1; ; page++) {
      const body = await jsonObject(
        await ctx.service.request(
          `${ctx.config.apiBaseUrl}/repos/${path}/actions/workflows?per_page=100&page=${page}`,
          { headers: githubHeaders(accessToken) },
        ),
        'GitHub workflow list',
      );
      if (!Array.isArray(body.workflows)) throw new Error('GitHub workflow list is invalid');
      for (const entry of body.workflows) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          throw new Error('GitHub workflow entry is invalid');
        }
        const record = entry as Record<string, unknown>;
        const id = record.id;
        const name = record.name;
        const workflowPath = record.path;
        const state = record.state;
        if (
          typeof id !== 'number' ||
          !Number.isSafeInteger(id) ||
          id <= 0 ||
          typeof name !== 'string' ||
          !name.trim() ||
          typeof workflowPath !== 'string' ||
          !workflowPath ||
          typeof state !== 'string'
        ) {
          throw new Error('GitHub workflow entry is invalid');
        }
        candidates.push({ id, name: name.trim(), path: workflowPath, state });
      }
      if (body.workflows.length < 100) break;
    }
    const workflows = await Promise.all(
      candidates.map(async (workflow): Promise<GitHubDispatchableWorkflow | undefined> => {
        if (workflow.state !== 'active') return undefined;
        let content: Record<string, unknown>;
        try {
          content = await jsonObject(
            await ctx.service.request(
              `${ctx.config.apiBaseUrl}/repos/${path}/contents/${workflow.path
                .split('/')
                .map((part) => encodeURIComponent(part))
                .join('/')}?ref=${encodeURIComponent(defaultBranch)}`,
              { headers: githubHeaders(accessToken) },
            ),
            'GitHub workflow source',
          );
        } catch (error) {
          if (isMissingGitHubResource(error)) return undefined;
          throw error;
        }
        if (content.encoding !== 'base64' || typeof content.content !== 'string') {
          return undefined;
        }
        const source = Buffer.from(content.content.replace(/\s/g, ''), 'base64').toString('utf8');
        if (!hasWorkflowDispatch(source)) return undefined;
        let runs: Record<string, unknown>;
        try {
          runs = await jsonObject(
            await ctx.service.request(
              `${ctx.config.apiBaseUrl}/repos/${path}/actions/workflows/${workflow.id}/runs?per_page=1`,
              { headers: githubHeaders(accessToken) },
            ),
            'GitHub workflow runs',
          );
        } catch (error) {
          if (isMissingGitHubResource(error)) return undefined;
          throw error;
        }
        if (!Array.isArray(runs.workflow_runs)) throw new Error('GitHub workflow runs are invalid');
        const latest = runs.workflow_runs[0];
        if (!latest) return { id: workflow.id, name: workflow.name };
        if (typeof latest !== 'object' || Array.isArray(latest)) {
          throw new Error('GitHub workflow run entry is invalid');
        }
        const run = latest as Record<string, unknown>;
        const runAt = typeof run.created_at === 'string' ? Date.parse(run.created_at) : NaN;
        const conclusion = typeof run.conclusion === 'string' ? run.conclusion.trim() : '';
        return {
          id: workflow.id,
          name: workflow.name,
          ...(Number.isFinite(runAt) ? { lastRunAt: Math.floor(runAt / 1_000) } : {}),
          ...(conclusion ? { conclusion } : {}),
        };
      }),
    );
    return workflows
      .filter((workflow): workflow is GitHubDispatchableWorkflow => Boolean(workflow))
      .sort((left, right) => left.name.localeCompare(right.name));
  }


  /**
   * The immutable git blob SHA of ONE file, or undefined when that ref does not
   * carry that path as a file.
   *
   * The contents API answers the blob id directly, so a reader compares content
   * identity without downloading or re-hashing bytes, and "this code is not
   * here" (a 404, or a directory, which answers an array) stays distinct from
   * "the API failed". A code-anchor check turns the first into a stale
   * procedure and must never turn the second into one, so the two answers may
   * not collapse into a generic error.
   */
  export async function gitHubAppClientFileBlobSha(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> }, input: {
    accessToken: string;
    fullName: string;
    path: string;
    ref: string;
  }): Promise<string | undefined> {
    const url = new URL(
      `${ctx.config.apiBaseUrl}/repos/${repositoryPath(input.fullName)}/contents/${input.path
        .split('/')
        .map((part) => encodeURIComponent(part))
        .join('/')}`,
    );
    url.searchParams.set('ref', input.ref);
    const response = await ctx.service.request(url, { headers: githubHeaders(input.accessToken) });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new GitHubHttpError('GitHub file lookup', response.status);
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (error instanceof ExternalServiceTimeoutError) throw error;
      throw new Error('GitHub file lookup returned invalid JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
    const file = body as Record<string, unknown>;
    if (file.type !== 'file') return undefined;
    const sha = file.sha;
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error('GitHub file lookup returned an invalid blob id');
    }
    return sha;
  }


  export async function gitHubAppClientDispatchProductionWorkflow(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> }, accessToken: string, fullName: string, inputs: Record<string, string>): Promise<void> {
    if (!inputs.dispatched_by) throw new Error('Production release requires an agent identity');
    // A single match in any active state blocks dispatch; query errors fail closed.
    for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
      const result = await ctx.service.readRepositoryJson(accessToken, fullName,
        `actions/workflows/unified-release.yml/runs?status=${status}&per_page=1`);
      if (!Array.isArray(result.workflow_runs)) throw new Error('Invalid production release run listing');
      if (result.workflow_runs.length) {
        const run = result.workflow_runs[0] as { id?: unknown };
        throw new Error(`Production release ${run.id} is already ${status}. Wait for it to finish or cancel it in GitHub Actions.`);
      }
    }
    const response = await ctx.service.request(
      `${ctx.config.apiBaseUrl}/repos/${repositoryPath(fullName)}/actions/workflows/unified-release.yml/dispatches`,
      { method: 'POST', headers: { ...githubHeaders(accessToken), 'content-type': 'application/json' },
        body: JSON.stringify({ ref: 'main', inputs }) },
    );
    if (!response.ok) throw new GitHubHttpError('GitHub production release dispatch', response.status);
  }


  export async function gitHubAppClientDispatchWorkflow(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> },
    accessToken: string,
    fullName: string,
    workflowId: number,
    defaultBranch: string,
  ): Promise<void> {
    const response = await ctx.service.request(
      `${ctx.config.apiBaseUrl}/repos/${repositoryPath(fullName)}/actions/workflows/${workflowId}/dispatches`,
      {
        method: 'POST',
        headers: { ...githubHeaders(accessToken), 'content-type': 'application/json' },
        body: JSON.stringify({ ref: defaultBranch }),
      },
    );
    if (!response.ok) throw new GitHubHttpError('GitHub workflow dispatch', response.status);
  }


  /** Resolve the current head in the Room's repository, including fork-authored PRs. */
  export async function gitHubAppClientReadPullRequest(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> }, accessToken: string, fullName: string, number: number) {
    const body = await ctx.service.readRepositoryJson(accessToken, fullName, `pulls/${number}`);
    const head = body.head as { sha?: unknown; ref?: unknown } | undefined;
    const base = body.base as { sha?: unknown; ref?: unknown } | undefined;
    if (typeof head?.sha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(head.sha))
      throw new Error('GitHub pull request has no valid head');
    const mergeableState = body.mergeable_state;
    return {
      number,
      url: `https://github.com/${fullName}/pull/${number}`,
      headSha: head.sha,
      ...(typeof head.ref === 'string' ? { headRef: head.ref } : {}),
      ...(typeof base?.ref === 'string' ? { baseRef: base.ref } : {}),
      merged: body.merged === true,
      ...(body.state === 'open' || body.state === 'closed' ? { state: body.state } : {}),
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(typeof body.merged_at === 'string' ? { mergedAt: body.merged_at } : {}),
      ...(typeof body.merge_commit_sha === 'string'
        ? { mergeCommitSha: body.merge_commit_sha }
        : {}),
      ...(typeof (body.merged_by as { login?: unknown } | undefined)?.login === 'string'
        ? { mergedBy: (body.merged_by as { login: string }).login }
        : {}),
      ...(typeof base?.sha === 'string' && /^[a-f0-9]{40,64}$/i.test(base.sha)
        ? { baseSha: base.sha }
        : {}),
      mergeability: body.draft === true ? 'draft' as const : githubMergeability(mergeableState),
    };
  }


  export async function gitHubAppClientMarkPullRequestReadyForReview(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> }, token: string, fullName: string, number: number, headSha: string): Promise<void> {
    const [owner, name] = fullName.split('/');
    const data = await ctx.service.queueGraphql(token, `query($owner:String!,$name:String!,$number:Int!){
      repository(owner:$owner,name:$name){pullRequest(number:$number){id headRefOid}}
    }`, { owner, name, number }, 'GitHub draft readiness');
    const pr = (data.repository as { pullRequest?: { id: string; headRefOid: string } })?.pullRequest;
    if (!pr?.id || pr.headRefOid !== headSha) throw new Error('PR head changed before marking ready');
    const result = await ctx.service.queueGraphql(token, `mutation($id:ID!){
      markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}
    }`, { id: pr.id }, 'GitHub draft readiness');
    const ready = result.markPullRequestReadyForReview as { pullRequest?: { isDraft: boolean } } | undefined;
    if (ready?.pullRequest?.isDraft !== false) throw new Error('PR is still a draft');
  }


  /** Bounded, paginated file names for event-triggered prompt replay. No patches or PR text. */
  export async function gitHubAppClientReadPullRequestFiles(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> }, accessToken: string, fullName: string, number: number) {
    const files: Array<{ filename: string; previousFilename?: string }> = [];
    // GitHub caps this endpoint at 3,000 files. At the cap callers replay conservatively.
    for (let page = 1; page <= 30; page++) {
      const response = await ctx.service.request(
        `${ctx.config.apiBaseUrl}/repos/${repositoryPath(fullName)}/pulls/${number}/files?per_page=100&page=${page}`,
        { headers: githubHeaders(accessToken), signal: AbortSignal.timeout(15_000) },
      );
      const rows = await jsonArray(response, 'GitHub pull request files');
      for (const row of rows) {
        if (typeof row.filename !== 'string') throw new Error('GitHub file has no filename');
        files.push({ filename: row.filename,
          ...(typeof row.previous_filename === 'string' ? { previousFilename: row.previous_filename } : {}) });
      }
      if (rows.length < 100) return { files, complete: true };
    }
    return { files, complete: false };
  }


  /** A PR's changed files, reviews, inline review comments and conversation comments. */
  export async function gitHubAppClientReadPullRequestDiscussion(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> }, accessToken: string, fullName: string, number: number) {
    const list = async (path: string) => {
      const response = await ctx.service.request(
        `${ctx.config.apiBaseUrl}/repos/${repositoryPath(fullName)}/${path}?per_page=100`,
        { headers: githubHeaders(accessToken), signal: AbortSignal.timeout(15_000) },
      );
      return jsonArray(response, 'GitHub pull request read');
    };
    const [files, reviews, reviewComments, comments] = await Promise.all([
      list(`pulls/${number}/files`),
      list(`pulls/${number}/reviews`),
      list(`pulls/${number}/comments`),
      list(`issues/${number}/comments`),
    ]);
    const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, 2_000) : '');
    const author = (value: unknown) =>
      text((value as { login?: unknown } | null | undefined)?.login);
    return {
      files: files.map((file) => ({
        filename: text(file.filename),
        status: text(file.status),
        additions: Number(file.additions) || 0,
        deletions: Number(file.deletions) || 0,
      })),
      reviews: reviews.map((review) => ({
        author: author(review.user),
        state: text(review.state),
        body: text(review.body),
        ...(typeof review.submitted_at === 'string' ? { submittedAt: review.submitted_at } : {}),
      })),
      reviewComments: reviewComments.map((comment) => ({
        author: author(comment.user),
        path: text(comment.path),
        ...(typeof comment.line === 'number' ? { line: comment.line } : {}),
        body: text(comment.body),
        ...(typeof comment.created_at === 'string' ? { createdAt: comment.created_at } : {}),
      })),
      comments: comments.map((comment) => ({
        author: author(comment.user),
        body: text(comment.body),
        ...(typeof comment.created_at === 'string' ? { createdAt: comment.created_at } : {}),
      })),
    };
  }


  /** Resolve a branch at GitHub now; push deliveries can arrive out of order. */
  export async function gitHubAppClientReadBranchHead(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> }, accessToken: string, fullName: string, branch: string): Promise<string> {
    const body = await ctx.service.readRepositoryJson(
      accessToken,
      fullName,
      `branches/${encodeURIComponent(branch)}`,
    );
    const sha = (body.commit as { sha?: unknown } | undefined)?.sha;
    if (typeof sha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(sha))
      throw new Error('GitHub branch has no valid head');
    return sha;
  }


  /** One repository-owned branch can have at most one open PR for repair. */
  export async function gitHubAppClientOpenPullRequestsForBranch(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> }, accessToken: string, fullName: string, branch: string) {
    const owner = fullName.split('/')[0];
    if (!owner) throw new Error('invalid GitHub repository');
    const url = new URL(`${ctx.config.apiBaseUrl}/repos/${repositoryPath(fullName)}/pulls`);
    url.searchParams.set('state', 'open');
    url.searchParams.set('head', `${owner}:${branch}`);
    url.searchParams.set('per_page', '100');
    const response = await ctx.service.request(url, {
      headers: githubHeaders(accessToken),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new GitHubHttpError('GitHub branch pull requests', response.status, responseRetryAfter(response));
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw new Error('GitHub branch pull requests are invalid');
    return body.flatMap((entry): number[] => {
      const pr = entry && typeof entry === 'object'
        ? entry as { number?: unknown; head?: { repo?: { full_name?: unknown } } }
        : undefined;
      const number = pr?.number;
      return typeof number === 'number' && Number.isSafeInteger(number) && number > 0
        && typeof pr?.head?.repo?.full_name === 'string'
        && pr.head.repo.full_name.toLowerCase() === fullName.toLowerCase()
        ? [number]
        : [];
    });
  }


  /** One admitted read of GitHub's combined verdict and registration pages.
   * Provider failure returns to the caller; no timer repeats the read. */
  export async function gitHubAppClientReadCommitCheckRollup(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> },
    accessToken: string,
    fullName: string,
    headSha: string,
  ): Promise<GitHubCheckRollup> {
    const [owner, name] = fullName.split('/');
    if (!owner || !name || !/^[a-f0-9]{40,64}$/i.test(headSha)) {
      throw new Error('invalid GitHub commit check target');
    }
    const response = await ctx.service.request(`${ctx.config.apiBaseUrl}/graphql`, {
      method: 'POST',
      headers: { ...githubHeaders(accessToken), 'content-type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        query: `query CommitCheckRollup($owner:String!,$name:String!,$expression:String!){
          repository(owner:$owner,name:$name){object(expression:$expression){... on Commit{
            oid statusCheckRollup{state contexts(first:100){totalCount nodes{
              __typename
              ... on CheckRun{name status conclusion detailsUrl checkSuite{app{databaseId}}}
              ... on StatusContext{context state description targetUrl}
            }}}
          }}}
        }`,
        variables: { owner, name, expression: headSha },
      }),
    });
    const body = await jsonObject(response, 'GitHub commit check rollup');
    if (Array.isArray(body.errors) && body.errors.length) {
      throw new Error('GitHub commit check rollup returned errors');
    }
    const repository = body.data as Record<string, unknown> | undefined;
    const object = (repository?.repository as Record<string, unknown> | undefined)?.object as
      Record<string, unknown> | undefined;
    if (object?.oid !== headSha) throw new Error('GitHub commit check rollup head mismatch');
    const rollup = object.statusCheckRollup as Record<string, unknown> | null | undefined;
    if (!rollup) return {
      state: 'pending', total: 0, failing: [], checks: [],
      pendingRegistrations: await ctx.service.hasUnfinishedChecks(accessToken, fullName, headSha),
    };
    const state =
      rollup.state === 'SUCCESS'
        ? ('passed' as const)
        : rollup.state === 'FAILURE' || rollup.state === 'ERROR'
          ? ('failed' as const)
          : rollup.state === 'PENDING' || rollup.state === 'EXPECTED'
            ? ('pending' as const)
            : undefined;
    if (!state) throw new Error('GitHub commit check rollup state is invalid');
    const contexts = rollup.contexts as Record<string, unknown> | undefined;
    if (!contexts || typeof contexts.totalCount !== 'number' || !Array.isArray(contexts.nodes)) {
      throw new Error('GitHub commit check rollup contexts are invalid');
    }
    const reported: { name: string; appId: number | null }[] = [];
    const checks = contexts.nodes.flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const context = value as Record<string, unknown>;
      const isRun = context.__typename === 'CheckRun';
      const checkName = isRun ? context.name : context.context;
      if (typeof checkName !== 'string' || !checkName) return [];
      const checkState = isRun
        ? context.status !== 'COMPLETED' || !context.conclusion
          ? 'pending'
          : ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(String(context.conclusion))
            ? 'passed'
            : String(context.conclusion) === 'CANCELLED'
              ? 'cancelled'
              : 'failed'
        : context.state === 'SUCCESS'
          ? 'passed'
          : context.state === 'FAILURE' || context.state === 'ERROR'
            ? 'failed'
            : 'pending';
      const conclusion = isRun ? context.conclusion : context.description;
      const url = isRun ? context.detailsUrl : context.targetUrl;
      const appId = isRun ? checkRunAppId(context) : null;
      if (checkState === 'passed') reported.push({ name: checkName, appId });
      return [
        {
          name: checkName,
          status: checkState,
          ...(typeof conclusion === 'string' && conclusion ? { conclusion } : {}),
          ...(typeof url === 'string' && url ? { url } : {}),
        } as const,
      ];
    });
    // A workflow can register before it creates a check run, and a suite can
    // already hold queued runs the rollup has not listed. An empty suite is
    // only the placeholder GitHub opens for an installed app. A required
    // check still has to come from the GitHub App branch protection names.
    let total = contexts.totalCount;
    let pending = await ctx.service.hasUnfinishedChecks(accessToken, fullName, headSha);
    if (!pending && state === 'passed') {
      const missing = await ctx.service.missingRequiredChecks(
        accessToken, fullName, headSha, reported,
      );
      if (missing.length) {
        pending = true;
        total += missing.length;
        for (const name of missing) checks.push({ name, status: 'pending' });
      }
    }
    return {
      state: pending ? 'pending' : state,
      pendingRegistrations: pending,
      total,
      failing: checks.filter((check) => check.status === 'failed').map((check) => check.name),
      checks,
    };
  }


  export async function gitHubAppClientHasUnfinishedChecks(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> }, accessToken: string, fullName: string, headSha: string): Promise<boolean> {
    const unfinished = async (
      path: string, key: string, blocks: (item: unknown) => boolean,
    ): Promise<boolean> => {
      for (let page = 1; ; page++) {
        const separator = path.includes('?') ? '&' : '?';
        const body = await ctx.service.readRepositoryJson(
          accessToken, fullName, `${path}${separator}per_page=100&page=${page}`,
        );
        const items = body[key];
        if (!Array.isArray(items) || typeof body.total_count !== 'number' || !Number.isSafeInteger(body.total_count) || body.total_count < 0)
          throw new Error('GitHub head check registration is invalid');
        if (items.some((item) => blocks(item))) return true;
        if (page * 100 >= body.total_count) return false;
        if (!items.length) throw new Error('GitHub head check registration is incomplete');
      }
    };
    const [suites, workflows] = await Promise.all([
      unfinished(`commits/${headSha}/check-suites`, 'check_suites', suiteHasUnfinishedRuns),
      unfinished(`actions/runs?head_sha=${headSha}`, 'workflow_runs', registrationStillOpen),
    ]);
    return suites || workflows;
  }


  /** Branch-protection contexts whose required GitHub App has not passed on this head. */
  export async function gitHubAppClientMissingRequiredChecks(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> },
    accessToken: string,
    fullName: string,
    headSha: string,
    reported: readonly { readonly name: string; readonly appId: number | null }[],
  ): Promise<string[]> {
    const response = await ctx.service.request(
      `${ctx.config.apiBaseUrl}/repos/${repositoryPath(fullName)}/commits/${headSha}/pulls?per_page=100`,
      { headers: githubHeaders(accessToken), signal: AbortSignal.timeout(15_000) },
    );
    const pulls = await jsonArray(response, 'GitHub commit pull requests');
    if (pulls.length >= 100) throw new Error('GitHub commit pull requests are incomplete');
    const bases = new Set<string>();
    for (const pull of pulls) {
      if (pull.state !== 'open') continue;
      const base = pull.base;
      if (!base || typeof base !== 'object' || Array.isArray(base)) continue;
      const ref = (base as { ref?: unknown }).ref;
      if (typeof ref === 'string' && ref) bases.add(ref);
    }
    const missing = new Set<string>();
    for (const branch of bases) {
      let body: Record<string, unknown>;
      try {
        body = await ctx.service.readRepositoryJson(
          accessToken,
          fullName,
          `branches/${encodeURIComponent(branch)}/protection/required_status_checks`,
        );
      } catch (error) {
        if (error instanceof GitHubHttpError && error.status === 404) continue;
        // Private repositories on GitHub Free cannot configure branch protection.
        if (error instanceof GitHubHttpError && error.status === 403 &&
          (error.message.includes('Upgrade to GitHub Pro') ||
            error.message.includes('make this repository public'))) continue;
        throw error;
      }
      for (const required of requiredChecks(body)) {
        const satisfied = reported.some((check) =>
          check.name === required.name &&
          (required.appId === null || check.appId === required.appId));
        if (!satisfied) missing.add(required.name);
      }
    }
    return [...missing];
  }


  /** Empty rollups can precede registration; establish absence independently. */
  export async function gitHubAppClientConfirmNoChecks(ctx: { service: GitHubAppClient; config: Required<GitHubAppConfig> }, accessToken: string, fullName: string, headSha: string): Promise<boolean> {
    if (!/^[a-f0-9]{40,64}$/i.test(headSha)) throw new Error('invalid GitHub commit check target');
    try {
      const permissions = await ctx.service.readRepositoryJson(accessToken, fullName, 'actions/permissions');
      if (permissions.enabled === false) return true;
    } catch {
      // Permission reads are optional; retain the workflow registration proof.
    }
    const workflows = await ctx.service.readRepositoryJson(accessToken, fullName, 'actions/workflows?per_page=1');
    if (typeof workflows.total_count !== 'number' || workflows.total_count < 0)
      throw new Error('GitHub workflow count is invalid');
    if (workflows.total_count === 0) return true;
    // Inspect registration within this explicit read. Time alone cannot
    // authorize another provider observation or establish future absence.
    const [suites, runs] = await Promise.all([
      ctx.service.readRepositoryJson(accessToken, fullName, `commits/${headSha}/check-suites?per_page=1`),
      ctx.service.readRepositoryJson(accessToken, fullName, `actions/runs?head_sha=${headSha}&per_page=1`),
    ]);
    return suites.total_count === 0 && runs.total_count === 0;
  }
