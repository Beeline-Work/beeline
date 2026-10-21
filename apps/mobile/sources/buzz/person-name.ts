import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  fallbackPersonName,
  normalizePersonName,
  personHandle,
  type BuzzClient,
  type PersonProfile,
} from '@beeline/buzz-client';

const PREFERRED_PERSON_NAME_PREFIX = '@beeline/person-name/preferred/';
const PERSON_NAME_ONBOARDING_PENDING_KEY = '@beeline/person-name/onboarding-pending';

type PersonNameClient = Pick<
  BuzzClient,
  'getGlobalPersonProfile' | 'getPersonProfile' | 'listCommunities' | 'setGlobalPersonProfile'
>;

function preferredPersonNameKey(pubkey: string): string {
  return `${PREFERRED_PERSON_NAME_PREFIX}${pubkey}`;
}

/** Device copy of the name: a cold-start hint only; a server profile name always replaces it. */
export async function loadPreferredPersonName(pubkey: string): Promise<string | null> {
  try {
    const stored = await AsyncStorage.getItem(preferredPersonNameKey(pubkey));
    return stored ? normalizePersonName(stored) : null;
  } catch {
    return null;
  }
}

async function rememberPreferredPersonName(pubkey: string, name: string): Promise<void> {
  try {
    await savePreferredPersonName(pubkey, name);
  } catch {
    // Device-local hints are optional; relay-backed identity remains authoritative.
  }
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
  try {
    return (await AsyncStorage.getItem(PERSON_NAME_ONBOARDING_PENDING_KEY)) === '1';
  } catch {
    return false;
  }
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
  let globalProfile: PersonProfile | null;
  try {
    globalProfile = await client.getGlobalPersonProfile(pubkey);
  } catch {
    if (stored) return { name: stored, communityId: null, needsPrompt: false };
    globalProfile = null;
  }
  if (globalProfile?.name) {
    const name = globalProfile.name;
    if (stored !== name) await rememberPreferredPersonName(pubkey, name);
    return { name, communityId: null, profile: globalProfile, needsPrompt: false };
  }
  let communities: Awaited<ReturnType<PersonNameClient['listCommunities']>>;
  try {
    communities = await client.listCommunities();
  } catch {
    if (stored) return { name: stored, communityId: null, needsPrompt: false };
    return { name: fallbackPersonName(pubkey), communityId: null, needsPrompt: true };
  }

  for (const community of communities) {
    let profile: PersonProfile | null = null;
    try {
      profile = await client.getPersonProfile(community.communityId, pubkey);
    } catch {
      continue;
    }
    if (profile?.name) {
      const name = profile.name;
      await rememberPreferredPersonName(pubkey, name);
      try {
        const migrated = await client.setGlobalPersonProfile({
          name,
          handle: profile.handle ?? personHandle(name, pubkey),
          avatar: profile.avatar,
        });
        return { name, communityId: community.communityId, profile: migrated, needsPrompt: false };
      } catch {
        return { name, communityId: community.communityId, profile, needsPrompt: false };
      }
    }
  }

  if (stored) {
    try {
      const profile = await client.setGlobalPersonProfile({
        name: stored,
        handle: personHandle(stored, pubkey),
      });
      return { name: stored, communityId: null, profile, needsPrompt: false };
    } catch {
      return { name: stored, communityId: null, needsPrompt: false };
    }
  }

  return {
    name: fallbackPersonName(pubkey),
    communityId: communities[0]?.communityId ?? null,
    needsPrompt: true,
  };
}
