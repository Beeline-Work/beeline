import * as Linking from 'expo-linking';

export function githubSignInRedirectUri(): string {
  return Linking.createURL('buzz/github-callback');
}

export function githubInstallationRedirectUri(): string {
  return Linking.createURL('buzz/github-installation');
}
