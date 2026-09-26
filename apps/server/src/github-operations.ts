import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  GITHUB_IDENTITY_AUDIENCE,
  GitHubAppClient,
  GitHubOAuthClient,
  GitHubHttpError,
  GitHubCredentialRejectedError,
  githubMergeability,
} from '@beeline/auth/github';
import type { CornerLifecycleView, PhoneOperationMap } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { GITHUB_SUBJECT, systemLine, type SystemPhrase } from './system-line.js';
import {
  lockIdentityHandleWorkspaces,
  reassignCollidingAgentHandles,
} from './workspace-handles.js';
import { recordCornerMergeApproval } from './corner-merge-approval.js';
import { reportUnansweredCornerAsks } from './corner-close.js';
import {
  queueCornerMergeConflict,
  reconcileCornerMergeBlockers,
  routeSystemCommand,
} from './agent-command.js';
import {
  enqueueInstitutionalMemoryMergeReview,
  recordInstitutionalCornerOutcome,
  type InstitutionalMemoryShadowConfig,
} from './institutional-memory-shadow.js';

type Input<Name extends keyof PhoneOperationMap> = PhoneOperationMap[Name]['input'];

type GitHubRecord = Record<string, unknown>;

function record(value: unknown): GitHubRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as GitHubRecord)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function githubUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function repositoryName(body: GitHubRecord): string | undefined {
  return text(record(body.repository)?.full_name);
}

function branchForEvent(event: string, body: GitHubRecord): string | undefined {
  if (event === 'push') {
    const ref = text(body.ref);
    return ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : undefined;
  }
  if (event === 'pull_request') return text(record(record(body.pull_request)?.head)?.ref);
  if (event === 'check_run') return text(record(record(body.check_run)?.check_suite)?.head_branch);
  if (event === 'check_suite') return text(record(body.check_suite)?.head_branch);
  if (event === 'status') {
    const branches = Array.isArray(body.branches) ? body.branches : [];
    return branches.map((value) => text(record(value)?.name)).find(Boolean);
  }
  return undefined;
}

function checksResult(event: string, body: GitHubRecord): 'passed' | 'failed' | undefined {
  let value: string | undefined;
  if (event === 'check_run') {
    const run = record(body.check_run);
    if (body.action !== 'completed' && run?.status !== 'completed') return undefined;
    value = text(run?.conclusion);
  } else if (event === 'check_suite') {
    const suite = record(body.check_suite);
    if (body.action !== 'completed' && suite?.status !== 'completed') return undefined;
    value = text(suite?.conclusion);
  } else if (event === 'status') {
    value = text(body.state);
  }
  if (value === 'success' || value === 'neutral' || value === 'skipped') return 'passed';
  if (value && value !== 'pending') return 'failed';
  return undefined;
}

function checkFact(event: string, body: GitHubRecord) {
  if (event === 'check_run') {
    const run = record(body.check_run);
    const completed = body.action === 'completed' || run?.status === 'completed';
    const conclusion = text(run?.conclusion);
    return {
      name: text(run?.name) ?? `Check run ${integer(run?.id) ?? ''}`.trim(),
      status: completed
        ? checksResult(event, body) === 'passed'
          ? 'passed'
          : 'failed'
        : 'pending',
      ...(conclusion ? { conclusion } : {}),
      ...(text(run?.html_url) ? { url: text(run?.html_url)! } : {}),
      ...((text(run?.head_sha) ?? text(record(run?.check_suite)?.head_sha))
        ? {
            headSha: (text(run?.head_sha) ?? text(record(run?.check_suite)?.head_sha))!,
          }
        : {}),
    } as const;
  }
  if (event === 'check_suite') {
    const suite = record(body.check_suite);
    const completed = body.action === 'completed' || suite?.status === 'completed';
    const conclusion = text(suite?.conclusion);
    const appName = text(record(suite?.app)?.name);
    return {
      name: appName ? `${appName} check suite` : `Check suite ${integer(suite?.id) ?? ''}`.trim(),
      status: completed
        ? checksResult(event, body) === 'passed'
          ? 'passed'
          : 'failed'
        : 'pending',
      ...(conclusion ? { conclusion } : {}),
      ...(text(suite?.url) ? { url: text(suite?.url)! } : {}),
      ...(text(suite?.head_sha) ? { headSha: text(suite?.head_sha)! } : {}),
    } as const;
  }
  if (event === 'status') {
    const result = checksResult(event, body);
    return {
      name: text(body.context) ?? 'Commit status',
      status: result === 'passed' ? 'passed' : result === 'failed' ? 'failed' : 'pending',
      ...(text(body.description) ? { conclusion: text(body.description)! } : {}),
      ...(text(body.target_url) ? { url: text(body.target_url)! } : {}),
      ...(text(body.sha) ? { headSha: text(body.sha)! } : {}),
    } as const;
  }
  return undefined;
}

