import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  fallbackPersonName,
  normalizePersonName,
  type BuzzClient,
  type PersonProfile,
} from '@beeline/buzz-client';

const PREFERRED_PERSON_NAME_PREFIX = '@beeline/person-name/preferred/';
const PERSON_NAME_ONBOARDING_PENDING_KEY = '@beeline/person-name/onboarding-pending';

type PersonNameClient = Pick<
  BuzzClient,
  'getPersonProfile' | 'listCommunities' | 'setPersonProfile'
>;

function preferredPersonNameKey(pubkey: string): string {
  return `${PREFERRED_PERSON_NAME_PREFIX}${pubkey}`;
}

export async function loadPreferredPersonName(pubkey: string): Promise<string | null> {
  const stored = await AsyncStorage.getItem(preferredPersonNameKey(pubkey));
  return stored ? normalizePersonName(stored) : null;
}

export async function savePreferredPersonName(pubkey: string, name: string): Promise<string> {
  const normalized = normalizePersonName(name);
  if (!normalized) throw new Error('Choose a name between 1 and 60 characters.');
  await AsyncStorage.setItem(preferredPersonNameKey(pubkey), normalized);
  return normalized;
}

export async function markPersonNameOnboardingPending(): Promise<void> {
  await AsyncStorage.setItem(PERSON_NAME_ONBOARDING_PENDING_KEY, '1');
}

export async function clearPersonNameOnboardingPending(): Promise<void> {
  await AsyncStorage.removeItem(PERSON_NAME_ONBOARDING_PENDING_KEY);
}

export async function isPersonNameOnboardingPending(): Promise<boolean> {
  return (await AsyncStorage.getItem(PERSON_NAME_ONBOARDING_PENDING_KEY)) === '1';
}

export type OnboardingPersonName = {
  name: string;
  communityId: string | null;
  profile?: PersonProfile;
  needsPrompt: boolean;
};

/** Resolve whether this identity already completed naming on this device or relay. */
export async function resolveOnboardingPersonName(
  client: PersonNameClient,
  pubkey: string,
): Promise<OnboardingPersonName> {
  const stored = await loadPreferredPersonName(pubkey);
  if (stored) {
    return { name: stored, communityId: null, needsPrompt: false };
  }
  const communities = await client.listCommunities();

  for (const community of communities) {
    const profile = await client.getPersonProfile(community.communityId, pubkey);
    if (profile?.name) {
      const name = await savePreferredPersonName(pubkey, profile.name);
      return { name, communityId: community.communityId, profile, needsPrompt: false };
    }
  }

  return {
    name: fallbackPersonName(pubkey),
    communityId: communities[0]?.communityId ?? null,
    needsPrompt: true,
  };
}

/** Publish a chosen name without erasing an existing custom person avatar. */
export async function publishPreferredPersonName(
  client: PersonNameClient,
  communityId: string,
  pubkey: string,
  name: string,
): Promise<PersonProfile> {
  const normalized = normalizePersonName(name);
  if (!normalized) throw new Error('Choose a name between 1 and 60 characters.');
  const current = await client.getPersonProfile(communityId, pubkey);
  const profile = await client.setPersonProfile(communityId, {
    name: normalized,
    avatar: current?.avatar,
  });
  await savePreferredPersonName(pubkey, normalized);
  return profile;
}

/** Apply the device's preferred name when entering a Workspace that lacks one. */
export async function ensurePersonNameForWorkspace(
  client: PersonNameClient,
  communityId: string,
  pubkey: string,
): Promise<PersonProfile> {
  const preferred = await loadPreferredPersonName(pubkey);
  const current = await client.getPersonProfile(communityId, pubkey);
  if (current?.name) {
    if (!preferred) await savePreferredPersonName(pubkey, current.name);
    return current;
  }
  return publishPreferredPersonName(
    client,
    communityId,
    pubkey,
    preferred ?? fallbackPersonName(pubkey),
  );
}
