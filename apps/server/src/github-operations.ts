import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import type { PhoneOperationMap } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';

type Input<Name extends keyof PhoneOperationMap> = PhoneOperationMap[Name]['input'];

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
        `INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience) VALUES('github',$1,$2,$3,$4) ON CONFLICT(provider,subject) DO UPDATE SET identity_id=EXCLUDED.identity_id,issuer=EXCLUDED.issuer,audience=EXCLUDED.audience`,
        [github!.subject, viewerId, github!.issuer, github!.audience],
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
    const credential = (
      await this.database.query<{ subject: string; encrypted_token: string | null }>(
        `SELECT l.subject,t.encrypted_token FROM identity_external_links l LEFT JOIN github_user_tokens t ON t.subject=l.subject AND t.stale_at IS NULL WHERE l.provider='github' AND l.identity_id=$1`,
        [viewerId],
      )
    ).rows[0];
    if (credential) {
      const installations = await this.app.listInstallations();
      const administered = credential.encrypted_token
        ? new Set(await this.app.listUserInstallationIds(this.open(credential.encrypted_token)))
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
    const subject = (
      await this.database.query<{ subject: string }>(
        `SELECT subject FROM identity_external_links WHERE provider='github' AND identity_id=$1`,
        [viewerId],
      )
    ).rows[0]?.subject;
    const sealed = subject
      ? (
          await this.database.query<{ encrypted_token: string }>(
            `SELECT encrypted_token FROM github_user_tokens WHERE subject=$1 AND stale_at IS NULL`,
            [subject],
          )
        ).rows[0]?.encrypted_token
      : undefined;
    const repository = await this.app.createRepository(
      input.installationId,
      { login: installation.account_login, type: installation.account_type },
      {
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        ...(input.private !== undefined ? { private: input.private } : {}),
      },
      sealed ? this.open(sealed) : undefined,
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
        `SELECT r.github_installation_id,g.repository_id FROM rooms r JOIN github_repositories g ON lower(g.full_name)=lower(regexp_replace(r.repository_remote,'^(git://|https://)github.com/','','i')) WHERE r.id=$1 AND r.github_installation_id IS NOT NULL AND g.active`,
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
    if (event === 'installation' && body.action === 'deleted') {
      await this.database.query(
        `UPDATE github_installations SET status='revoked',updated_at=now() WHERE installation_id=$1`,
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
    if (owner) await this.syncInstallation(owner, install.id);
  }

  private async syncInstallation(
    viewerId: string,
    installationId: number,
    database: SqlDatabase = this.database,
  ) {
    const account = await this.app.installationAccount(installationId);
    await database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_login,account_type,status) VALUES($1,$2,$3,$4,'active') ON CONFLICT(installation_id) DO UPDATE SET owner_id=EXCLUDED.owner_id,account_login=EXCLUDED.account_login,account_type=EXCLUDED.account_type,status='active',updated_at=now()`,
      [installationId, viewerId, account.login, account.type],
    );
    for (const repository of await this.app.listRepositories(installationId))
      await this.storeRepository(repository, database);
  }
  private async assertInstallationAccess(
    viewerId: string,
    installationId: number,
    database: SqlDatabase = this.database,
  ) {
    const subject = (
      await database.query<{ subject: string }>(
        `SELECT subject FROM identity_external_links WHERE provider='github' AND identity_id=$1`,
        [viewerId],
      )
    ).rows[0]?.subject;
    const sealed = subject
      ? (
          await database.query<{ encrypted_token: string }>(
            `SELECT encrypted_token FROM github_user_tokens WHERE subject=$1 AND stale_at IS NULL`,
            [subject],
          )
        ).rows[0]?.encrypted_token
      : undefined;
    if (!sealed || !(await this.app.userCanAccessInstallation(this.open(sealed), installationId)))
      throw new Error('GitHub installation access denied');
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