interface CornerWebhookTarget {
  corner_id: string;
  parent_id: string;
  author_id: string;
  corner_name: string;
  summary: string;
  repository_id: string;
  installation_id: string;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function mergeConflictKey(number: number, headSha: string, baseSha?: string): string {
  return `merge-conflict:${number}:${headSha}${baseSha ? `:${baseSha}` : ''}`;
}
function challenge(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

export type ReviewerWakeStatus = 'unconfigured' | 'unreachable' | 'waiting' | 'dispatched';

/** Whether the configured reviewer can be / was woken for this corner's current check state. */
export function reviewerWakeFromFacts(input: {
  configuredReviewerId: string | null;
  reviewerHandle: string | null;
  parentMember: boolean;
  cornerMember: boolean;
  lifecycleChecks: string | undefined;
  commandCheckState: string | null;
}): { status: ReviewerWakeStatus; detail: string } {
  const label = input.reviewerHandle ? `@${input.reviewerHandle}` : 'the configured reviewer';
  if (!input.configuredReviewerId) {
    return {
      status: 'unconfigured',
      detail: 'This Room has no configured reviewer, so no agent is woken for review.',
    };
  }
  if (!input.parentMember) {
    return {
      status: 'unreachable',
      detail: `${label} is configured as reviewer but is not a current member of the parent Room, so the checks-passed transition cannot wake them.`,
    };
  }
  if (!input.cornerMember) {
    return {
      status: 'unreachable',
      detail: `${label} is configured as reviewer but is not a current member of this corner, so the checks-passed transition cannot wake them.`,
    };
  }
  if (input.lifecycleChecks === 'passing' && input.commandCheckState === 'passing') {
    return {
      status: 'dispatched',
      detail: `The checks-passed transition woke ${label}.`,
    };
  }
  if (input.lifecycleChecks === 'pending' || input.lifecycleChecks === 'unknown') {
    return {
      status: 'waiting',
      detail: `Checks are still ${input.lifecycleChecks}, so ${label} has not been woken yet.`,
    };
  }
  return {
    status: 'waiting',
    detail: `A review turn has not been dispatched to ${label} yet.`,
  };
}

export class GitHubOperations {
  readonly #key: Buffer;
  constructor(
    private readonly database: SqlDatabase,
    private readonly oauth: GitHubOAuthClient,
    private readonly app: GitHubAppClient,
    clientSecret: string,
    private readonly resolveSealedUserToken?: (subject: string) => Promise<string | undefined>,
    private readonly onRoomChanged?: (roomId: string) => void,
    private readonly institutionalMemory: InstitutionalMemoryShadowConfig = { enabled: false },
  ) {
    this.#key = createHash('sha256').update(clientSecret).digest();
  }

  async beginIdentity(viewerId: string, input: Input<'beginGitHubIdentityBind'>) {
    await this.database.query(
      `INSERT INTO github_auth_flows(state_hash,identity_id,redirect_uri,purpose,expires_at) VALUES($1,$2,$3,'identity',now()+interval '15 minutes')`,
      [hash(input.state), viewerId, input.redirectUri],
    );
    return {
      url: this.oauth.authorizationUrl({
        state: input.state,
        codeChallenge: challenge(input.state),
        redirectUri: input.redirectUri,
      }),
    };
  }

  async completeIdentity(
    viewerId: string,
    input: Input<'completeGitHubIdentityBind'>,
    recover: boolean,
  ) {
    const flow = (
      await this.database.query<{
        redirect_uri: string;
        provider_identity: Record<string, string> | null;
        encrypted_token: string | null;
      }>(
        `SELECT redirect_uri,provider_identity,encrypted_token FROM github_auth_flows WHERE state_hash=$1 AND identity_id=$2 AND purpose='identity' AND consumed_at IS NULL AND expires_at>now()`,
        [hash(input.proof), viewerId],
      )
    ).rows[0];
    if (!flow) throw new Error('GitHub identity flow not found or expired');
    let github = flow.provider_identity;
    let sealed = flow.encrypted_token;
    let exchangedRefresh: string | undefined;
    let exchangedExpiresIn: number | undefined;
    if (!github || !sealed) {
      const exchanged = await this.oauth.exchangeCode(
        input.challenge,
        flow.redirect_uri,
        input.proof,
      );
      github = {
        subject: exchanged.subject,
        login: exchanged.login,
        name: exchanged.displayName ?? exchanged.login,
        issuer: exchanged.issuer,
        audience: exchanged.audience,
      };
      sealed = this.seal(exchanged.accessToken);
      exchangedRefresh = exchanged.refreshToken;
      exchangedExpiresIn = exchanged.tokenExpiresIn;
      await this.database.query(
        `UPDATE github_auth_flows SET provider_identity=$2::jsonb,encrypted_token=$3 WHERE state_hash=$1 AND consumed_at IS NULL`,
        [hash(input.proof), JSON.stringify(github), sealed],
      );
    }
    return this.database.transaction(async (database) => {
      const existing = (
        await database.query<{ identity_id: string }>(
          `SELECT identity_id FROM identity_external_links WHERE provider='github' AND subject=$1`,
          [github!.subject],
        )
      ).rows[0];
      if (existing && existing.identity_id !== viewerId && !recover)
        throw new Error('GitHub identity is already linked');
      if (existing && existing.identity_id !== viewerId) {
        await database.query(`UPDATE identities SET github_subject=NULL WHERE id=$1`, [
          existing.identity_id,
        ]);
        await database.query(
          `INSERT INTO identity_successions(old_identity_id,new_identity_id,provider,subject) VALUES($1,$2,'github',$3) ON CONFLICT(old_identity_id) DO UPDATE SET new_identity_id=EXCLUDED.new_identity_id,subject=EXCLUDED.subject`,
          [existing.identity_id, viewerId, github!.subject],
        );
      }
      await database.query(
        `INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
         VALUES('github',$1,$2,$3,$4,$5)
         ON CONFLICT(provider,subject) DO UPDATE SET
           identity_id=EXCLUDED.identity_id,
           issuer=EXCLUDED.issuer,
           audience=EXCLUDED.audience,
           provider_login=EXCLUDED.provider_login`,
        [github!.subject, viewerId, github!.issuer, GITHUB_IDENTITY_AUDIENCE, github!.login],
      );
      const workspaceIds = await lockIdentityHandleWorkspaces(database, viewerId);
      await reassignCollidingAgentHandles(database, viewerId, github!.login, workspaceIds);
      await database.query(
        `UPDATE identities SET name=COALESCE(NULLIF($2,''),name),
           handle=$3,github_subject=$4,updated_at=now() WHERE id=$1`,
        [viewerId, github!.name, github!.login, github!.subject],
      );
      await database.query(
        `INSERT INTO github_user_tokens(subject,encrypted_token,encrypted_refresh_token,expires_at) VALUES($1,$2,$3,$4) ON CONFLICT(subject) DO UPDATE SET encrypted_token=EXCLUDED.encrypted_token,encrypted_refresh_token=EXCLUDED.encrypted_refresh_token,expires_at=EXCLUDED.expires_at,stale_at=NULL,updated_at=now()`,
        [
          github!.subject,
          sealed,
          exchangedRefresh ? this.seal(exchangedRefresh) : null,
          exchangedExpiresIn ? new Date(Date.now() + exchangedExpiresIn * 1000) : null,
        ],
      );
      await database.query(`UPDATE github_auth_flows SET consumed_at=now() WHERE state_hash=$1`, [
        hash(input.proof),
      ]);
      return {
        personId: viewerId,
        recovered: Boolean(existing && existing.identity_id !== viewerId),
      };
    });
  }

  async beginInstallation(viewerId: string, input: Input<'beginGitHubInstallation'>) {
    const state = randomBytes(32).toString('base64url');
    await this.database.query(
      `INSERT INTO github_auth_flows(state_hash,identity_id,redirect_uri,purpose,expires_at) VALUES($1,$2,$3,'installation',now()+interval '15 minutes')`,
      [hash(state), viewerId, input.redirectUri],
    );
    if (input.installationId) {
      await this.assertInstallationAccess(viewerId, input.installationId);
      await this.syncInstallation(viewerId, input.installationId);
    }
    return { url: this.app.installationUrl(state) };
  }

  async completeInstallation(state: string, installationId: number) {
    return this.database.transaction(async (database) => {
      const flow = (
        await database.query<{ identity_id: string; redirect_uri: string }>(
          `SELECT identity_id,redirect_uri FROM github_auth_flows WHERE state_hash=$1 AND purpose='installation' AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`,
          [hash(state)],
        )
      ).rows[0];
      if (!flow) throw new Error('GitHub installation flow not found or expired');
      await this.assertInstallationAccess(flow.identity_id, installationId, database);
      await this.syncInstallation(flow.identity_id, installationId, database);
      await database.query(`UPDATE github_auth_flows SET consumed_at=now() WHERE state_hash=$1`, [
        hash(state),
      ]);
      const redirect = new URL(flow.redirect_uri);
      redirect.searchParams.set('installed', '1');
      return redirect.toString();
    });
  }

  async refresh(viewerId: string): Promise<{ githubReconnectNeeded?: boolean }> {
    const rows = await this.database.query<{ installation_id: string }>(
      `SELECT installation_id FROM github_installations WHERE owner_id=$1 AND status='active'`,
      [viewerId],
    );
    const installationIds = new Set(rows.rows.map((row) => Number(row.installation_id)));
    const credential = await this.userCredential(viewerId, this.database);
    let githubReconnectNeeded: boolean | undefined = credential?.reconnectNeeded;
    if (credential) {
      let administered: Set<number> | undefined;
      // The token every later user-scoped question must use: a rotation below
      // replaces it, and asking GitHub with the expired one answers nothing.
      let userToken = credential.token;
      try {
        administered = credential.token
          ? await this.listAdministeredInstallations(credential.token)
          : new Set<number>();
      } catch (error) {
        if (githubReconnectNeeded && error instanceof GitHubHttpError && error.status >= 500) {
          administered = undefined;
        } else if (!(error instanceof GitHubHttpError) || error.status !== 401) {
          throw error;
        } else {
          // User-to-server tokens expire after 8 hours; rotate once before giving up.
          const rotated = credential.refreshToken
            ? await this.rotateUserCredential(credential, this.database)
            : undefined;
          if (rotated) {
            userToken = rotated;
            administered = await this.listAdministeredInstallations(rotated);
          } else {
            // Refresh is impossible (no/revoked refresh token): degrade to the stored
            // installations instead of surfacing a 503 to the repo picker.
            administered = undefined;
            githubReconnectNeeded = true;
          }
        }
      }
      if (!credential.token) githubReconnectNeeded = true;
      try {
        const installations = await this.app.listInstallations();
        for (const installation of installations) {
          if (installation.account.type === 'User') {
            // A user-owned install claims only on the App JWT's own identity
            // match: GET /user/installations is the positive confirmation a
            // User account can always provide, so an unavailable listing
            // confirms nothing for it.
            if (administered && installation.account.id === credential.subject) {
              installationIds.add(installation.installationId);
            }
            continue;
          }
          // GET /user/installations is keyed to the lookup token's visibility
          // and cannot list organization installations — the same blindness
          // the install callback accommodates (see the reconciliation gate in
          // apps/auth/src/server-context.ts for the canonical comment). A
          // positively listed organization claims; an UNAVAILABLE listing
          // follows the install-callback precedent and claims an organization
          // nobody else owns yet; a definitive answer without it falls back to
          // MEMBERSHIP (below) before refusing, because the listing's silence
          // about an org install is not evidence of anything.
          const listed = Boolean(administered?.has(installation.installationId));
          if (administered && !listed) {
            // Membership is the user's own answer about their own account, so
            // an active member claims an org install /user/installations left
            // out. Anything else — 'none', an unaccepted invitation, GitHub
            // declining to answer — keeps the refusal this listing implied.
            const membership = userToken
              ? await this.app.organizationMembership(userToken, installation.account.login)
              : 'unknown';
            if (membership !== 'active') continue;
          }
          if (!listed) {
            // Whether discovered by the outage precedent or by membership, an
            // installation another identity already owns stays theirs: this
            // claim adds a viewer, it never steals a row.
            const owner = (
              await this.database.query<{ owner_id: string }>(
                `SELECT owner_id FROM github_installations WHERE installation_id=$1`,
                [installation.installationId],
              )
            ).rows[0]?.owner_id;
            if (owner && owner !== viewerId) continue;
          }
          installationIds.add(installation.installationId);
        }
      } catch (error) {
        if (!githubReconnectNeeded) throw error;
      }
    }
    for (const installationId of installationIds) {
      try {
        await this.syncInstallation(viewerId, installationId);
      } catch (error) {
        if (!githubReconnectNeeded) throw error;
      }
    }
    return { ...(githubReconnectNeeded ? { githubReconnectNeeded } : {}) };
  }

  async createRepository(viewerId: string, input: Input<'createGitHubRepository'>) {
    const installation = (
      await this.database.query<{ account_login: string; account_type: 'User' | 'Organization' }>(
        `SELECT account_login,account_type FROM github_installations WHERE installation_id=$1 AND owner_id=$2 AND status='active'`,
        [input.installationId, viewerId],
      )
    ).rows[0];
    if (!installation) throw new Error('GitHub installation not found');
    const token = (await this.userCredential(viewerId, this.database))?.token;
    const repository = await this.app.createRepository(
      input.installationId,
      { login: installation.account_login, type: installation.account_type },
      {
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        ...(input.private !== undefined ? { private: input.private } : {}),
      },
      token,
    );
    await this.storeRepository(repository, this.database);
    return {
      id: repository.id,
      fullName: repository.fullName,
      installationId: repository.installationId,
      defaultBranch: repository.defaultBranch,
    };
  }

  async roomToken(roomId: string) {
    const row = (
      await this.database.query<{ github_installation_id: string; repository_id: string }>(
        `SELECT r.github_installation_id,g.repository_id FROM rooms r
         JOIN github_repositories g ON g.installation_id=r.github_installation_id
           AND g.active AND lower(g.full_name)=lower(regexp_replace(regexp_replace(
             r.repository_remote,'^(git://|https://)github.com/','','i'), '\\.git$','','i'))
         JOIN github_installations i ON i.installation_id=g.installation_id
         WHERE r.id=$1 AND r.parent_id IS NULL AND r.archived_at IS NULL
           AND r.repository_resolution='repository' AND i.status='active'`,
        [roomId],
      )
    ).rows[0];
    if (!row) throw new Error('GitHub repository installation not found');
    const value = await this.app.installationToken(Number(row.github_installation_id), {
      repositoryIds: [Number(row.repository_id)],
    });
    return { token: value.token, expiresAt: new Date(value.expiresAt).getTime() };
  }

  /**
   * The installation token, repository, and default branch behind a corner or
   * Room addressed by either id.
   *
   * A generated procedure's source Room is the CORNER it came out of, while an
   * installation token is minted for the top-level Room only, so the lookup
   * walks to the corner's parent — the same authority `roomToken` requires. It
   * deliberately does not filter archived Rooms: a code-anchor check runs long
   * after the corner that produced the procedure has been archived away.
   */
  async roomAnchorTarget(roomId: string) {
    const parentId = (
      await this.database.query<{ id: string }>(
        `SELECT COALESCE(parent.id,own.id) id FROM rooms own
         LEFT JOIN rooms parent ON parent.id=own.parent_id
         WHERE own.id=$1`,
        [roomId],
      )
    ).rows[0]?.id;
    if (!parentId) throw new Error('GitHub repository installation not found');
    return this.roomWorkflowTarget(parentId);
  }

  private async roomWorkflowTarget(roomId: string) {
    const row = (
      await this.database.query<{
        github_installation_id: string;
        repository_id: string;
        full_name: string;
        default_branch: string;
      }>(
        `SELECT r.github_installation_id,g.repository_id,g.full_name,g.default_branch
         FROM rooms r
         JOIN github_repositories g ON lower(g.full_name)=lower(regexp_replace(regexp_replace(
           COALESCE(r.repository_remote,r.repository_key,''),
           '^(git://|https://)github.com/','','i'), '\\.git$','','i'))
         JOIN github_installations i ON i.installation_id=g.installation_id
         WHERE r.id=$1 AND r.parent_id IS NULL AND r.archived_at IS NULL
           AND r.github_installation_id=i.installation_id AND g.active AND i.status='active'`,
        [roomId],
      )
    ).rows[0];
    if (!row) throw new Error('GitHub repository installation not found');
    const token = await this.app.installationToken(Number(row.github_installation_id), {
      repositoryIds: [Number(row.repository_id)],
    });
    return {
      token: token.token,
      repository: row.full_name,
      defaultBranch: row.default_branch,
    };
  }

  async listRoomWorkflows(roomId: string) {
    const target = await this.roomWorkflowTarget(roomId);
    const workflows = await this.app.listDispatchableWorkflows(
      target.token,
      target.repository,
      target.defaultBranch,
    );
    return {
      defaultBranch: target.defaultBranch,
      workflows: workflows.map(({ name, lastRunAt, conclusion }) => ({
        name,
        ...(lastRunAt !== undefined ? { lastRunAt } : {}),
        ...(conclusion ? { conclusion } : {}),
      })),
    };
  }

  async dispatchRoomWorkflow(roomId: string, workflowName: string): Promise<void> {
    const name = workflowName.trim();
    if (!name || name.length > 255) throw new Error('invalid workflow name');
    const target = await this.roomWorkflowTarget(roomId);
    const workflows = await this.app.listDispatchableWorkflows(
      target.token,
      target.repository,
      target.defaultBranch,
    );
    const matches = workflows.filter((workflow) => workflow.name === name);
    if (matches.length !== 1) throw new Error('dispatchable workflow not found');
    await this.app.dispatchWorkflow(
      target.token,
      target.repository,
      matches[0]!.id,
      target.defaultBranch,
    );
  }

  /** Caller is authorized by DaemonService against the requesting corner membership. */
  async prChecksStatus(input: { cornerId: string; pullRequest?: number | string }) {
    const corner = (
      await this.database.query<{
        parent_id: string;
        lifecycle: CornerLifecycleView;
        owner_agent_id: string | null;
        command_check_state: string | null;
        configured_reviewer_id: string | null;
        reviewer_identity_id: string | null;
        parent_reviewer_id: string | null;
        corner_reviewer_id: string | null;
        reviewer_handle: string | null;
      }>(
        `SELECT r.parent_id,f.lifecycle,f.owner_agent_id,f.command_check_state,
                parent.reviewer_agent_id configured_reviewer_id,
                reviewer_identity.id reviewer_identity_id,
                parent_member.identity_id parent_reviewer_id,
                corner_member.identity_id corner_reviewer_id,
                reviewer_identity.handle reviewer_handle
         FROM rooms r
         JOIN corner_facts f ON f.corner_id=r.id
         JOIN rooms parent ON parent.id=r.parent_id
         LEFT JOIN identities reviewer_identity ON reviewer_identity.id=parent.reviewer_agent_id
           AND reviewer_identity.kind='agent'
         LEFT JOIN memberships parent_member ON parent_member.room_id=parent.id
           AND parent_member.identity_id=parent.reviewer_agent_id AND parent_member.removed_at IS NULL
         LEFT JOIN memberships corner_member ON corner_member.room_id=r.id
           AND corner_member.identity_id=parent.reviewer_agent_id AND corner_member.removed_at IS NULL
         WHERE r.id=$1`,
        [input.cornerId],
      )
    ).rows[0];
    if (!corner?.parent_id) throw new Error('corner not found');
    const target = await this.roomWorkflowTarget(corner.parent_id);
    const requested = input.pullRequest ?? corner.lifecycle.pr?.number;
    let number: number;
    if (typeof requested === 'number') number = requested;
    else if (typeof requested === 'string') {
      const match = requested.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/i);
      if (!match || match[1]!.toLowerCase() !== target.repository.toLowerCase())
        throw new Error('pull request must belong to the corner Room repository');
      number = Number(match[2]);
    } else throw new Error('specify the pull request number or URL being reviewed');
    if (!Number.isSafeInteger(number) || number <= 0)
      throw new Error('invalid pull request number');
    // Always resolve the head: a force-push must never inherit a green predecessor.
    const pr = await this.app.readPullRequest(target.token, target.repository, number);
    const rollup = await this.app.readCommitCheckRollup(
      target.token,
      target.repository,
      pr.headSha,
    );
    // A completed worker handoff can establish that this head genuinely has no
    // checks. Before that point a null rollup is only the ordinary race between
    // opening a PR and GitHub registering its workflows, so it remains pending.
    const completedWithoutChecks =
      rollup.total === 0 &&
      corner.lifecycle.checks === 'passing' &&
      corner.lifecycle.checksSummary?.total === 0 &&
      corner.lifecycle.pr?.headSha === pr.headSha;
    const checks = completedWithoutChecks ? ('passed' as const) : rollup.state;
    const configuredReviewerId = corner.configured_reviewer_id;
    const approval = await this.database.query(
      `SELECT 1 FROM corner_merge_approvals a JOIN rooms r ON r.id=a.corner_id
       WHERE r.parent_id=$1 AND a.pull_request_number=$2 AND a.head_sha=$3
         AND a.brief_revision IS NOT DISTINCT FROM
           (SELECT max(revision) FROM corner_brief_revisions WHERE corner_id=a.corner_id)
         AND ($4::text IS NULL OR a.approved_by=$4) LIMIT 1`,
      [corner.parent_id, number, pr.headSha, configuredReviewerId],
    );
    // The parent Room's reviewer opened this very corner: no OTHER agent's
    // approve_merge can ever exist for it, so requiring one is a permanent
    // deadlock, not a real gate.
    const reviewerIsAuthor = Boolean(
      configuredReviewerId &&
      corner.owner_agent_id &&
      configuredReviewerId === corner.owner_agent_id,
    );
    const approvalPending = reviewerIsAuthor
      ? false
      : configuredReviewerId
        ? approval.rowCount === 0
        : false;
    const reviewer = corner.reviewer_handle ? `@${corner.reviewer_handle}` : null;
    const reviewerExists = Boolean(configuredReviewerId);
    const reviewerLabel = reviewer ?? 'the configured reviewer';
    const reviewerWake = reviewerWakeFromFacts({
      configuredReviewerId,
      reviewerHandle: corner.reviewer_handle,
      parentMember: Boolean(
        configuredReviewerId && corner.reviewer_identity_id && corner.parent_reviewer_id,
      ),
      cornerMember: Boolean(
        configuredReviewerId && corner.reviewer_identity_id && corner.corner_reviewer_id,
      ),
      lifecycleChecks: corner.lifecycle.checks,
      commandCheckState: corner.command_check_state,
    });
    const rule = reviewerIsAuthor
      ? `You opened this corner and are also this Room's configured reviewer (${reviewerLabel}), so self-review is not required — approve_merge cannot add signal over your own work. The reviewer outcome is PASS; the helper still applies worker yolo mode, human hold, and reviewer-existence conditions.`
      : configuredReviewerId
        ? reviewerWake.status === 'unreachable'
          ? `Only ${reviewerLabel}'s approve_merge records PASS for the reviewer outcome; tagging or asking any other agent to review cannot record an approval or change this verdict. ${reviewerWake.detail} Do not invent a cause and do not poll this gate with a schedule. No Room owner/admin approve control exists in the app yet, so only ${reviewerLabel} can record PASS.`
          : `Only ${reviewerLabel}'s approve_merge records PASS for the reviewer outcome; tagging or asking any other agent to review cannot record an approval or change this verdict. Do not create a schedule to poll this gate — the checks-passed transition wakes ${reviewerLabel} automatically. No Room owner/admin approve control exists in the app yet, so only ${reviewerLabel} can record PASS.`
        : 'This Room has no configured reviewer. The reviewer outcome is not failed, but the complete merge gate still requires reviewerExists=true.';
    return {
      checks,
      checkCount: rollup.total,
      pullRequest: pr.url,
      headSha: pr.headSha,
      approvalPending,
      reviewer,
      reviewerExists,
      reviewerIsAuthor,
      reviewerWake,
      rule,
    };
  }

  async approveCornerMerge(viewerId: string, input: Input<'approveCornerMerge'>) {
    const target = (
      await this.database.query<{
        archived_at: Date | null;
        lifecycle: CornerLifecycleView;
        feature_branch: string | null;
        repository_id: string;
        installation_id: string;
        full_name: string;
      }>(
        `SELECT corner.archived_at,fact.lifecycle,fact.feature_branch,
           repository.repository_id,repository.installation_id,repository.full_name
         FROM rooms corner
         JOIN memberships manager ON manager.room_id=corner.id AND manager.identity_id=$2
           AND manager.role IN ('owner','admin') AND manager.removed_at IS NULL
         JOIN rooms parent ON parent.id=corner.parent_id
         JOIN corner_facts fact ON fact.corner_id=corner.id
         JOIN github_repositories repository ON repository.installation_id=parent.github_installation_id
           AND repository.active AND lower(repository.full_name)=lower(regexp_replace(regexp_replace(
             COALESCE(parent.repository_remote,parent.repository_key,''),
             '^(git://|https://)github.com/','','i'), '\\.git$','','i'))
         WHERE corner.id=$1`,
        [input.cornerId, viewerId],
      )
    ).rows[0];
    if (!target) throw new Error('corner merge access denied');
    const pullRequest = target.lifecycle.pr;
    if (!pullRequest) throw new Error('corner has no pull request to merge');
    if (target.archived_at || target.lifecycle.lifecycle === 'done') {
      return { status: 'already-merged' as const, pullRequestUrl: pullRequest.url };
    }
    if (target.lifecycle.checks === 'failing' && !input.force) {
      const names = target.lifecycle.checksSummary?.failing ?? [];
      throw new Error(
        `corner checks are failing${names.length ? `: ${names.join(', ')}` : ''}; retry with force=true`,
      );
    }
    const recorded = await recordCornerMergeApproval(this.database, {
      cornerId: input.cornerId,
      approvedBy: viewerId,
      force: input.force === true,
      pullRequestNumber: pullRequest.number,
      headSha: pullRequest.headSha,
    });
    if (!recorded) {
      return { status: 'already-requested' as const, pullRequestUrl: pullRequest.url };
    }
    try {
      await this.app.mergePullRequest(
        Number(target.installation_id),
        Number(target.repository_id),
        target.full_name,
        pullRequest.number,
        pullRequest.headSha,
      );
      if (target.feature_branch) {
        await this.app.deleteBranch(
          Number(target.installation_id),
          Number(target.repository_id),
          target.full_name,
          target.feature_branch,
        );
      }
    } catch (error) {
      await this.database.query(
        `DELETE FROM corner_merge_approvals
         WHERE corner_id=$1 AND approved_by=$2 AND pull_request_number=$3 AND head_sha=$4`,
        [input.cornerId, viewerId, pullRequest.number, pullRequest.headSha],
      );
      throw error;
    }
    return { status: 'merge-requested' as const, pullRequestUrl: pullRequest.url };
  }

  async processWebhook(event: string, payload: unknown) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const body = payload as Record<string, unknown>;
    const installation = body.installation;
    if (!installation || typeof installation !== 'object' || Array.isArray(installation)) return;
    const install = installation as Record<string, unknown>;
    if (typeof install.id !== 'number') return;
    if (
      event === 'push' ||
      event === 'issues' ||
      event === 'pull_request' ||
      event === 'check_run' ||
      event === 'check_suite' ||
      event === 'status'
    ) {
      await this.processRepositoryEvent(event, body, install.id);
      await this.processCornerEvent(event, body, install.id);
      if (event === 'push') await this.processBaseBranchPush(body, install.id);
      return;
    }
    if (event === 'installation' && body.action === 'deleted') {
      await this.database.query(
        `UPDATE github_installations SET status='revoked',updated_at=now() WHERE installation_id=$1`,
        [install.id],
      );
      await this.database.query(
        `UPDATE github_repositories SET active=false,updated_at=now() WHERE installation_id=$1`,
        [install.id],
      );
      return;
    }
    if (event === 'installation' && body.action === 'suspend') {
      await this.database.query(
        `UPDATE github_installations SET status='suspended',updated_at=now() WHERE installation_id=$1`,
        [install.id],
      );
      return;
    }
    const existing = (
      await this.database.query<{ owner_id: string }>(
        `SELECT owner_id FROM github_installations WHERE installation_id=$1`,
        [install.id],
      )
    ).rows[0]?.owner_id;
    let owner = existing;
    if (!owner && event === 'installation') {
      const sender = body.sender;
      if (
        sender &&
        typeof sender === 'object' &&
        !Array.isArray(sender) &&
        typeof (sender as Record<string, unknown>).id === 'number'
      )
        owner = (
          await this.database.query<{ identity_id: string }>(
            `SELECT identity_id FROM identity_external_links WHERE provider='github' AND subject=$1`,
            [String((sender as Record<string, unknown>).id)],
          )
        ).rows[0]?.identity_id;
    }
    if (!owner) return;
    if (event === 'installation_repositories') {
      const removed = Array.isArray(body.repositories_removed) ? body.repositories_removed : [];
      const removedIds = removed.flatMap((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
        const id = (entry as Record<string, unknown>).id;
        return typeof id === 'number' && Number.isSafeInteger(id) ? [id] : [];
      });
      if (removedIds.length) {
        await this.database.query(
          `UPDATE github_repositories SET active=false,updated_at=now() WHERE installation_id=$1 AND repository_id=ANY($2::bigint[])`,
          [install.id, removedIds],
        );
      }
    }
    await this.syncInstallation(owner, install.id);
  }

