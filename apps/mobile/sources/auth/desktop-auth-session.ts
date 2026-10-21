import { beginFunnelAttempt, funnelCallback } from './signin-funnel';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { isDesktopShell } from '@/utils/isDesktopShell';

interface AuthSessionResult {
  type: string;
  url?: string;
}

interface AuthUrlSubscription {
  remove(): void;
}

export async function initialAuthUrl(): Promise<string | null> {
  if (!isDesktopShell()) return Linking.getInitialURL();
  const { getCurrent } = await import('@tauri-apps/plugin-deep-link');
  return (await getCurrent())?.find((url) => url.startsWith('beeline://')) ?? null;
}

export async function openAccountAuthSession(
  authorizationUrl: string,
  redirectUri: string,
  options: Record<string, unknown>,
): Promise<AuthSessionResult> {
  // OIDC uses the same observer when enabled. GitHub's resilient wrapper has
  // already attached its context, so repository installation is never counted.
  const url=new URL(authorizationUrl);
  const google=/^\/auth\/(?:oidc|google)\/start$/.test(url.pathname);
  if(google && !url.searchParams.has('funnel')){
    const context=await beginFunnelAttempt('google').catch(()=>undefined);
    if(context)url.searchParams.set('funnel',JSON.stringify(context));
  }
  try {
    if (!isDesktopShell()) {
      const result=await WebBrowser.openAuthSessionAsync(url.toString(), redirectUri, options);
      if(google && result.type==='success') {
        const error=new URL(result.url).searchParams.get('error');
        void funnelCallback(error ? 'error' : 'success',error ? 'provider_error' : undefined);
      }else if(google && (result.type==='cancel' || result.type==='dismiss'))void funnelCallback('cancelled');
      return result;
    }
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url.toString());
    return { type: 'opened' };
  }catch(error){if(google)void funnelCallback('error','unknown');throw error;}
}

export function subscribeToAuthUrls(
  listener: (url: string) => void,
): AuthUrlSubscription | Promise<AuthUrlSubscription> {
  if (!isDesktopShell()) {
    return Linking.addEventListener('url', ({ url }) => listener(url));
  }
  return import('@tauri-apps/plugin-deep-link').then(async ({ onOpenUrl }) => {
    const unlisten = await onOpenUrl((urls) => urls.forEach(listener));
    return { remove: unlisten };
  });
}
