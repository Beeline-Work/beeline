import { createHmac, timingSafeEqual } from 'node:crypto';
import { repositoryOnboardingEnabled } from '@beeline/api-contract/phone';

const COOKIE = 'beeline_onboarding';
export function onboardingCookie(subject: string, secret: string, now: number): string {
  const value = `${subject}.${now}`;
  return `${value}.${createHmac('sha256', secret).update(value).digest('hex')}`;
}
export function onboardingCookieSubject(cookie: string | undefined, secret: string, now: number): string | undefined {
  const value = cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  const parts = value?.split('.');
  if (!parts || parts.length !== 3) return undefined;
  const [subject, issued, signature] = parts as [string, string, string];
  if (!/^\d+$/.test(subject) || !/^\d+$/.test(issued) || !/^[a-f0-9]{64}$/.test(signature)) return undefined;
  if (Number(issued) > now || now - Number(issued) > 86_400_000) return undefined;
  const expected = onboardingCookie(subject, secret, Number(issued)).split('.')[2]!;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) && repositoryOnboardingEnabled(subject, process.env) ? subject : undefined;
}
