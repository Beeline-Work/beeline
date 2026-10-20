export interface GitHubInstallationAccess {
  installationId: number;
  accountId: string;
  accountLogin: string;
  accountType: 'User' | 'Organization';
  accountAvatarUrl?: string;
  repositorySelection: 'all' | 'selected';
  status: 'active' | 'revoked' | 'suspended';
  repositoryCount: number;
  manageUrl: string;
}
