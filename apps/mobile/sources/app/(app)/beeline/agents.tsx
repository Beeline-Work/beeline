import { Redirect, useLocalSearchParams, type Href } from 'expo-router';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Compatibility redirect for old agent-management deep links. */
export default function BuzzAgentsRedirect() {
  const communityId = first(
    useLocalSearchParams<{ communityId?: string | string[] }>().communityId,
  );
  const href = communityId
    ? ({ pathname: '/beeline/members', params: { communityId } } as unknown as Href)
    : ('/beeline/members' as Href);

  return <Redirect href={href} />;
}