  /** Retry GitHub's asynchronous mergeability calculation for open corner PRs. */
  async refreshUnknownMergeability(cornerId?: string): Promise<void> {
    const rows = await this.database.query<{
      corner_id: string;
      repository: string;
      repository_id: string;
      installation_id: string;
      number: number;
      head_sha: string;
      author_id: string;
      title: string;
      url: string;
      base_sha: string | null;
      target_branch: string;
    }>(
      `SELECT fact.corner_id,github.full_name repository,github.repository_id,
              github.installation_id,(fact.lifecycle->'pr'->>'number')::integer number,
              fact.lifecycle->'pr'->>'headSha' head_sha,
              COALESCE(fact.owner_agent_id,corner.created_by) author_id,
              fact.lifecycle->'pr'->>'title' title,fact.lifecycle->'pr'->>'url' url,
              fact.lifecycle->'pr'->>'baseSha' base_sha,
              fact.lifecycle->'pr'->>'targetBranch' target_branch
       FROM corner_facts fact JOIN rooms corner ON corner.id=fact.corner_id
       JOIN rooms parent ON parent.id=corner.parent_id
       JOIN github_repositories github ON github.installation_id=parent.github_installation_id
         AND github.active AND lower(github.full_name)=lower(regexp_replace(regexp_replace(
           COALESCE(parent.repository_remote,parent.repository_key,''),
           '^(git://|https://)github.com/','','i'), '\\.git$','','i'))
       WHERE corner.archived_at IS NULL AND parent.archived_at IS NULL
         AND COALESCE(fact.owner_agent_id,corner.created_by) IS NOT NULL
         AND fact.lifecycle->'pr'->>'mergeability'='unknown'
         AND fact.lifecycle->'pr'->>'number' ~ '^[0-9]+$'
         AND fact.lifecycle->'pr'->>'headSha' IS NOT NULL
         AND ($1::uuid IS NULL OR fact.corner_id=$1)`,
      [cornerId ?? null],
    );
    for (const row of rows.rows) {
      try {
        const token = await this.app.installationToken(Number(row.installation_id), {
          repositoryIds: [Number(row.repository_id)],
        });
        const pr = await this.app.readPullRequest(token.token, row.repository, row.number);
        if (pr.mergeability === 'unknown') continue;
        if (row.base_sha && row.base_sha !== pr.baseSha) {
          if (
            !pr.baseSha ||
            (await this.app.readBranchHead(token.token, row.repository, row.target_branch)) !==
              pr.baseSha
          )
            continue;
        }
        await this.database.transaction(async (tx) => {
          const current = (
            await tx.query<{ lifecycle: CornerLifecycleView }>(
              `SELECT lifecycle FROM corner_facts WHERE corner_id=$1 FOR UPDATE`,
              [row.corner_id],
            )
          ).rows[0]?.lifecycle;
          if (
            !current?.pr ||
            current.pr.number !== row.number ||
            current.pr.headSha !== pr.headSha ||
            (current.pr.baseSha ?? null) !== row.base_sha ||
            current.pr.mergeability !== 'unknown'
          )
            return;
          await this.updateLifecycle(
            row.corner_id,
            {
              pr: {
                ...current.pr,
                mergeability: pr.mergeability,
                ...(pr.baseSha ? { baseSha: pr.baseSha } : {}),
              },
            },
            tx,
          );
          if (pr.mergeability !== 'dirty') return;
          const conflictKey = mergeConflictKey(row.number, pr.headSha, pr.baseSha);
          const note = await systemLine(tx, {
            id: hash(`beeline:${row.corner_id}:github:${conflictKey}`),
            roomId: row.corner_id,
            authorId: row.author_id,
            subject: GITHUB_SUBJECT,
            verb: 'found merge conflicts in',
            object: {
              text: row.title ?? `pull request #${row.number}`,
              url: row.url,
              headSha: pr.headSha,
            },
            cardType: 'github-corner-note',
            card: { source: 'github', dedupe: conflictKey },
          });
          await queueCornerMergeConflict(tx, row.corner_id, note.id);
          if (note.inserted) this.onRoomChanged?.(row.corner_id);
        });
      } catch (error) {
        console.error(`[server] mergeability refresh failed for corner ${row.corner_id}:`, error);
      }
    }
  }

