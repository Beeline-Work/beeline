import { cornerLifecycleSql } from './corner-github-cache.js';
import { CommandRefusalError } from './command-refusal.js';
import type { RepositorySignals } from './repository-onboarding.js';
import { cornerFeatureBranchSql } from './corner-branch.js';
import { randomBytes } from 'node:crypto';
import { GITHUB_IDENTITY_AUDIENCE, GitHubHttpError } from '@beeline/auth/github';
import type { SqlDatabase } from './database.js';
import { cornerImplementerSql } from './corner-worker.js';
import { currentCornerBrief } from './corner-brief.js';
import { advanceCorner, lockCornerLifecycle } from './corner-lifecycle.js';
import { GitHubOperations, Input, hash, challenge, record, GitHubRecord, text, integer } from './github-operations.js';



  export async function gitHubOperationsBeginIdentity(ctx: GitHubOperations, viewerId: string, input: Input<'beginGitHubIdentityBind'>) {
    await ctx.database.query(
      `INSERT INTO github_auth_flows(state_hash,identity_id,redirect_uri,purpose,expires_at) VALUES($1,$2,$3,'identity',now()+interval '15 minutes')`,
      [hash(input.state), viewerId, input.redirectUri],
    );
    return {
      url: ctx.oauth.authorizationUrl({
        state: input.state,
        codeChallenge: challenge(input.state),
        redirectUri: input.redirectUri,
      }),
    };
  }


  export async function gitHubOperationsCompleteIdentity(ctx: GitHubOperations,
    viewerId: string,
    input: Input<'completeGitHubIdentityBind'>,
    recover: boolean,
  ) {
    const flow = (
      await ctx.database.query<{
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
      const exchanged = await ctx.oauth.exchangeCode(
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
      sealed = ctx.seal(exchanged.accessToken);
      exchangedRefresh = exchanged.refreshToken;
      exchangedExpiresIn = exchanged.tokenExpiresIn;
      await ctx.database.query(
        `UPDATE github_auth_flows SET provider_identity=$2::jsonb,encrypted_token=$3 WHERE state_hash=$1 AND consumed_at IS NULL`,
        [hash(input.proof), JSON.stringify(github), sealed],
      );
    }
    return ctx.database.transaction(async (database) => {
      const existing = (
        await database.query<{ identity_id: string }>(
          `SELECT identity_id FROM identity_external_links WHERE provider='github' AND subject=$1`,
          [github!.subject],
        )
      ).rows[0];
      const current = (await database.query<{ subject: string }>(`SELECT subject FROM identity_external_links WHERE provider='github' AND identity_id=$1`, [viewerId])).rows[0];
      if (current && current.subject !== github!.subject) throw new Error('github_account_mismatch');
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
      await database.query(
        `UPDATE identities SET github_subject=$2,updated_at=now() WHERE id=$1`,
        [viewerId, github!.subject],
      );
      await database.query(
        `INSERT INTO github_user_tokens(subject,encrypted_token,encrypted_refresh_token,expires_at) VALUES($1,$2,$3,$4) ON CONFLICT(subject) DO UPDATE SET encrypted_token=EXCLUDED.encrypted_token,encrypted_refresh_token=EXCLUDED.encrypted_refresh_token,expires_at=EXCLUDED.expires_at,stale_at=NULL,updated_at=now()`,
        [
          github!.subject,
          sealed,
          exchangedRefresh ? ctx.seal(exchangedRefresh) : null,
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


  export async function gitHubOperationsBeginInstallation(ctx: GitHubOperations, viewerId: string, input: Input<'beginGitHubInstallation'>) {
    const credential = await ctx.userCredential(viewerId, ctx.database);
    const binding = input.reconnect === true || !credential?.token;
    const state = `${binding ? (input.selectTarget ? 'github_bind_org_' : 'github_bind_') : 'repository_install_'}${randomBytes(32).toString('base64url')}`;
    await ctx.database.query(
      `INSERT INTO github_auth_flows(state_hash,identity_id,redirect_uri,purpose,expires_at) VALUES($1,$2,$3,'installation',now()+interval '15 minutes')`,
      [hash(state), viewerId, input.redirectUri],
    );
    if (input.installationId) {
      await ctx.assertInstallationAccess(viewerId, input.installationId);
      await ctx.syncInstallation(viewerId, input.installationId);
    }
    // Use the App's registered OAuth callback, not the final client return URL.
    return { url: binding ? ctx.oauth.authorizationUrl({ state, codeChallenge: challenge(state) }) : ctx.app.installationUrl(state, input.selectTarget) };
  }


  export async function gitHubOperationsCompleteInstallation(ctx: GitHubOperations, state: string, installationId?: number, code?: string, callbackUri?: string) {
    try { return await ctx.database.transaction(async (database) => {
      const flow = (
        await database.query<{ identity_id: string; redirect_uri: string }>(
          `SELECT identity_id,redirect_uri FROM github_auth_flows WHERE state_hash=$1 AND purpose='installation' AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`,
          [hash(state)],
        )
      ).rows[0];
      if (!flow) throw new Error('GitHub installation flow not found or expired');
      if (state.startsWith('github_bind_')) {
        if (!code || !callbackUri) throw new Error('github_connection_canceled');
        const identity = await ctx.oauth.exchangeCode(code, callbackUri, state);
        await database.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`github:${identity.subject}`]);
        await database.query(`SELECT id FROM identities WHERE id=$1 FOR UPDATE`, [flow.identity_id]);
        const links = (await database.query<{ subject: string; identity_id: string }>(
          `SELECT subject,identity_id FROM identity_external_links WHERE provider='github' AND (identity_id=$1 OR subject=$2) FOR UPDATE`,
          [flow.identity_id, identity.subject])).rows;
        if (links.some(link => link.identity_id !== flow.identity_id))
          throw new Error('That GitHub account belongs to another Beeline account. Sign out and continue with GitHub to use it.');
        if (links.some(link => link.subject !== identity.subject)) throw new Error('github_account_mismatch');
        await database.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
          VALUES('github',$1,$2,$3,$4,$5) ON CONFLICT(provider,subject) DO UPDATE SET provider_login=EXCLUDED.provider_login`,
          [identity.subject, flow.identity_id, identity.issuer, GITHUB_IDENTITY_AUDIENCE, identity.login]);
        await database.query(`UPDATE identities SET github_subject=$2,updated_at=now() WHERE id=$1`, [flow.identity_id, identity.subject]);
        await database.query(`INSERT INTO github_user_tokens(subject,encrypted_token,encrypted_refresh_token,expires_at)
          VALUES($1,$2,$3,$4) ON CONFLICT(subject) DO UPDATE SET encrypted_token=EXCLUDED.encrypted_token,
          encrypted_refresh_token=EXCLUDED.encrypted_refresh_token,expires_at=EXCLUDED.expires_at,stale_at=NULL,updated_at=now()`,
          [identity.subject, ctx.seal(identity.accessToken), identity.refreshToken ? ctx.seal(identity.refreshToken) : null,
            identity.tokenExpiresIn ? new Date(Date.now()+identity.tokenExpiresIn*1000) : null]);
      }
      let installationIds: number[];
      if (installationId !== undefined) {
        installationIds = [installationId];
      } else {
        // OAuth-during-install returns an authorization code; the installation id
        // is not required. Discover grants with the original flow owner's token.
        const credential = await ctx.userCredential(flow.identity_id, database);
        if (!credential?.token) throw new Error('GitHub installation access denied');
        installationIds = [...(await ctx.listAdministeredInstallations(credential.token) ?? [])];
        if (!installationIds.length || state.startsWith('github_bind_org_')) {
          if (!state.startsWith('github_bind_')) throw new Error('GitHub installation access denied');
          const nextState = `${state.startsWith('github_bind_org_') ? 'repository_install_' : 'github_bind_'}${randomBytes(32).toString('base64url')}`;
          await database.query(
            `INSERT INTO github_auth_flows(state_hash,identity_id,redirect_uri,purpose,expires_at) VALUES($1,$2,$3,'installation',now()+interval '15 minutes')`,
            [hash(nextState), flow.identity_id, flow.redirect_uri],
          );
          await database.query(`UPDATE github_auth_flows SET consumed_at=now() WHERE state_hash=$1`, [hash(state)]);
          return ctx.app.installationUrl(nextState, state.startsWith('github_bind_org_'));
        }
      }
      let installed = 0;
      for (const id of installationIds) {
        if (state.startsWith('github_bind_')) {
          const account = await ctx.app.installationAccount(id);
          const credential = await ctx.userCredential(flow.identity_id, database);
          const administers = credential?.token && (account.type === 'User' ? account.id === credential.subject
            : await ctx.app.organizationAdmin(credential.token, account.login));
          if (!administers) {
            if (installationId === undefined) continue;
            throw new Error('github_installation_admin_required');
          }
        }
        await ctx.assertInstallationAccess(flow.identity_id, id, database);
        await ctx.syncInstallation(flow.identity_id, id, database);
        installed++;
      }
      if (!installed) throw new Error('github_installation_admin_required');
      await database.query(`UPDATE github_auth_flows SET consumed_at=now() WHERE state_hash=$1`, [
        hash(state),
      ]);
      const redirect = new URL(flow.redirect_uri);
      redirect.searchParams.set('installed', '1');
      return redirect.toString();
    });
    } catch (reason) {
      if (!state.startsWith('github_bind_')) throw reason;
      const flow = (await ctx.database.query<{ redirect_uri: string }>(
        `UPDATE github_auth_flows SET consumed_at=now() WHERE state_hash=$1 AND purpose='installation'
         AND consumed_at IS NULL AND expires_at>now() RETURNING redirect_uri`, [hash(state)])).rows[0];
      if (!flow) throw reason;
      const message = reason instanceof Error ? reason.message : '';
      const error = message === 'github_installation_admin_required' ? message : message === 'github_account_mismatch' ? 'github_account_mismatch'
        : message.startsWith('That GitHub account belongs') ? 'github_account_already_linked'
        : message === 'github_connection_canceled' ? message : 'github_connection_failed';
      const redirect = new URL(flow.redirect_uri);
      redirect.searchParams.set('installed', '0');
      redirect.searchParams.set('error', error);
      return redirect.toString();
    }
  }


  export async function gitHubOperationsRefresh(ctx: GitHubOperations, viewerId: string): Promise<{ githubReconnectNeeded?: boolean }> {
    const rows = await ctx.database.query<{ installation_id: string }>(
      `SELECT installation_id FROM github_installations WHERE owner_id=$1 AND status='active'`,
      [viewerId],
    );
    const installationIds = new Set(rows.rows.map((row) => Number(row.installation_id)));
    const credential = await ctx.userCredential(viewerId, ctx.database);
    let githubReconnectNeeded: boolean | undefined = credential?.reconnectNeeded;
    if (credential) {
      let administered: Set<number> | undefined;
      // The token every later user-scoped question must use: a rotation below
      // replaces it, and asking GitHub with the expired one answers nothing.
      let userToken = credential.token;
      try {
        administered = credential.token
          ? await ctx.listAdministeredInstallations(credential.token)
          : new Set<number>();
      } catch (error) {
        if (githubReconnectNeeded && error instanceof GitHubHttpError && error.status >= 500) {
          administered = undefined;
        } else if (!(error instanceof GitHubHttpError) || error.status !== 401) {
          throw error;
        } else {
          // User-to-server tokens expire after 8 hours; rotate once before giving up.
          const rotated = credential.refreshToken
            ? await ctx.rotateUserCredential(credential, ctx.database)
            : undefined;
          if (rotated) {
            userToken = rotated;
            administered = await ctx.listAdministeredInstallations(rotated);
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
        const installations = await ctx.app.listInstallations();
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
              ? await ctx.app.organizationMembership(userToken, installation.account.login)
              : 'unknown';
            if (membership !== 'active') continue;
          }
          if (!listed) {
            // Whether discovered by the outage precedent or by membership, an
            // installation another identity already owns stays theirs: this
            // claim adds a viewer, it never steals a row.
            const owner = (
              await ctx.database.query<{ owner_id: string }>(
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
        await ctx.syncInstallation(viewerId, installationId);
      } catch (error) {
        if (!githubReconnectNeeded) throw error;
      }
    }
    return { ...(githubReconnectNeeded ? { githubReconnectNeeded } : {}) };
  }


  /** Whether the viewer starred `fullName`; 'unknown' without a usable token or answer. */
  export async function gitHubOperationsRepositoryStarred(ctx: GitHubOperations, viewerId: string, fullName: string): Promise<boolean | 'unknown'> {
    const token = (await ctx.userCredential(viewerId, ctx.database))?.token;
    return token ? ctx.app.repositoryStarred(token, fullName) : 'unknown';
  }


  /** Star `fullName` with the viewer's own token. False when GitHub refuses. */
  export async function gitHubOperationsStarRepository(ctx: GitHubOperations, viewerId: string, fullName: string): Promise<boolean> {
    const token = (await ctx.userCredential(viewerId, ctx.database))?.token;
    return token ? ctx.app.starRepository(token, fullName) : false;
  }


  /** Read signals with the Room's exact-repository installation token. */
  export async function gitHubOperationsOnboardingSignals(ctx: GitHubOperations, roomId: string): Promise<RepositorySignals> {
    const room = (await ctx.database.query<{ repository_name: string; repository_target_branch: string }>(
      `SELECT repository_name,repository_target_branch FROM rooms WHERE id=$1 AND repository_resolution='repository'`, [roomId])).rows[0];
    if (!room) throw new Error('Link a repository before reading starters');
    const token = await ctx.roomToken(roomId);
    const read = (path: string) => ctx.app.issuesRequest(token.token, room.repository_name, 'GET', path);
    const [commitsResult, issuesResult, branchesResult, treeResult] = await Promise.all([
      read(`commits?sha=${encodeURIComponent(room.repository_target_branch)}&per_page=30`).catch(error => {
        if (error instanceof GitHubHttpError && error.status === 409) return [];
        throw error;
      }),
      read('issues?state=open&sort=created&direction=asc&per_page=50'),
      read('branches?per_page=100'),
      read(`git/trees/${encodeURIComponent(room.repository_target_branch)}?recursive=1`).catch(error => {
        if (error instanceof GitHubHttpError && [404, 409].includes(error.status)) return { tree: [] };
        throw error;
      }),
    ]);
    const records = (value: unknown) => Array.isArray(value) ? value.map(record).filter((r): r is GitHubRecord => !!r) : [];
    const commits = await Promise.all(records(commitsResult).slice(0, 10).map(async commit => {
      const sha = text(commit.sha)!;
      const detail = record(await read(`commits/${encodeURIComponent(sha)}`));
      return { sha, message: text(record(commit.commit)?.message) ?? '',
        files: records(detail?.files).map(file => text(file.filename)).filter((p): p is string => !!p) };
    }));
    const head = commits[0]?.sha;
    const checks = head ? await ctx.app.readCommitCheckRollup(token.token, room.repository_name, head) : undefined;
    return {
      commits, failingChecks: checks?.failing ?? [],
      issues: records(issuesResult).filter(issue => !issue.pull_request).map(issue => ({ number: integer(issue.number)!,
        title: text(issue.title) ?? '', bug: records(issue.labels).some(label => /bug/i.test(String(label.name))) })),
      branches: records(branchesResult).map(branch => text(branch.name)).filter((p): p is string => !!p),
      files: records(record(treeResult)?.tree).map(file => text(file.path)).filter((p): p is string => !!p),
    };
  }


  export async function gitHubOperationsCreateRepository(ctx: GitHubOperations, viewerId: string, input: Input<'createGitHubRepository'>, database: SqlDatabase = ctx.database) {
    const installation = (
      await database.query<{ account_login: string; account_type: 'User' | 'Organization' }>(
        `SELECT account_login,account_type FROM github_installations WHERE installation_id=$1 AND owner_id=$2 AND status='active'`,
        [input.installationId, viewerId],
      )
    ).rows[0];
    if (!installation) throw new Error('GitHub installation not found');
    const token = (await ctx.userCredential(viewerId, database))?.token;
    const repository = await ctx.app.createRepository(
      input.installationId,
      { login: installation.account_login, type: installation.account_type },
      {
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        ...(input.private !== undefined ? { private: input.private } : {}),
      },
      token,
    );
    await ctx.storeRepository(repository, database);
    return {
      id: repository.id,
      fullName: repository.fullName,
      installationId: repository.installationId,
      defaultBranch: repository.defaultBranch,
      private: repository.private,
    };
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
  export async function gitHubOperationsRoomAnchorTarget(ctx: GitHubOperations, roomId: string, database: SqlDatabase = ctx.database) {
    const parentId = (
      await database.query<{ id: string }>(
        `SELECT COALESCE(parent.id,own.id) id FROM rooms own
         LEFT JOIN rooms parent ON parent.id=own.parent_id
         WHERE own.id=$1`,
        [roomId],
      )
    ).rows[0]?.id;
    if (!parentId) throw new Error('GitHub repository installation not found');
    return ctx.roomWorkflowTarget(parentId, database);
  }


  export async function gitHubOperationsRoomWorkflowTarget(ctx: GitHubOperations, roomId: string, database: SqlDatabase = ctx.database) {
    const row = (
      await database.query<{
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
    const token = await ctx.app.installationToken(Number(row.github_installation_id), {
      repositoryIds: [Number(row.repository_id)],
    });
    return {
      token: token.token,
      repository: row.full_name,
      defaultBranch: row.default_branch,
      repository_id: row.repository_id,
      installation_id: row.github_installation_id,
    };
  }


  /** Read every PR commit, including coauthors, using the repository installation. */
  export async function gitHubOperationsAssertCornerReviewerNotAuthor(ctx: GitHubOperations, cornerId: string, agentId: string, database: SqlDatabase = ctx.database): Promise<void> {
    const pr = (await database.query<{ number: number | null; head_sha: string | null }>(
      `SELECT lifecycle->'pr'->>'headSha' head_sha,(lifecycle->'pr'->>'number')::int number FROM corner_github_cache WHERE corner_id=$1`, [cornerId],
    )).rows[0];
    if (!pr?.number) return;
    const target = await ctx.roomAnchorTarget(cornerId, database);
    const verifyHead = async () => {
      const live = record(await ctx.app.issuesRequest(target.token, target.repository, 'GET', `pulls/${pr.number}`));
      const count = integer(live?.commits);
      if (!pr.head_sha || record(live?.head)?.sha !== pr.head_sha)
        throw new CommandRefusalError('PR head changed; refresh checks before selecting or approving a reviewer', 409);
      // GitHub's PR commits endpoint exposes at most 250 commits.
      if (!count || count > 250)
        throw new CommandRefusalError('could not verify every PR author; split the PR to at most 250 commits', 409);
      return count;
    };
    const count = await verifyHead();
    let seen = 0;
    const email = `${agentId.slice(0, 16)}@users.noreply.github.com`;
    for (let page = 1; page <= 3; page++) {
      const response = await ctx.app.issuesRequest(target.token, target.repository, 'GET',
        `pulls/${pr.number}/commits?per_page=100&page=${page}`);
      if (!Array.isArray(response)) throw new Error('could not verify PR commit authors');
      seen += response.length;
      for (const value of response) {
        const commit = record(record(value)?.commit);
        const author = record(commit?.author);
        const committer = record(commit?.committer);
        if (typeof author?.email !== 'string' || !author.email || typeof committer?.email !== 'string' || !committer.email
          || typeof commit?.message !== 'string') throw new Error('could not verify PR commit authors');
        if ([author.email, committer.email].some(value => typeof value === 'string' && value.toLowerCase() === email)
          || (typeof commit?.message === 'string' && commit.message.split(/\r?\n/).some(line =>
            /^co-authored-by:\s/i.test(line) && line.trim().toLowerCase().endsWith(`<${email}>`))))
          throw new CommandRefusalError('reviewer must be independent: a PR commit author cannot review its own work', 409);
      }
      if (response.length < 100) {
        if (seen !== count || await verifyHead() !== count) throw new Error('PR commit list changed or is incomplete');
        return;
      }
    }
    throw new Error('could not verify all PR commit authors; select a reviewer after reducing the PR');
  }


  export async function gitHubOperationsListRoomWorkflows(ctx: GitHubOperations, roomId: string) {
    const target = await ctx.roomWorkflowTarget(roomId);
    const workflows = await ctx.app.listDispatchableWorkflows(
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


  export async function gitHubOperationsDispatchRoomWorkflow(ctx: GitHubOperations, roomId: string, workflowName: string): Promise<void> {
    const name = workflowName.trim();
    if (!name || name.length > 255) throw new Error('invalid workflow name');
    if (name === 'Unified production release') throw new Error('Production release requires an agent identity; use the audited release command');
    const target = await ctx.roomWorkflowTarget(roomId);
    const workflows = await ctx.app.listDispatchableWorkflows(
      target.token,
      target.repository,
      target.defaultBranch,
    );
    const matches = workflows.filter((workflow) => workflow.name === name);
    if (matches.length !== 1) throw new Error('dispatchable workflow not found');
    await ctx.app.dispatchWorkflow(
      target.token,
      target.repository,
      matches[0]!.id,
      target.defaultBranch,
    );
  }


  export async function gitHubOperationsDispatchProductionRelease(ctx: GitHubOperations, roomId: string, inputs: Record<string, string>): Promise<void> {
    if (!inputs.dispatched_by) throw new Error('Production release requires an agent identity');
    const target = await ctx.roomAnchorTarget(roomId);
    if (target.repository.toLowerCase() !== 'beeline-work/beeline' || target.defaultBranch !== 'main')
      throw new Error('Production release requires Beeline main');
    await ctx.app.dispatchProductionWorkflow(target.token, target.repository, inputs);
  }


  /** Repair the opened-webhook race before a worker's done report transaction. */
  export async function gitHubOperationsResolveUnregisteredCornerPullRequest(ctx: GitHubOperations, cornerId: string, agentId: string): Promise<void> {
    const corner = (await ctx.database.query<{ parent_id: string; branch: string }>(
      `SELECT room.parent_id,${cornerFeatureBranchSql('room')} branch FROM rooms room
       JOIN corner_facts fact ON fact.corner_id=room.id
       WHERE room.id=$1 AND room.archived_at IS NULL
         AND ${cornerImplementerSql('fact', 'room')}=$2
         AND ${cornerLifecycleSql('fact.corner_id')}->'pr'->>'number' IS NULL`, [cornerId, agentId],
    )).rows[0];
    if (!corner || (await currentCornerBrief(ctx.database, cornerId))?.repositoryWork === false) return;
    const target = await ctx.roomWorkflowTarget(corner.parent_id);
    const numbers = await ctx.app.openPullRequestsForBranch(target.token, target.repository, corner.branch);
    if (numbers.length !== 1) return;
    const pr = await ctx.app.readPullRequest(target.token, target.repository, numbers[0]!);
    if (pr.state !== 'open' || pr.merged || pr.headRef !== corner.branch || !pr.baseRef) return;
    await ctx.database.transaction(async db => {
      await lockCornerLifecycle(db, cornerId);
      // A webhook or close may have won while the provider read was in flight.
      await db.query(`UPDATE corner_github_cache fact SET lifecycle=lifecycle || $3::jsonb
        FROM rooms room WHERE fact.corner_id=$1 AND room.id=fact.corner_id AND room.archived_at IS NULL
          AND ${cornerFeatureBranchSql('room')}=$2 AND fact.lifecycle->'pr'->>'number' IS NULL`,
      [cornerId, corner.branch, JSON.stringify({ lifecycle: 'in-review',
        pr: { number: pr.number, url: pr.url, title: pr.title ?? `Pull request #${pr.number}`,
          headSha: pr.headSha, targetBranch: pr.baseRef, mergeability: 'unknown',
          ...(pr.baseSha ? { baseSha: pr.baseSha } : {}) } })]);
    });
    ctx.onRoomChanged?.(cornerId);
  }


  /** Resolve handoffs against GitHub even when the synchronize webhook is late. */
  export async function gitHubOperationsRefreshCornerReviewHead(ctx: GitHubOperations, cornerId: string): Promise<void> {
    const stored = (await ctx.database.query<{ parent_id: string; number: number; head: string }>(
      `SELECT room.parent_id,(fact.lifecycle->'pr'->>'number')::int number,
         fact.lifecycle->'pr'->>'headSha' head
       FROM rooms room JOIN corner_github_cache fact ON fact.corner_id=room.id
       WHERE room.id=$1 AND room.archived_at IS NULL
         AND fact.lifecycle->'pr'->>'number' IS NOT NULL`, [cornerId],
    )).rows[0];
    if (!stored) return;
    const target = await ctx.roomWorkflowTarget(stored.parent_id);
    const pr = await ctx.app.readPullRequest(target.token, target.repository, stored.number);
    if (pr.state === 'closed' && !pr.merged) {
      await ctx.recordClosedCornerPullRequest(cornerId, stored.number, ctx.database);
      return;
    }
    if (pr.merged || pr.headSha === stored.head) return;
    await ctx.database.transaction(async db => {
      await lockCornerLifecycle(db, cornerId);
      const changed = await db.query(
        `UPDATE corner_github_cache SET lifecycle=jsonb_set(
           jsonb_set(lifecycle-'checksSummary'-'checkRefreshRetry','{pr,headSha}',to_jsonb($4::text)),
           '{checks}','"pending"')
         WHERE corner_id=$1 AND lifecycle->'pr'->>'number'=$2
           AND lifecycle->'pr'->>'headSha'=$3 RETURNING corner_id`,
        [cornerId, String(stored.number), stored.head, pr.headSha],
      );
      if (changed.rowCount) await advanceCorner(db, cornerId,
        { kind: 'push', headSha: pr.headSha, contents: { headSha: pr.headSha } });
    });
  }


  /** Caller is authorized by DaemonService against the requesting corner membership. */
  export function gitHubOperationsPrChecksStatus(ctx: GitHubOperations, input: { cornerId: string; pullRequest?: number | string }, confirmZeroChecks = false) {
    return ctx.ownCheckWork(() => ctx.readPrChecksStatus(input, confirmZeroChecks));
  }
