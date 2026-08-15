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
    // Device-local migration hints are optional; relay-backed identity remains authoritative.
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
    const name = stored ?? globalProfile.name;
    if (!stored) await rememberPreferredPersonName(pubkey, name);
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

/** Publish a chosen name without erasing an existing custom person avatar. */
export async function publishPreferredPersonName(
  client: PersonNameClient,
  communityId: string,
  pubkey: string,
  name: string,
): Promise<PersonProfile> {
  const normalized = normalizePersonName(name);
  if (!normalized) throw new Error('Choose a name between 1 and 60 characters.');
  const current =
    (await client.getGlobalPersonProfile(pubkey)) ??
    (await client.getPersonProfile(communityId, pubkey));
  const profile = await client.setGlobalPersonProfile({
    name: normalized,
    handle: current?.handle ?? personHandle(normalized, pubkey),
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
  let global: PersonProfile | null = null;
  try {
    global = await client.getGlobalPersonProfile(pubkey);
  } catch {
    // A failed global lookup must not discard an otherwise valid legacy profile.
  }
  if (global?.name) {
    if (!preferred) await rememberPreferredPersonName(pubkey, global.name);
    return global;
  }
  let current: PersonProfile | null = null;
  try {
    current = await client.getPersonProfile(communityId, pubkey);
  } catch {
    // The normal publish path below preserves the previous behavior for a new identity.
  }
  if (current?.name) {
    const name = current.name;
    await rememberPreferredPersonName(pubkey, name);
    try {
      return await client.setGlobalPersonProfile({
        name,
        handle: current.handle ?? personHandle(name, pubkey),
        avatar: current.avatar,
      });
    } catch {
      // Keep the usable Workspace-scoped record when its one-time global migration cannot publish.
      return current;
    }
  }
  return publishPreferredPersonName(
    client,
    communityId,
    pubkey,
    preferred ?? fallbackPersonName(pubkey),
  );
}