  /** Recover merged corners when GitHub's closed PR webhook never arrived. */
  async reconcileMergedCorners(): Promise<void> {
    const candidates = await this.database.query<
      CornerWebhookTarget & {
        repository: string;
        branch: string;
        number: number;
        title: string;
        target_branch: string;
      }
    >(
      `SELECT corner.id corner_id,parent.id parent_id,corner.name corner_name,
              COALESCE(fact.owner_agent_id,corner.created_by,parent.created_by) author_id,
              fact.objective summary,github.repository_id,github.installation_id,
              github.full_name repository,fact.feature_branch branch,
              (fact.lifecycle->'pr'->>'number')::integer number,
              fact.lifecycle->'pr'->>'title' title,
              fact.lifecycle->'pr'->>'targetBranch' target_branch
       FROM rooms corner
       JOIN rooms parent ON parent.id=corner.parent_id
       JOIN corner_facts fact ON fact.corner_id=corner.id
       JOIN github_repositories github ON github.installation_id=parent.github_installation_id
         AND github.active AND lower(github.full_name)=lower(regexp_replace(regexp_replace(
           COALESCE(parent.repository_remote,parent.repository_key,''),
           '^(git://|https://)github.com/','','i'), '\\.git$','','i'))
       WHERE corner.archived_at IS NULL AND parent.archived_at IS NULL
         AND parent.github_events_enabled
         AND COALESCE(fact.owner_agent_id,corner.created_by,parent.created_by) IS NOT NULL
         AND fact.feature_branch IS NOT NULL
         AND fact.lifecycle->'pr'->>'number' ~ '^[1-9][0-9]*$'`,
    );
    for (const candidate of candidates.rows) {
      try {
        const token = await this.app.installationToken(Number(candidate.installation_id), {
          repositoryIds: [Number(candidate.repository_id)],
        });
        const pr = await this.app.readPullRequest(
          token.token,
          candidate.repository,
          candidate.number,
        );
        if (!pr.merged || pr.headRef !== candidate.branch) continue;
        await this.mergeCorner(
          candidate,
          {
            repository: candidate.repository,
            branch: candidate.branch,
            title: pr.title ?? candidate.title ?? `Pull request #${candidate.number}`,
            url: pr.url,
            number: candidate.number,
            targetBranch: pr.baseRef ?? candidate.target_branch,
            headSha: pr.headSha,
            ...(pr.mergedAt ? { mergedAt: pr.mergedAt } : {}),
            ...(pr.mergeCommitSha ? { mergeCommitSha: pr.mergeCommitSha } : {}),
            ...(pr.mergedBy ? { mergedBy: pr.mergedBy } : {}),
            commits: 0,
            files: 0,
          },
          this.database,
          candidate.number,
        );
      } catch (error) {
        console.error(
          `[server] merged corner reconciliation failed for ${candidate.corner_id}:`,
          error,
        );
      }
    }
  }

