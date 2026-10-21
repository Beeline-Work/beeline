export function githubConnectionErrorMessage(error: string): string {
  return error === 'github_installation_admin_required'
    ? 'Ask a GitHub organization owner to connect this installation, or choose your personal GitHub account.'
    : error === 'github_account_already_linked'
    ? 'That GitHub account belongs to another Beeline account. Sign out and continue with GitHub to use it.'
    : error === 'github_account_mismatch' ? 'Reconnect the GitHub account already linked to this identity.'
    : error === 'github_connection_canceled' ? 'GitHub connection canceled. Try Connect GitHub again.'
    : 'GitHub could not connect. Try Connect GitHub again.';
}

