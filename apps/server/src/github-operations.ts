import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { GITHUB_IDENTITY_AUDIENCE, GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import type { PhoneOperationMap } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';

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

interface CornerWebhookTarget {
  corner_id: string;
  parent_id: string;
  author_id: string;
  repository_id: string;
  installation_id: string;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function challenge(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
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
      await database.query(
        `UPDATE identities SET name=COALESCE(NULLIF($2,''),name),handle=$3,github_subject=$4,updated_at=now() WHERE id=$1`,
        [viewerId, github!.name, github!.login, github!.subject],
      );
      await database.query(
        `INSERT INTO github_user_tokens(subject,encrypted_token) VALUES($1,$2) ON CONFLICT(subject) DO UPDATE SET encrypted_token=EXCLUDED.encrypted_token,stale_at=NULL,updated_at=now()`,
        [github!.subject, sealed],
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

  async refresh(viewerId: string): Promise<void> {
    const rows = await this.database.query<{ installation_id: string }>(
      `SELECT installation_id FROM github_installations WHERE owner_id=$1 AND status='active'`,
      [viewerId],
    );
    const installationIds = new Set(rows.rows.map((row) => Number(row.installation_id)));
    const credential = await this.userCredential(viewerId, this.database);
    if (credential) {
      const installations = await this.app.listInstallations();
      const administered = credential.token
        ? new Set(await this.app.listUserInstallationIds(credential.token))
        : new Set<number>();
      for (const installation of installations) {
        if (
          installation.account.type === 'User'
            ? installation.account.id === credential.subject
            : administered.has(installation.installationId)
        ) {
          installationIds.add(installation.installationId);
        }
      }
    }
    for (const installationId of installationIds) {
      await this.syncInstallation(viewerId, installationId);
    }
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
        `SELECT r.github_installation_id,g.repository_id FROM rooms r JOIN github_repositories g ON lower(g.full_name)=lower(regexp_replace(r.repository_remote,'^(git://|https://)github.com/','','i')) JOIN github_installations i ON i.installation_id=g.installation_id WHERE r.id=$1 AND r.github_installation_id=i.installation_id AND g.active AND i.status='active'`,
        [roomId],
      )
    ).rows[0];
    if (!row) throw new Error('GitHub repository installation not found');
    const value = await this.app.installationToken(Number(row.github_installation_id), {
      repositoryIds: [Number(row.repository_id)],
    });
    return { token: value.token, expiresAt: new Date(value.expiresAt).getTime() };
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
      event === 'pull_request' ||
      event === 'check_run' ||
      event === 'check_suite' ||
      event === 'status'
    ) {
      await this.processCornerEvent(event, body, install.id);
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

  private async processCornerEvent(event: string, body: GitHubRecord, installationId: number) {
    const repository = repositoryName(body);
    const branch = branchForEvent(event, body);
    if (!repository || !branch) return;
    const targets = await this.database.query<CornerWebhookTarget>(
      `SELECT corner.id corner_id,parent.id parent_id,
         COALESCE(owner.identity_id,corner.created_by,parent.created_by) author_id,
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
    for (const target of targets.rows) {
      if (!target.author_id) continue;
      if (event === 'pull_request') {
        const pullRequest = record(body.pull_request);
        const title =
          text(pullRequest?.title) ?? `Pull request #${integer(pullRequest?.number) ?? ''}`;
        const url = text(pullRequest?.html_url);
        const merged = body.action === 'closed' && pullRequest?.merged === true;
        if (merged && url) {
          await this.mergeCorner(target, {
            repository,
            branch,
            title,
            url,
            commits: integer(pullRequest?.commits) ?? 0,
            files: integer(pullRequest?.changed_files) ?? 0,
          });
        } else if (body.action === 'opened' && url) {
          await this.systemNote(
            target.corner_id,
            target.author_id,
            `Pull request opened: ${title} — ${url}`,
            `github:pull-request:opened:${url}`,
          );
        }
        continue;
      }
      if (event === 'push') {
        const compare = text(body.compare);
        const commits = Array.isArray(body.commits) ? body.commits.length : 0;
        await this.systemNote(
          target.corner_id,
          target.author_id,
          `Branch updated${commits ? ` with ${commits} commit${commits === 1 ? '' : 's'}` : ''}${compare ? ` — ${compare}` : ''}.`,
          `github:push:${text(body.after) ?? hash(JSON.stringify(body))}`,
        );
        continue;
      }
      const result = checksResult(event, body);
      if (result) {
        const details =
          text(record(body.check_run)?.html_url) ??
          text(record(body.check_suite)?.url) ??
          text(body.target_url);
        await this.systemNote(
          target.corner_id,
          target.author_id,
          `Checks ${result}${details ? ` — ${details}` : ''}.`,
          `github:checks:${result}:${text(record(body.check_run)?.id) ?? text(record(body.check_suite)?.id) ?? text(body.sha) ?? hash(JSON.stringify(body))}`,
        );
      }
    }
  }

  private async systemNote(roomId: string, authorId: string, note: string, dedupe: string) {
    const noteId = hash(`beeline:${roomId}:${dedupe}`);
    const inserted = await this.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
       VALUES($1,$2,$3,$4,'system','github-corner-note',$5::jsonb) ON CONFLICT(id) DO NOTHING`,
      [noteId, roomId, authorId, note, JSON.stringify({ source: 'github', dedupe })],
    );
    if (inserted.rowCount) this.onRoomChanged?.(roomId);
  }

  private async mergeCorner(
    target: CornerWebhookTarget,
    pullRequest: {
      repository: string;
      branch: string;
      title: string;
      url: string;
      commits: number;
      files: number;
    },
  ) {
    const mergeKey = `github:pull-request:merged:${pullRequest.url}`;
    await this.database.transaction(async (database) => {
      const changed = await database.query(
        `UPDATE rooms SET archived_at=now(),updated_at=now()
         WHERE id=$1 AND archived_at IS NULL`,
        [target.corner_id],
      );
      if (!changed.rowCount) return;
      await database.query(
        `UPDATE corner_facts SET close_requested=true,
           lifecycle=lifecycle||'{"lifecycle":"done","checks":"passing"}'::jsonb,
           updated_at=now() WHERE corner_id=$1`,
        [target.corner_id],
      );
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
         VALUES($1,$2,$3,$4,'system','github-corner-note',$5::jsonb) ON CONFLICT(id) DO NOTHING`,
        [
          hash(`beeline:${target.corner_id}:${mergeKey}`),
          target.corner_id,
          target.author_id,
          `Pull request merged: ${pullRequest.title} — ${pullRequest.url}`,
          JSON.stringify({ source: 'github', dedupe: mergeKey }),
        ],
      );
      const commitLabel = `${pullRequest.commits} commit${pullRequest.commits === 1 ? '' : 's'}`;
      const fileLabel = `${pullRequest.files} file${pullRequest.files === 1 ? '' : 's'} changed`;
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,durable_fact,card_type,card)
         VALUES($1,$2,$3,$4,'system','merge','github-corner-note',$5::jsonb) ON CONFLICT(id) DO NOTHING`,
        [
          hash(`beeline:${target.parent_id}:${mergeKey}`),
          target.parent_id,
          target.author_id,
          `Merged ${pullRequest.title} — ${pullRequest.url} (${commitLabel}, ${fileLabel}).`,
          JSON.stringify({ source: 'github', dedupe: mergeKey, cornerId: target.corner_id }),
        ],
      );
    });
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
  private async assertInstallationAccess(
    viewerId: string,
    installationId: number,
    database: SqlDatabase = this.database,
  ) {
    const token = (await this.userCredential(viewerId, database))?.token;
    if (!token || !(await this.app.userCanAccessInstallation(token, installationId)))
      throw new Error('GitHub installation access denied');
  }
  private async userCredential(viewerId: string, database: SqlDatabase) {
    const credential = (
      await database.query<{ subject: string; encrypted_token: string | null }>(
        `SELECT l.subject,t.encrypted_token FROM identity_external_links l LEFT JOIN github_user_tokens t ON t.subject=l.subject AND t.stale_at IS NULL WHERE l.provider='github' AND l.identity_id=$1`,
        [viewerId],
      )
    ).rows[0];
    if (!credential) return undefined;
    const sealed =
      credential.encrypted_token ?? (await this.resolveSealedUserToken?.(credential.subject));
    return {
      subject: credential.subject,
      ...(sealed ? { token: this.open(sealed) } : {}),
    };
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