  private async processBaseBranchPush(body: GitHubRecord, installationId: number): Promise<void> {
    const repository = repositoryName(body);
    const branch = branchForEvent('push', body);
    const deliveredSha = text(body.after);
    if (
      !repository ||
      !branch ||
      !deliveredSha ||
      !/^[a-f0-9]{40,64}$/i.test(deliveredSha) ||
      /^0+$/.test(deliveredSha)
    )
      return;
    const affected = await this.database.query<{
      corner_id: string;
      repository_id: string;
      base_sha: string | null;
      head_sha: string;
    }>(
      `SELECT fact.corner_id,github.repository_id,
              fact.lifecycle->'pr'->>'baseSha' base_sha,
              fact.lifecycle->'pr'->>'headSha' head_sha
       FROM corner_facts fact
       JOIN rooms corner ON corner.id=fact.corner_id
       JOIN rooms parent ON parent.id=corner.parent_id
       JOIN github_repositories github ON github.installation_id=$1
         AND lower(github.full_name)=lower($2) AND github.active
       WHERE corner.archived_at IS NULL AND parent.archived_at IS NULL
         AND parent.github_events_enabled AND parent.github_installation_id=$1
         AND lower(regexp_replace(regexp_replace(
           COALESCE(parent.repository_remote,parent.repository_key,''),
           '^(git://|https://)github.com/','','i'), '\\.git$','','i'))=lower($2)
         AND fact.lifecycle->'pr'->>'targetBranch'=$3
         AND fact.lifecycle->'pr'->>'headSha' IS NOT NULL`,
      [installationId, repository, branch],
    );
    if (!affected.rows.length) return;
    const token = await this.app.installationToken(installationId, {
      repositoryIds: [Number(affected.rows[0]!.repository_id)],
    });
    const baseSha = await this.app.readBranchHead(token.token, repository, branch);
    for (const row of affected.rows) {
      let changed = false;
      await this.database.transaction(async (tx) => {
        const lifecycle = (
          await tx.query<{ lifecycle: CornerLifecycleView }>(
            `SELECT lifecycle FROM corner_facts WHERE corner_id=$1 FOR UPDATE`,
            [row.corner_id],
          )
        ).rows[0]?.lifecycle;
        if (
          !lifecycle?.pr ||
          lifecycle.pr.targetBranch !== branch ||
          lifecycle.pr.headSha !== row.head_sha ||
          (lifecycle.pr.baseSha ?? null) !== row.base_sha ||
          lifecycle.pr.baseSha === baseSha
        )
          return;
        await this.updateLifecycle(
          row.corner_id,
          {
            pr: { ...lifecycle.pr, baseSha, mergeability: 'unknown' },
          },
          tx,
        );
        changed = true;
      });
      if (changed) await this.refreshUnknownMergeability(row.corner_id);
    }
  }

  /**
   * Room-level repository activity. Issues and pull requests post on
   * opened/closed. Raw pushes and CI do NOT post: commit churn and
   * mainline check results are not Room conversation. Corner branches
   * stay corner-owned (the corner exclusion below); corners still read
   * CI through processCornerEvent.
   */
  private async processRepositoryEvent(event: string, body: GitHubRecord, installationId: number) {
    if (event !== 'issues' && event !== 'pull_request') return;
    const repository = repositoryName(body);
    if (!repository) return;

    const actor = text(record(body.sender)?.login) || 'github';
    const action = text(body.action);
    if (action !== 'opened' && action !== 'closed') return;
    const subject = record(body[event === 'issues' ? 'issue' : 'pull_request']);
    const title = text(subject?.title)?.trim();
    const url = githubUrl(subject?.html_url);
    if (!title || !url) return;
    const merged = event === 'pull_request' && action === 'closed' && subject?.merged === true;
    const cardAction = merged ? 'merged' : action;
    const branch = event === 'pull_request' ? text(record(subject?.head)?.ref) : undefined;
    const targetBranch = event === 'pull_request' ? text(record(subject?.base)?.ref) : undefined;
    const card = {
      type: (event === 'issues' ? 'issue' : 'pull-request') as 'issue' | 'pull-request',
      action: cardAction,
      actor,
      title,
      url,
      ...(branch ? { branch } : {}),
      ...(targetBranch ? { targetBranch } : {}),
    };
    const dedupeKey = url;

    // Pull-request cards exclude a matching corner branch. Pushes and CI
    // never reach this query: they stay on the corner lifecycle path.
    const rooms = await this.database.query<{ room_id: string; author_id: string }>(
      `SELECT room.id room_id,COALESCE(room.created_by,author.identity_id) author_id
       FROM rooms room
       LEFT JOIN LATERAL(
         SELECT membership.identity_id FROM memberships membership
         WHERE membership.room_id=room.id AND membership.removed_at IS NULL
         ORDER BY membership.joined_at LIMIT 1
       )author ON true
       WHERE room.parent_id IS NULL AND room.archived_at IS NULL
         AND room.github_events_enabled AND room.github_installation_id=$1
         AND COALESCE(room.created_by,author.identity_id) IS NOT NULL
         AND lower(regexp_replace(regexp_replace(
           COALESCE(room.repository_remote,room.repository_key,''),
           '^(git://|https://)github.com/','','i'), '\\.git$','','i'))=lower($2)
         AND ($3::text IS NULL OR NOT EXISTS(
           SELECT 1 FROM rooms corner
           JOIN corner_facts fact ON fact.corner_id=corner.id
           WHERE corner.parent_id=room.id AND fact.feature_branch=$3
         ))`,
      [installationId, repository, branch ?? null],
    );
    for (const room of rooms.rows) {
      const note = await systemLine(this.database, {
        id: hash(`beeline:${room.room_id}:github-event:${event}:${card.action}:${dedupeKey}`),
        roomId: room.room_id,
        authorId: room.author_id,
        subject: { kind: 'github', name: card.actor },
        verb: card.action,
        object: { text: card.title, url: card.url },
        presentation: 'card',
        cardType: 'github-event',
        card,
      });
      if (note.inserted) this.onRoomChanged?.(room.room_id);
    }
  }

