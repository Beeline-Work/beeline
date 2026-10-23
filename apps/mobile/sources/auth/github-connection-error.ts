export function githubConnectionErrorNotice(error: string): { title: string; description: string } {
  if (error === 'github_account_already_linked') return {
    title: 'GitHub account already connected',
    description: 'This GitHub account is linked to a different Beeline account. Sign in with that account, or connect another GitHub account.',
  };
  if (error === 'github_installation_admin_required') return {
    title: 'A GitHub owner needs to connect',
    description: 'Ask a GitHub organization owner to connect this installation, or choose your personal GitHub account.',
  };
  if (error === 'github_account_mismatch') return {
    title: 'Choose your connected GitHub account',
    description: 'Reconnect the GitHub account already linked to this Beeline account.',
  };
  return {
    title: error === 'github_connection_canceled' ? 'GitHub did not finish connecting' : 'GitHub could not connect',
    description: 'Return to your Room, then try Connect GitHub again.',
  };
}

export function githubConnectionErrorMessage(error: string): string {
  return githubConnectionErrorNotice(error).description;
}
