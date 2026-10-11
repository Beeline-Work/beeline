/**
 * One agent's git author/committer identity on this host, and the environment
 * that makes git use it.
 *
 * A corner worktree is shared by every agent that works it, and its
 * `git config --worktree user.name/user.email` is rewritten by whichever
 * session prepared it last. Git reads `GIT_AUTHOR_*`/`GIT_COMMITTER_*` before
 * any config, so each session's own environment is what keeps its commits its
 * own regardless of who prepared the worktree.
 */
export interface AgentGitIdentity {
  readonly name: string;
  readonly publicKey: string;
}

export function agentGitIdentity(agent: AgentGitIdentity): { name: string; email: string } {
  return {
    name: agent.name,
    email: `${agent.publicKey.slice(0, 16)}@users.noreply.github.com`,
  };
}

export function agentGitIdentityEnv(agent: AgentGitIdentity): Record<string, string> {
  const { name, email } = agentGitIdentity(agent);
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}