  private async processCornerEvent(event: string, body: GitHubRecord, installationId: number) {
    const database = this.database;
    const repository = repositoryName(body);
    const branch = branchForEvent(event, body);
    if (!repository || !branch) return;
    const targets = await this.database.query<CornerWebhookTarget>(
      `SELECT corner.id corner_id,parent.id parent_id,corner.name corner_name,
         COALESCE(owner.identity_id,corner.created_by,parent.created_by) author_id,
         fact.objective summary,
         github.repository_id,github.installation_id
       FROM rooms corner
       JOIN rooms parent ON parent.id=corner.parent_id
       JOIN corner_facts fact ON fact.corner_id=corner.id
       JOIN github_repositories github ON github.installation_id=$1
         AND lower(github.full_name)=lower($2) AND github.active
       LEFT JOIN LATERAL(
         SELECT membership.identity_id FROM memberships membership
         JOIN identities identity ON identity.id=membership.identity_id AND identity.kind='agent'
         WHERE membership.room_id=corner.id AND membership.removed_at IS NULL
         ORDER BY (membership.role='owner') DESC,membership.joined_at LIMIT 1
       )owner ON true
       WHERE corner.archived_at IS NULL AND parent.archived_at IS NULL
         AND parent.github_events_enabled AND fact.feature_branch=$3
         AND parent.github_installation_id=$1
         AND lower(regexp_replace(regexp_replace(
           COALESCE(parent.repository_remote,parent.repository_key,''),
           '^(git://|https://)github.com/','','i'), '\\.git$','','i'))=lower($2)`,
      [installationId, repository, branch],
    );
    const actorLogin = text(record(body.sender)?.login);
    const actor = (login?: string) =>
      login ? { kind: 'github' as const, name: login } : GITHUB_SUBJECT;
    for (const target of targets.rows) {
      if (!target.author_id) continue;
      if (event === 'pull_request') {
        const pullRequest = record(body.pull_request);
        const title =
          text(pullRequest?.title) ?? `Pull request #${integer(pullRequest?.number) ?? ''}`;
        const url = text(pullRequest?.html_url);
        const merged = body.action === 'closed' && pullRequest?.merged === true;
        const number = integer(pullRequest?.number);
        const targetBranch = text(record(pullRequest?.base)?.ref);
        const webhookBaseSha = text(record(pullRequest?.base)?.sha);
        const headSha = text(record(pullRequest?.head)?.sha);
        const mergeabilityValue = text(pullRequest?.mergeable_state);
        let mergeability = githubMergeability(mergeabilityValue);
        if (!merged && url && number && targetBranch && headSha && body.action !== 'closed') {
          await database.transaction(async (tx) => {
            const previous = (
              await tx.query<{ lifecycle: CornerLifecycleView }>(
                `SELECT lifecycle FROM corner_facts WHERE corner_id=$1 FOR UPDATE`,
                [target.corner_id],
              )
            ).rows[0]?.lifecycle;
            const sameHead = previous?.pr?.headSha === headSha;
            const staleBase = Boolean(
              sameHead && previous?.pr?.baseSha && previous.pr.baseSha !== webhookBaseSha,
            );
            if (staleBase) mergeability = previous!.pr!.mergeability ?? 'unknown';
            if (
              !staleBase &&
              mergeability === 'unknown' &&
              sameHead &&
              previous.pr.mergeability &&
              previous.pr.mergeability !== 'unknown'
            )
              mergeability = previous.pr.mergeability;
            const baseSha = staleBase
              ? previous!.pr!.baseSha
              : (webhookBaseSha ?? (sameHead ? previous?.pr?.baseSha : undefined));
            await this.updateLifecycle(
              target.corner_id,
              {
                lifecycle: 'in-review',
                branch,
                pr: {
                  number,
                  url,
                  title,
                  targetBranch,
                  headSha,
                  mergeability,
                  ...(baseSha ? { baseSha } : {}),
                },
              },
              tx,
            );
            if (mergeability === 'dirty') {
              const conflictKey = mergeConflictKey(number, headSha, baseSha);
              const note = await systemLine(tx, {
                id: hash(`beeline:${target.corner_id}:github:${conflictKey}`),
                roomId: target.corner_id,
                authorId: target.author_id,
                subject: GITHUB_SUBJECT,
                verb: 'found merge conflicts in',
                object: { text: title, url, headSha },
                cardType: 'github-corner-note',
                card: { source: 'github', dedupe: conflictKey },
              });
              await queueCornerMergeConflict(tx, target.corner_id, note.id);
              if (note.inserted) this.onRoomChanged?.(target.corner_id);
            }
          });
          if (mergeability === 'unknown') await this.refreshUnknownMergeability(target.corner_id);
        }
        if (merged && url) {
          await this.mergeCorner(
            target,
            {
              repository,
              branch,
              title,
              url,
              ...(number ? { number } : {}),
              ...(targetBranch ? { targetBranch } : {}),
              ...(headSha ? { headSha } : {}),
              ...(text(pullRequest?.merged_at) ? { mergedAt: text(pullRequest?.merged_at)! } : {}),
              ...(text(pullRequest?.merge_commit_sha)
                ? { mergeCommitSha: text(pullRequest?.merge_commit_sha)! }
                : {}),
              ...(text(record(pullRequest?.merged_by)?.login)
                ? { mergedBy: text(record(pullRequest?.merged_by)?.login)! }
                : {}),
              commits: integer(pullRequest?.commits) ?? 0,
              files: integer(pullRequest?.changed_files) ?? 0,
            },
            database,
          );
        } else if (body.action === 'opened' && url) {
          await this.systemNote(
            target.corner_id,
            target.author_id,
            {
              subject: actor(text(record(pullRequest?.user)?.login) ?? actorLogin),
              verb: 'opened a pull request',
              object: { text: title, url },
            },
            `github:pull-request:opened:${url}`,
            database,
          );
        }
        continue;
      }
      if (event === 'push') {
        // Deleting a branch emits an all-zero after SHA. It is not a new head.
        if (body.deleted === true || /^0+$/.test(text(body.after) ?? '')) continue;
        const compare = text(body.compare);
        const commits =
          integer(body.size) ?? (Array.isArray(body.commits) ? body.commits.length : 0);
        const head = text(body.after);
        if (head) {
          const lifecycle = await this.lifecycle(target.corner_id, database);
          await this.updateLifecycle(
            target.corner_id,
            {
              branch,
              checks: 'unknown',
              checksSummary: {
                status: 'unknown',
                total: 0,
                failing: [],
                checks: [],
                updatedAt: Math.floor(Date.now() / 1_000),
              },
              ...(lifecycle.pr ? { pr: { ...lifecycle.pr, headSha: head } } : {}),
            },
            database,
          );
        }
        await this.systemNote(
          target.corner_id,
          target.author_id,
          {
            subject: actor(text(record(body.pusher)?.name) ?? actorLogin),
            verb: 'pushed',
            object: {
              text: `${commits ? `${commits} commit${commits === 1 ? '' : 's'} to ` : ''}${branch}`,
              ...(compare ? { url: compare } : {}),
            },
            ...(head ? { consequence: `at ${head.slice(0, 12)}` } : {}),
          },
          `github:push:${text(body.after) ?? hash(JSON.stringify(body))}`,
          database,
        );
        continue;
      }
      const check = checkFact(event, body);
      const checkHeadSha = check?.headSha;
      if (check && checkHeadSha) {
        await database.transaction(async (database) => {
          // Webhooks are wake-up signals. Serialize refreshes for this corner, then ask GitHub
          // for its current aggregate instead of treating any delivery as the complete verdict.
          const current = (
            await database.query<{ lifecycle: CornerLifecycleView }>(
              `SELECT lifecycle FROM corner_facts WHERE corner_id=$1 FOR UPDATE`,
              [target.corner_id],
            )
          ).rows[0]?.lifecycle;
          if (!current) return;
          // GitHub may deliver a completed run for the previous branch head after a push.
          if (current.pr?.headSha && checkHeadSha !== current.pr.headSha) return;
          const token = await this.app.installationToken(Number(target.installation_id), {
            repositoryIds: [Number(target.repository_id)],
          });
          const rollup = await this.app.readCommitCheckRollup(
            token.token,
            repository,
            checkHeadSha,
          );
          const summary = {
            status:
              rollup.state === 'passed'
                ? ('passing' as const)
                : rollup.state === 'failed'
                  ? ('failing' as const)
                  : ('pending' as const),
            total: rollup.total,
            failing: rollup.failing,
            checks: rollup.checks,
            updatedAt: Math.floor(Date.now() / 1_000),
          };
          await this.updateLifecycle(
            target.corner_id,
            {
              checks: summary.status,
              checksSummary: summary,
            },
            database,
          );
          const label = check.status === 'pending' ? 'started' : check.status;
          const becamePassing = summary.status === 'passing' && current.checks !== 'passing';
          const becameFailing = summary.status === 'failing' && current.checks !== 'failing';
          await this.systemNote(
            target.corner_id,
            target.author_id,
            {
              subject: GITHUB_SUBJECT,
              verb: `${label} a check`,
              // A check that is still running is not yet a fact to react to.
              ...(becamePassing
                ? { kind: 'check-passed' as const }
                : becameFailing
                  ? { kind: 'check-failed' as const }
                  : {}),
              object: {
                text: check.name,
                ...(check.url ? { url: check.url } : {}),
                ...(check.headSha ? { headSha: check.headSha } : {}),
              },
              ...(check.status === 'failed' && check.conclusion && check.conclusion !== 'failure'
                ? { consequence: check.conclusion }
                : {}),
            },
            becamePassing
              ? `github:checks:green:${check.headSha}`
              : `github:checks:${label}:${check.name}:${check.headSha ?? hash(JSON.stringify(body))}`,
            database,
          );
          if (summary.status === 'failing' && !becameFailing)
            await reconcileCornerMergeBlockers(database, target.corner_id);
        });
        await this.refreshUnknownMergeability(target.corner_id);
      }
    }
  }

