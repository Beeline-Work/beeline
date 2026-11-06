import type {GitHubAppClient} from '@beeline/auth/github';
import type {SqlDatabase} from './database.js';

export type InstallationSnapshot={
  id:number;
  account:Awaited<ReturnType<GitHubAppClient['installationAccount']>>;
  repositories:Awaited<ReturnType<GitHubAppClient['listRepositories']>>;
};

/** GitHub reads precede this batch. The callback supplies its transaction so
 * installation/repository writes commit together without HTTP or query loops. */
export async function storeGitHubInstallations(database:SqlDatabase,viewerId:string,snapshots:readonly InstallationSnapshot[]):Promise<void>{
  const installations=snapshots.map(({id,account})=>({id,account_id:account.id,login:account.login,type:account.type,
    avatar:account.avatarUrl??null,selection:account.repositorySelection}));
  const repositories=[...new Map(snapshots.flatMap(snapshot=>snapshot.repositories).map(repository=>[repository.id,{
    id:repository.id,installation_id:repository.installationId,name:repository.fullName,branch:repository.defaultBranch,
    private:repository.private,auto_merge:repository.allowAutoMerge,
  }])).values()];
  await database.query(`INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,account_avatar_url,repository_selection,status)
    SELECT id,$2,account_id,login,type,avatar,selection,'active'
    FROM jsonb_to_recordset($1::jsonb) installation(id bigint,account_id text,login text,type text,avatar text,selection text)
    ORDER BY id ON CONFLICT(installation_id) DO UPDATE SET owner_id=EXCLUDED.owner_id,account_id=EXCLUDED.account_id,
      account_login=EXCLUDED.account_login,account_type=EXCLUDED.account_type,account_avatar_url=EXCLUDED.account_avatar_url,
      repository_selection=EXCLUDED.repository_selection,status='active',updated_at=now()
    WHERE (github_installations.owner_id,github_installations.account_id,github_installations.account_login,
      github_installations.account_type,github_installations.account_avatar_url,github_installations.repository_selection,github_installations.status)
      IS DISTINCT FROM (EXCLUDED.owner_id,EXCLUDED.account_id,EXCLUDED.account_login,EXCLUDED.account_type,
        EXCLUDED.account_avatar_url,EXCLUDED.repository_selection,EXCLUDED.status)`,[JSON.stringify(installations),viewerId]);
  await database.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch,private,allow_auto_merge)
    SELECT id,installation_id,name,branch,private,auto_merge
    FROM jsonb_to_recordset($1::jsonb) repository(id bigint,installation_id bigint,name text,branch text,private boolean,auto_merge boolean)
    ORDER BY id ON CONFLICT(repository_id) DO UPDATE SET installation_id=EXCLUDED.installation_id,full_name=EXCLUDED.full_name,
      default_branch=EXCLUDED.default_branch,private=EXCLUDED.private,allow_auto_merge=EXCLUDED.allow_auto_merge,active=true,updated_at=now()
    WHERE (github_repositories.installation_id,github_repositories.full_name,github_repositories.default_branch,
      github_repositories.private,github_repositories.allow_auto_merge,github_repositories.active)
      IS DISTINCT FROM (EXCLUDED.installation_id,EXCLUDED.full_name,EXCLUDED.default_branch,EXCLUDED.private,EXCLUDED.allow_auto_merge,true)`,
    [JSON.stringify(repositories)]);
  await database.query(`UPDATE github_repositories SET active=false,updated_at=now()
    WHERE installation_id=ANY($1::bigint[]) AND NOT (repository_id=ANY($2::bigint[])) AND active`,
    [snapshots.map(snapshot=>snapshot.id),repositories.map(repository=>repository.id)]);
}