  private async lifecycle(
    cornerId: string,
    database: SqlDatabase = this.database,
  ): Promise<CornerLifecycleView> {
    return (
      (
        await database.query<{ lifecycle: CornerLifecycleView }>(
          `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`,
          [cornerId],
        )
      ).rows[0]?.lifecycle ?? { lifecycle: 'unknown', checks: 'unknown' }
    );
  }

  private async updateLifecycle(
    cornerId: string,
    patch: Partial<CornerLifecycleView>,
    database: SqlDatabase = this.database,
  ) {
    const previous = await this.lifecycle(cornerId, database);
    const lifecycle = { ...previous, ...patch };
    await database.query(
      `UPDATE corner_facts SET lifecycle=$2::jsonb,
       command_check_state=CASE WHEN lifecycle->>'checks' IS DISTINCT FROM $2::jsonb->>'checks' THEN NULL ELSE command_check_state END,
       updated_at=now() WHERE corner_id=$1`,
      [cornerId, JSON.stringify(lifecycle)],
    );
    // The outcome ledger records the TRANSITION, not the state: a corner that
    // was already green and is re-read green did not reach green again, and a
    // second row would move the measured cohort's clock for nothing.
    if (patch.checks === 'passing' && previous.checks !== 'passing') {
      await recordInstitutionalCornerOutcome(database, {
        cornerId,
        kind: 'ci_green',
        detail: { checks: 'passing' },
      });
    }
  }

  private async systemNote(
    roomId: string,
    authorId: string,
    phrase: SystemPhrase,
    dedupe: string,
    database: SqlDatabase = this.database,
  ) {
    const note = await systemLine(database, {
      id: hash(`beeline:${roomId}:${dedupe}`),
      roomId,
      authorId,
      ...phrase,
      cardType: 'github-corner-note',
      card: { source: 'github', dedupe },
    });
    if (note.inserted) this.onRoomChanged?.(roomId);
    // A previously written green fact can outlive a lost dispatch. Its note
    // remains idempotent, but the command routing must be retried.
    if (!note.inserted && (phrase.kind === 'check-passed' || phrase.kind === 'check-failed'))
      await routeSystemCommand(database, {
        roomId,
        sourceMessageId: note.id,
        kind: phrase.kind,
        targets: [],
      });
  }

  private async mergeCorner(
    target: CornerWebhookTarget,
    pullRequest: {
      repository: string;
      branch: string;
      title: string;
      url: string;
      number?: number;
      targetBranch?: string;
      headSha?: string;
      mergedAt?: string;
      mergeCommitSha?: string;
      mergedBy?: string;
      commits: number;
      files: number;
    },
    database: SqlDatabase = this.database,
    expectedPrNumber?: number,
  ) {
    const mergeKey = `github:pull-request:merged:${pullRequest.url}`;
    let archived = false;
    await database.transaction(async (database) => {
      const currentLifecycle = (
        await database.query<{ lifecycle: CornerLifecycleView }>(
          `SELECT lifecycle FROM corner_facts WHERE corner_id=$1 FOR UPDATE`,
          [target.corner_id],
        )
      ).rows[0]?.lifecycle;
      if (expectedPrNumber && currentLifecycle?.pr?.number !== expectedPrNumber) return;
      const observedChecks = currentLifecycle?.checks;
      const currentPr = currentLifecycle?.pr;
      const mergedPr =
        currentPr ??
        (pullRequest.number && pullRequest.targetBranch && pullRequest.headSha
          ? {
              number: pullRequest.number,
              url: pullRequest.url,
              title: pullRequest.title,
              targetBranch: pullRequest.targetBranch,
              headSha: pullRequest.headSha,
            }
          : undefined);
      const changed = await database.query(
        `UPDATE rooms SET archived_at=now(),updated_at=now()
         WHERE id=$1 AND archived_at IS NULL`,
        [target.corner_id],
      );
      if (!changed.rowCount) return;
      archived = true;
      await database.query(
        `UPDATE corner_facts SET close_requested=true,
           lifecycle=lifecycle||$2::jsonb,
           updated_at=now() WHERE corner_id=$1`,
        [
          target.corner_id,
          JSON.stringify({
            lifecycle: 'done',
            checks: 'passing',
            outcome: 'landed',
            ...(mergedPr
              ? {
                  pr: {
                    ...mergedPr,
                    mergedAt: pullRequest.mergedAt ?? new Date().toISOString(),
                    ...(pullRequest.mergeCommitSha
                      ? { mergeCommitSha: pullRequest.mergeCommitSha }
                      : {}),
                    ...(pullRequest.mergedBy ? { mergedBy: pullRequest.mergedBy } : {}),
                  },
                }
              : {}),
          }),
        ],
      );
      const merged: SystemPhrase = {
        subject: pullRequest.mergedBy
          ? { kind: 'github', name: pullRequest.mergedBy }
          : GITHUB_SUBJECT,
        verb: 'merged',
        kind: 'merged',
        object: { text: pullRequest.title, url: pullRequest.url },
      };
      const mergeNote = await systemLine(database, {
        id: hash(`beeline:${target.corner_id}:${mergeKey}`),
        roomId: target.corner_id,
        authorId: target.author_id,
        ...merged,
        cardType: 'github-corner-note',
        card: { source: 'github', dedupe: mergeKey },
      });
      const targetCommit = pullRequest.mergeCommitSha ?? pullRequest.headSha;
      await recordInstitutionalCornerOutcome(database, {
        cornerId: target.corner_id,
        kind: 'merged',
        detail: {
          repository: pullRequest.repository,
          ...(pullRequest.number !== undefined ? { pullRequestNumber: pullRequest.number } : {}),
          ...(pullRequest.mergeCommitSha ? { mergeCommitSha: pullRequest.mergeCommitSha } : {}),
        },
      });
      if (targetCommit) {
        await enqueueInstitutionalMemoryMergeReview(database, {
          cornerId: target.corner_id,
          sourceMessageId: mergeNote.id,
          repository: pullRequest.repository,
          targetCommit,
          pullRequestUrl: pullRequest.url,
          pullRequestTitle: pullRequest.title,
          objective: target.summary,
          commits: pullRequest.commits,
          files: pullRequest.files,
          checks: observedChecks,
          headSha: pullRequest.headSha ?? mergedPr?.headSha,
          config: this.institutionalMemory,
        });
      }
      const summary = target.summary.trim() || pullRequest.title;
      // The merge summary card in the parent Room: a tap opens the pull request.
      await systemLine(database, {
        id: hash(`beeline:${target.parent_id}:${mergeKey}`),
        roomId: target.parent_id,
        authorId: target.author_id,
        ...merged,
        presentation: 'card',
        durableFact: 'merge',
        cardType: 'daemon-fact',
        card: {
          type: 'corner-complete',
          cornerId: target.corner_id,
          name: target.corner_name,
          objective: summary,
          outcome: 'landed',
          pullRequest: {
            ...(pullRequest.number ? { number: pullRequest.number } : {}),
            title: pullRequest.title,
            url: pullRequest.url,
            ...(pullRequest.targetBranch ? { targetBranch: pullRequest.targetBranch } : {}),
          },
        },
      });
      await reportUnansweredCornerAsks(
        database,
        target.corner_id,
        target.parent_id,
        target.corner_name,
      );
    });
    if (!archived) return;
    this.onRoomChanged?.(target.corner_id);
    this.onRoomChanged?.(target.parent_id);
    try {
      await this.app.deleteBranch(
        Number(target.installation_id),
        Number(target.repository_id),
        pullRequest.repository,
        pullRequest.branch,
      );
    } catch (error) {
      // Archival and the helper close signal are authoritative. Branch cleanup is best-effort.
      console.error(
        `[server] failed to delete merged corner branch ${pullRequest.repository}:${pullRequest.branch}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async syncInstallation(
    viewerId: string,
    installationId: number,
    database: SqlDatabase = this.database,
  ) {
    const account = await this.app.installationAccount(installationId);
    await database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,account_avatar_url,repository_selection,status) VALUES($1,$2,$3,$4,$5,$6,$7,'active') ON CONFLICT(installation_id) DO UPDATE SET owner_id=EXCLUDED.owner_id,account_id=EXCLUDED.account_id,account_login=EXCLUDED.account_login,account_type=EXCLUDED.account_type,account_avatar_url=EXCLUDED.account_avatar_url,repository_selection=EXCLUDED.repository_selection,status='active',updated_at=now()`,
      [
        installationId,
        viewerId,
        account.id,
        account.login,
        account.type,
        account.avatarUrl ?? null,
        account.repositorySelection,
      ],
    );
    const repositories = await this.app.listRepositories(installationId);
    await database.query(
      `UPDATE github_repositories SET active=false,updated_at=now() WHERE installation_id=$1`,
      [installationId],
    );
    for (const repository of repositories) await this.storeRepository(repository, database);
  }
  /**
   * GET /user/installations is keyed to the OAuth lookup token's visibility:
   * user-owned installations always appear, but an unscoped OAuth token
   * generally cannot list ORGANIZATION installations. Production answered that
   * listing with HTTP 404. Treat 404 as unavailable (same as the install
   * callback), never as a throw that aborts refresh.
   */
  private async listAdministeredInstallations(token: string): Promise<Set<number> | undefined> {
    try {
      return new Set(await this.app.listUserInstallationIds(token));
    } catch (error) {
      if (error instanceof GitHubHttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  /**
   * GET /user/installations is keyed to the OAuth lookup token's visibility:
   * user-owned installations always appear, but an unscoped OAuth token
   * generally cannot list ORGANIZATION installations, so demanding a
   * positive match here strands every org install behind an exception or a
   * false negative. For an Organization target, GitHub's state-bound
   * redirect — only the installing admin's browser receives it, bound to
   * this flow's one-time state — is the authority; the listing still refuses
   * when it definitively denies access, and its failures are logged rather
   * than fatal. Canonical comment: apps/auth/src/server-context.ts.
   */
  private async userCanAdministerInstallation(
    token: string,
    installationId: number,
    accountType: 'User' | 'Organization',
  ): Promise<boolean | undefined> {
    try {
      return await this.app.userCanAccessInstallation(token, installationId);
    } catch (error) {
      if (accountType !== 'Organization') throw error;
      console.warn(
        `[server] GitHub installation listing unavailable for organization verification installation=${installationId}:`,
        error instanceof Error ? error.message : String(error),
      );
      return undefined;
    }
  }

  private async assertInstallationAccess(
    viewerId: string,
    installationId: number,
    database: SqlDatabase = this.database,
  ) {
    const account = await this.app.installationAccount(installationId);
    const credential = await this.userCredential(viewerId, database);
    if (!credential?.token) throw new Error('GitHub installation access denied');

    let accessible: boolean | undefined;
    try {
      accessible = await this.userCanAdministerInstallation(
        credential.token,
        installationId,
        account.type,
      );
    } catch (error) {
      const shouldRotate =
        Boolean(credential.refreshToken) &&
        error instanceof GitHubHttpError &&
        error.status === 401;
      if (!shouldRotate) throw error;
      const rotated = await this.rotateUserCredential(credential, database);
      if (!rotated) throw new Error('GitHub installation access denied');
      accessible = await this.userCanAdministerInstallation(rotated, installationId, account.type);
    }

    const accessConfirmed = account.type === 'User' ? accessible === true : accessible !== false;
    if (!accessConfirmed) throw new Error('GitHub installation access denied');
  }
  private async userCredential(
    viewerId: string,
    database: SqlDatabase,
  ): Promise<
    { subject: string; token?: string; refreshToken?: string; reconnectNeeded?: true } | undefined
  > {
    const credential = (
      await database.query<{
        subject: string;
        stale_at: string | Date | null;
        encrypted_token: string | null;
        encrypted_refresh_token: string | null;
        expires_at: string | Date | null;
      }>(
        `SELECT l.subject,t.encrypted_token,t.encrypted_refresh_token,t.expires_at,t.stale_at FROM identity_external_links l LEFT JOIN github_user_tokens t ON t.subject=l.subject WHERE l.provider='github' AND l.identity_id=$1`,
        [viewerId],
      )
    ).rows[0];
    if (!credential) return undefined;
    const sealed =
      credential.encrypted_token ?? (await this.resolveSealedUserToken?.(credential.subject));
    if (!sealed) return { subject: credential.subject };
    const refreshToken = credential.encrypted_refresh_token
      ? this.open(credential.encrypted_refresh_token)
      : undefined;
    if (credential.stale_at && !refreshToken) return { subject: credential.subject };
    const token = this.open(sealed);
    const expiresAt = credential.expires_at ? new Date(credential.expires_at).getTime() : undefined;
    if (
      refreshToken &&
      (credential.stale_at || (expiresAt !== undefined && expiresAt - Date.now() < 60_000))
    ) {
      const rotated = await this.rotateUserCredential(
        { subject: credential.subject, refreshToken },
        database,
      );
      // Do not reuse the consumed refresh grant after proactive rotation.
      return rotated
        ? { subject: credential.subject, token: rotated }
        : { subject: credential.subject };
    }
    return {
      subject: credential.subject,
      token,
      ...(refreshToken ? { refreshToken } : {}),
      ...(!refreshToken && expiresAt !== undefined && expiresAt <= Date.now()
        ? { reconnectNeeded: true as const }
        : {}),
    };
  }
  private async rotateUserCredential(
    credential: { subject: string; refreshToken?: string },
    database: SqlDatabase,
  ): Promise<string | undefined> {
    if (!credential.refreshToken) return undefined;
    return database.transaction(async (database) => {
      // Serialize one-use refresh grants with each other and fresh reconnects.
      const row = (
        await database.query<{
          encrypted_token: string;
          encrypted_refresh_token: string | null;
          stale_at: Date | null;
        }>(
          `SELECT encrypted_token,encrypted_refresh_token,stale_at FROM github_user_tokens WHERE subject=$1 FOR UPDATE`,
          [credential.subject],
        )
      ).rows[0];
      if (!row) return undefined;
      if (
        !row.encrypted_refresh_token ||
        this.open(row.encrypted_refresh_token) !== credential.refreshToken
      ) {
        return this.open(row.encrypted_token);
      }
      try {
        const refreshed = await this.oauth.refreshUserToken(credential.refreshToken);
        await database.query(
          `UPDATE github_user_tokens SET encrypted_token=$2,encrypted_refresh_token=COALESCE($3,encrypted_refresh_token),expires_at=$4,stale_at=NULL,updated_at=now() WHERE subject=$1`,
          [
            credential.subject,
            this.seal(refreshed.accessToken),
            refreshed.refreshToken ? this.seal(refreshed.refreshToken) : null,
            refreshed.tokenExpiresIn
              ? new Date(Date.now() + refreshed.tokenExpiresIn * 1000)
              : null,
          ],
        );
        return refreshed.accessToken;
      } catch (error) {
        if (!(error instanceof GitHubCredentialRejectedError)) throw error;
        await database.query(
          `UPDATE github_user_tokens SET encrypted_refresh_token=NULL,stale_at=now(),updated_at=now() WHERE subject=$1`,
          [credential.subject],
        );
        return undefined;
      }
    });
  }
  private async storeRepository(
    repository: { id: number; installationId: number; fullName: string; defaultBranch: string },
    database: SqlDatabase,
  ) {
    await database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch) VALUES($1,$2,$3,$4) ON CONFLICT(repository_id) DO UPDATE SET installation_id=EXCLUDED.installation_id,full_name=EXCLUDED.full_name,default_branch=EXCLUDED.default_branch,active=true,updated_at=now()`,
      [repository.id, repository.installationId, repository.fullName, repository.defaultBranch],
    );
  }
  private seal(token: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext]
      .map((value) => value.toString('base64url'))
      .join('.');
  }
  private open(sealed: string) {
    const parts = sealed.split('.').map((value) => Buffer.from(value, 'base64url'));
    if (parts.length !== 3 || parts[0]!.length !== 12 || parts[1]!.length !== 16)
      throw new Error('stored GitHub token is invalid');
    const decipher = createDecipheriv('aes-256-gcm', this.#key, parts[0]!);
    decipher.setAuthTag(parts[1]!);
    return Buffer.concat([decipher.update(parts[2]!), decipher.final()]).toString('utf8');
  }
}
