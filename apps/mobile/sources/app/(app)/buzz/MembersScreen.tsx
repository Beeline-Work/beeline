import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Share, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  AGENT_NAME_MAX_LENGTH,
  AGENT_PRESENCE_STALE_MS,
  isAgentPresenceOnline,
  isReasonableAgentName,
  resolveAgentPresenceTier,
  type Agent,
  type AgentModelConfigInput,
  type AgentModelConfigOption,
  type AgentPresence,
  type Community,
  type CommunityMember,
  type CommunityRole,
  type Identity,
  type Nip05VerificationStatus,
  type PersonProfile,
} from '@beeline/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { loadSuccessionPredecessors } from '@/buzz/succession-chain';
import { presenceMapFromSessionEvents } from '@/buzz/agent-presence';
import type { BeelineThemeTokens } from '@/buzz/groknight';
import { resolveAgentDisplayIdentity } from '@/buzz/agent-display';
import { useAgentNameCache } from '@/buzz/agent-name-cache';
import { defaultAgentPersona } from '@/buzz/agent-persona';
import { pickAndUploadAvatar } from '@/buzz/avatar-upload';
import { PHOTO_OVERRIDES_ENABLED } from '@/buzz/photo-overrides';
import { buildCommunityInviteUrl } from '@/buzz/community-invite';
import { profileCacheKey, selectChannelList, useBuzzLocalCache } from '@/buzz/local-cache';
import { seedMembersFromWorkspaceCache } from '@/buzz/members-cache';
import { personIdentityLabel, shortMemberNpub } from '@/buzz/member-display';
import { resolveNip05StatusMap } from '@/buzz/nip05-verification';
import { prepareWorkspaceContext } from '@/buzz/workspace-bootstrap';
import { isWorkspaceManagerRole } from '@/buzz/workspace-role';
import { MEMBERS_GLYPH, MEMBERS_LABEL, ROOM_LABEL } from '@/buzz/vocabulary';
import { BuzzCommunityShell } from '@/components/buzz/CommunityRail';
import { BuzzRigTransport } from '@/sync/transport';
import { Typography } from '@/constants/Typography';
import { HullWaveSignal, MonoButton, PixelLoader } from '@/components/buzz/MonoHull';
import { IdentityMark } from '@/components/buzz/IdentityMark';

const INSTALL_COMMAND = 'curl -fsSL https://usebeeline.app/install | sh';
const PAIR_COMMAND_PREFIX = 'env -u BUZZ_AGENT_KEY -u BUZZ_PRIVATE_KEY beeline pair';

/**
 * Axes offered when the agent has published NO catalog yet (its session has
 * never activated, or the read failed). A missing catalog must not remove
 * the ability to configure a model deliberately — a catalog miss is not
 * evidence a model is unusable (harnesses like pi pass unknown ids through
 * verbatim as custom model ids) — so both axes render with manual entry and
 * no preset options. Model/effort only: never `mode` (the read-only/edit
 * boundary is not user-settable here).
 */
const MODEL_FALLBACK_AXES: AgentModelConfigOption[] = [
  { id: 'model', category: 'model', options: [] },
  { id: 'effort', category: 'effort', options: [] },
];
/**
 * Effort levels offered when the agent has advertised no effort/thought-level
 * axis of its own. A level picker is the ONLY affordance an effort axis ever
 * gets — free-text entry is the wrong shape for a small fixed set, so unlike
 * the model axis there is no custom-id escape here. These three are the
 * common denominator every shipped harness (claude/codex/pi/grok) accepts;
 * once the daemon publishes a real catalog its own levels replace them.
 */
const EFFORT_FALLBACK_LEVELS = ['low', 'medium', 'high'];
/** Under the 45s daemon heartbeat so a just-started agent reads online promptly. */
const AGENT_PRESENCE_REFRESH_MS = 30_000;
/** How long an admin action waits for the connect handshake before failing honestly. */
const CONNECTION_WAIT_TIMEOUT_MS = 15_000;
const CONNECTING_MESSAGE = 'Still connecting to the relay. Try again in a moment.';

/** The relay-backed context every admin write needs; only exists once init lands. */
type WorkspaceConnection = { transport: BuzzRigTransport; communityId: string };

/**
 * Which admin action is in flight, so only the tapped control animates.
 *
 * This screen used to hold one shared `working` boolean, which every handler
 * set and three `MonoButton`s read as `loading` — so tapping "Add agent"
 * pulsed "Invite person" (and relabelled it "Creating invite") at the same
 * time. The concurrency intent is unchanged: any action in flight still
 * disables every other control; only the spinner and the busy label are
 * narrowed to the action the person actually tapped.
 */
type MembersAction =
  | 'add-agent'
  | 'invite-person'
  | 'person-role'
  | 'remove-person'
  | 'save-soul'
  | 'change-avatar'
  | 'reset-avatar'
  | 'remove-agent'
  | 'message-agent';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Every rejection is surfaced through the awaiting handler's own `error`
  // state. This keeps a deferred nobody happened to await from tripping the
  // unhandled-rejection warning.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function awaitWithin<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (caught) => {
        clearTimeout(timer);
        reject(caught);
      },
    );
  });
}

function roleLabel(role: CommunityRole): string {
  return role.toUpperCase();
}

/** Owner and admin each carry a distinct accent; member stays neutral. */
function roleAccentColor(role: CommunityRole, palette: BeelineThemeTokens): string {
  if (role === 'owner') return palette.accent;
  if (role === 'admin') return palette.chrome;
  return palette.textMuted;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default function BuzzAgents() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    communityId?: string | string[];
    action?: string | string[];
  }>();
  const requestedCommunityId = first(params.communityId);
  const requestedAction = first(params.action);
  // Seeded synchronously from the same Workspace roster cache the Room list
  // already warms (`channelLists`), so this screen paints from whatever the
  // app already knows on first frame instead of blocking on a fresh relay
  // read. Never awaited — a cold cache just falls back to `loading`.
  const initialCacheState = useBuzzLocalCache.getState();
  const initialCachedList = selectChannelList(
    initialCacheState,
    initialCacheState.activeViewerPubkey,
    requestedCommunityId,
  );
  const initialCommunityId = requestedCommunityId ?? initialCachedList?.communityId ?? null;
  // The cached roster is built for the Rooms screen and omits the viewer by
  // construction ("who else is here"), so the viewer is handed in explicitly —
  // otherwise the reader is painted out of their own Workspace, and in a
  // Personal Workspace, where they are the only person, out of it entirely.
  // `viewerIsAgent` keeps an agent identity out of the people list.
  const cachedViewerPubkey = initialCacheState.activeViewerPubkey;
  const initialCachedSeed = seedMembersFromWorkspaceCache(
    initialCachedList?.workspaceMembers ?? [],
    cachedViewerPubkey && !initialCachedList?.viewerIsAgent
      ? { pubkey: cachedViewerPubkey }
      : undefined,
  );
  const initialCachedProfiles =
    initialCacheState.activeViewerPubkey && initialCommunityId
      ? (initialCacheState.profiles[
          profileCacheKey(initialCacheState.activeViewerPubkey, initialCommunityId)
        ] ?? [])
      : [];
  const [communityId, setCommunityId] = useState<string | null>(initialCommunityId);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [transport, setTransport] = useState<BuzzRigTransport | null>(null);
  const [communities, setCommunities] = useState<Community[]>(initialCachedList?.communities ?? []);
  const [agents, setAgents] = useState<Agent[]>(initialCachedSeed.agents);
  const [people, setPeople] = useState<CommunityMember[]>(initialCachedSeed.people);
  const [profiles, setProfiles] = useState<PersonProfile[]>(initialCachedProfiles);
  const [nip05Status, setNip05Status] = useState<Map<string, Nip05VerificationStatus>>(new Map());
  const [loading, setLoading] = useState(!initialCachedList);
  const [working, setWorking] = useState<MembersAction | null>(null);
  /** Any admin action in flight — every control is gated on this, as before. */
  const busy = working !== null;
  const [error, setError] = useState<string | null>(null);
  const [pairCommand, setPairCommand] = useState<string | null>(null);
  const [pairExpiresAt, setPairExpiresAt] = useState<number | null>(null);
  const [selectedPubkey, setSelectedPubkey] = useState<string | null>(null);
  const [soul, setSoul] = useState('');
  const [name, setName] = useState('');
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>();
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [roleEditorPubkey, setRoleEditorPubkey] = useState<string | null>(null);
  const [viewerAvatarUrl, setViewerAvatarUrl] = useState<string | undefined>();
  const [canManageWorkspace, setCanManageWorkspace] = useState(
    initialCachedList?.canEditWorkspaceAvatar ?? false,
  );
  const [agentPresences, setAgentPresences] = useState<Record<string, AgentPresence>>({});
  /**
   * False until a presence read has actually answered.
   *
   * An empty presence map is UNKNOWN, not an offline verdict — the same rule
   * the Room banner already follows (`isAgentOfflineAfterPresenceResolved`).
   * This screen asserted OFFLINE from an empty map, so an agent read as down
   * whenever the read had not happened yet or had failed: a stalled mount
   * effect, a thrown query, a relay blip. Saying nothing is the honest answer
   * to a question nobody has asked the relay.
   */
  const [presenceResolved, setPresenceResolved] = useState(false);
  const [presenceNow, setPresenceNow] = useState(Date.now());
  const [modelCatalog, setModelCatalog] = useState<AgentModelConfigOption[] | null>(null);
  /** The agent's own effective selection from its published catalog — this is
   * where a CLI (`beeline pair --model/--effort`) configuration surfaces. */
  const [agentSelection, setAgentSelection] = useState<AgentModelConfigInput | null>(null);
  const [modelSelection, setModelSelection] = useState<AgentModelConfigInput | null>(null);
  const [modelConfigWorking, setModelConfigWorking] = useState(false);
  const [openModelAxis, setOpenModelAxis] = useState<string | null>(null);
  /** Which axis has its free-text custom-id entry open, and what it holds. */
  const [customModelAxis, setCustomModelAxis] = useState<string | null>(null);
  const [customModelText, setCustomModelText] = useState('');
  const pairingBaseline = useRef<Set<string>>(new Set());
  const pairingPending = useRef(false);
  const requestedActionHandled = useRef(false);
  // The screen paints from the Workspace roster cache, so an owner's admin
  // controls are on screen before the init effect has built a transport. A
  // handler must therefore never read a null transport as "not allowed" —
  // that silently swallowed every tap for the whole connect window, and
  // forever if init threw. Handlers await this instead; it is created
  // synchronously at effect start, resolved where the transport lands, and
  // rejected with the real error if init fails.
  const connectionRef = useRef<Deferred<WorkspaceConnection> | null>(null);

  const activeCommunity = useMemo(
    () => communities.find((community) => community.communityId === communityId) ?? null,
    [communities, communityId],
  );
  const selected = useMemo(
    () => agents.find((agent) => agent.pubkey === selectedPubkey) ?? null,
    [agents, selectedPubkey],
  );
  const profileByPubkey = useMemo(
    () => new Map(profiles.map((profile) => [profile.pubkey, profile])),
    [profiles],
  );

  useEffect(() => {
    let cancelled = false;
    resolveNip05StatusMap(profiles.map((profile) => ({ pubkey: profile.pubkey, nip05: profile.nip05 })))
      .then((map) => {
        if (!cancelled) setNip05Status(map);
      })
      .catch(() => {
        // A failed verification round leaves labels on their non-nip05 fallback; never fatal.
      });
    return () => {
      cancelled = true;
    };
  }, [profiles]);

  const refreshAgents = useCallback(async (currentTransport: BuzzRigTransport, id: string) => {
    const client = await currentTransport.ensureClient();
    const next = await client.listAgents(id);
    // Warm the device-wide agent-name store with the freshest souls.
    useAgentNameCache.getState().rememberAgents(next);
    setAgents(next);
    if (pairingPending.current) {
      const arrival = next.find((agent) => !pairingBaseline.current.has(agent.pubkey));
      if (arrival) {
        pairingPending.current = false;
        setPairCommand(null);
        setPairExpiresAt(null);
        setSelectedPubkey(arrival.pubkey);
        const fallback = defaultAgentPersona(arrival.pubkey);
        setName(arrival.soulProfile?.name ?? fallback.name);
        setSoul(arrival.soulProfile?.soul ?? fallback.soul);
        setAvatarUrl(arrival.soulProfile?.avatar ?? arrival.avatar);
      }
    }
  }, []);

  /**
   * Who this screen lists under People — the read's answer, plus the reader.
   *
   * The viewer is a member of the Workspace they are reading: they are looking
   * at it, and the relay's own projection lists them. But every INPUT to this
   * list can independently fail to say so — the roster cache omits them by
   * construction (it is built for the Rooms screen's "who else is here"), a
   * mount effect that has not finished has not read anything yet, and a failed
   * read leaves the previous answer standing. Two rounds of fixes went into
   * those inputs and the surface still showed "People 0" to the owner of a
   * Personal Workspace, where they are the only person and so the entire
   * section.
   *
   * So the invariant is enforced HERE, where it is stated, rather than in one
   * of the several places that feed it: identity is local and already loaded,
   * `agents` says whether this identity is an agent rather than a person, and
   * neither depends on a relay read landing.
   */
  const visiblePeople = useMemo<CommunityMember[]>(() => {
    // `identity` is set BY the mount effect, so relying on it alone reproduces
    // the very dependency this invariant exists to escape: a stalled effect
    // means no identity means no viewer. The cache's active viewer is written
    // at sign-in and is available synchronously on the first frame.
    const viewerPubkey = identity?.publicKey ?? cachedViewerPubkey;
    if (!viewerPubkey) return people;
    if (people.some((person) => person.pubkey === viewerPubkey)) return people;
    if (agents.some((agent) => agent.pubkey === viewerPubkey)) return people;
    // Least-privileged until a real read says otherwise, matching the seed's
    // own rule: a placeholder may under-grant an admin-gated action, never
    // over-grant one.
    return [{ pubkey: viewerPubkey, role: 'member' as const }, ...people];
  }, [agents, cachedViewerPubkey, identity?.publicKey, people]);

  const refreshPeople = useCallback(async (
    currentTransport: BuzzRigTransport,
    id: string,
    viewerPubkey?: string,
  ) => {
    const client = await currentTransport.ensureClient();
    const [allMembers, knownAgents] = await Promise.all([
      client.communityMembers(id),
      client.listAgents(id),
    ]);
    const agentPubkeys = new Set(knownAgents.map((agent) => agent.pubkey));
    const nextPeople = allMembers.filter((member) => !agentPubkeys.has(member.pubkey));
    const nextProfiles = await client.listPersonProfiles(
      id,
      nextPeople.map((member) => member.pubkey),
    );
    setPeople(nextPeople);
    setProfiles(nextProfiles);
    if (viewerPubkey) {
      const viewerRole = allMembers.find((member) => member.pubkey === viewerPubkey)?.role;
      setCanManageWorkspace(isWorkspaceManagerRole(viewerRole));
    }
  }, []);

  /**
   * Presence is published per (agent, Room), not per Workspace — this
   * directory has no single Room context, unlike a Corner list or Room
   * roster. Fan the read across every Room the Workspace has and keep only
   * the newest record per agent; an agent with no live daemon anywhere
   * correctly yields no record, i.e. offline.
   */
  const refreshAgentPresence = useCallback(
    async (currentTransport: BuzzRigTransport, id: string) => {
      const events = await currentTransport.agentPresenceBackfillForWorkspace(id);
      setAgentPresences(presenceMapFromSessionEvents(events));
      setPresenceNow(Date.now());
      // Only a read that actually answered may license an OFFLINE verdict.
      // Deliberately after the await: a throw leaves this false, so a failed
      // read reports "unknown" rather than accusing every agent of being down.
      setPresenceResolved(true);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    let pairingInterval: ReturnType<typeof setInterval> | undefined;
    let presenceInterval: ReturnType<typeof setInterval> | undefined;
    const connection = createDeferred<WorkspaceConnection>();
    connectionRef.current = connection;
    void (async () => {
      try {
        const currentIdentity = await loadBuzzIdentity();
        if (!currentIdentity) {
          router.replace('/buzz/onboarding');
          return;
        }
        const relayUrl = await getEffectiveRelayUrl();
        const nextTransport = new BuzzRigTransport(currentIdentity, relayUrl);
        const client = await nextTransport.ensureClient();
        const { workspaces: available, activeWorkspaceId } = await prepareWorkspaceContext(
          client,
          currentIdentity.publicKey,
          requestedCommunityId,
          undefined,
          {
            loadPredecessors: () => loadSuccessionPredecessors(relayUrl, currentIdentity),
          },
        );
        const [listed, viewerProfile, allMembers] = await Promise.all([
          client.listAgents(activeWorkspaceId),
          client.getPersonProfile(activeWorkspaceId, currentIdentity.publicKey),
          client.communityMembers(activeWorkspaceId),
        ]);
        if (cancelled) return;
        connection.resolve({ transport: nextTransport, communityId: activeWorkspaceId });
        setIdentity(currentIdentity);
        setTransport(nextTransport);
        setCommunities(available);
        setCommunityId(activeWorkspaceId);
        setAgents(listed);
        setViewerAvatarUrl(viewerProfile?.avatar);
        const role = allMembers.find((member) => member.pubkey === currentIdentity.publicKey)?.role;
        setCanManageWorkspace(isWorkspaceManagerRole(role));
        const agentPubkeys = new Set(listed.map((agent) => agent.pubkey));
        const nextPeople = allMembers.filter((member) => !agentPubkeys.has(member.pubkey));
        setPeople(nextPeople);
        // Membership/roles are already in hand above; the room list and role
        // itself must never wait on a name/soul read landing behind them.
        setLoading(false);
        client
          .listPersonProfiles(
            activeWorkspaceId,
            nextPeople.map((member) => member.pubkey),
          )
          .then((nextProfiles) => {
            if (!cancelled) setProfiles(nextProfiles);
          })
          .catch(() => undefined);
        void refreshAgentPresence(nextTransport, activeWorkspaceId).catch(() => undefined);
        pairingInterval = setInterval(() => {
          if (!pairingPending.current) return;
          void refreshAgents(nextTransport, activeWorkspaceId).catch(() => undefined);
        }, 2000);
        presenceInterval = setInterval(() => {
          void refreshAgentPresence(nextTransport, activeWorkspaceId).catch(() => undefined);
        }, AGENT_PRESENCE_REFRESH_MS);
      } catch (caught) {
        // Rejecting unconditionally: a handler that is already waiting must
        // fail with the real reason, not sit out the full timeout.
        connection.reject(caught);
        if (!cancelled) setError(String(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (pairingInterval) clearInterval(pairingInterval);
      if (presenceInterval) clearInterval(presenceInterval);
    };
  }, [refreshAgentPresence, refreshAgents, requestedCommunityId]);

  useEffect(() => {
    // Presence only changes at a lease deadline. A five-second clock here woke
    // the whole directory every five seconds forever; wake once, exactly when
    // the next lease is due, and only while one is actually outstanding.
    const now = Date.now();
    const deadlines = Object.values(agentPresences)
      .map((presence) => presence.observedAt + AGENT_PRESENCE_STALE_MS)
      .filter((deadline) => Number.isFinite(deadline) && deadline > now);
    if (deadlines.length === 0) return;
    const timer = setTimeout(
      () => setPresenceNow(Date.now()),
      Math.max(1, Math.min(...deadlines) - now + 1),
    );
    return () => clearTimeout(timer);
  }, [agentPresences]);

  /**
   * The one place a handler turns "the button is on screen" into "the relay
   * context actually exists". Resolves immediately once init has landed;
   * otherwise waits on the init effect's own promise, bounded, so a tap during
   * the connect window executes late rather than vanishing, and a failed init
   * surfaces its real error instead of a silent return.
   */
  const requireConnection = useCallback(async (): Promise<WorkspaceConnection> => {
    if (transport && communityId) return { transport, communityId };
    const pending = connectionRef.current;
    if (!pending) throw new Error(CONNECTING_MESSAGE);
    return awaitWithin(pending.promise, CONNECTION_WAIT_TIMEOUT_MS, CONNECTING_MESSAGE);
  }, [communityId, transport]);

  const handleAdd = useCallback(async () => {
    if (!canManageWorkspace) return;
    setWorking('add-agent');
    setError(null);
    try {
      const { transport: ready, communityId: workspaceId } = await requireConnection();
      pairingBaseline.current = new Set(agents.map((agent) => agent.pubkey));
      pairingPending.current = true;
      const client = await ready.ensureClient();
      const pairing = await client.createAgentPairingCode(workspaceId);
      setPairCommand(`${PAIR_COMMAND_PREFIX} ${pairing.code}`);
      setPairExpiresAt(pairing.expiresAt);
    } catch (caught) {
      pairingPending.current = false;
      setError(`Could not create pairing code: ${String(caught)}`);
    } finally {
      setWorking(null);
    }
  }, [agents, canManageWorkspace, requireConnection]);

  // The Room-deck compose menu deep-links into the SAME pairing action as the
  // visible Add agent button. Run it once when the cached or live role says
  // this viewer may manage the Workspace; no second pairing implementation.
  useEffect(() => {
    if (
      requestedAction !== 'add-agent' ||
      requestedActionHandled.current ||
      !canManageWorkspace
    ) {
      return;
    }
    requestedActionHandled.current = true;
    void handleAdd();
  }, [canManageWorkspace, handleAdd, requestedAction]);

  const invitePerson = useCallback(async () => {
    if (!canManageWorkspace) return;
    setWorking('invite-person');
    setError(null);
    try {
      const { transport: ready, communityId: workspaceId } = await requireConnection();
      const client = await ready.ensureClient();
      const invite = await client.createInvite(workspaceId);
      const url = buildCommunityInviteUrl(invite.token, await getEffectiveRelayUrl());
      await Share.share({ message: url });
    } catch (caught) {
      setError(`Could not create person invite: ${String(caught)}`);
    } finally {
      setWorking(null);
    }
  }, [canManageWorkspace, requireConnection]);

  const setPersonRole = useCallback(
    async (pubkey: string, role: CommunityRole) => {
      if (!canManageWorkspace) return;
      setWorking('person-role');
      setError(null);
      try {
        const { transport: ready, communityId: workspaceId } = await requireConnection();
        const client = await ready.ensureClient();
        await client.addMember(workspaceId, pubkey, role);
        await client.waitUntilMemberRole(workspaceId, pubkey, role);
        await refreshPeople(ready, workspaceId, identity?.publicKey);
      } catch (caught) {
        setError(`Could not change person role: ${String(caught)}`);
      } finally {
        setWorking(null);
      }
    },
    [canManageWorkspace, identity?.publicKey, refreshPeople, requireConnection],
  );

  const removePerson = useCallback(
    async (pubkey: string) => {
      if (!canManageWorkspace) return;
      setWorking('remove-person');
      setError(null);
      try {
        const { transport: ready, communityId: workspaceId } = await requireConnection();
        const client = await ready.ensureClient();
        await client.removeMember(workspaceId, pubkey);
        await client.waitUntilNotMember(workspaceId, pubkey);
        await refreshPeople(ready, workspaceId, identity?.publicKey);
      } catch (caught) {
        setError(`Could not remove person: ${String(caught)}`);
      } finally {
        setWorking(null);
      }
    },
    [canManageWorkspace, identity?.publicKey, refreshPeople, requireConnection],
  );

  const chooseAgent = useCallback((agent: Agent) => {
    setSelectedPubkey(agent.pubkey);
    const fallback = defaultAgentPersona(agent.pubkey);
    setName(agent.soulProfile?.name ?? fallback.name);
    setSoul(agent.soulProfile?.soul ?? fallback.soul);
    setAvatarUrl(agent.soulProfile?.avatar ?? agent.avatar);
    setConfirmingRemoval(false);
    setError(null);
  }, []);

  // The runtime's advertised model/effort catalog + this agent's persisted
  // selection, if any. A session that has never activated yet has published
  // no catalog — the section then renders the fallback manual-entry axes
  // rather than disappearing: configuration stays possible either way.
  useEffect(() => {
    setOpenModelAxis(null);
    setCustomModelAxis(null);
    setCustomModelText('');
    if (!transport || !communityId || !selected) {
      setModelCatalog(null);
      setAgentSelection(null);
      setModelSelection(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [catalog, config] = await Promise.all([
          transport.agentModelCatalogRead(communityId, selected.pubkey),
          transport.agentModelConfigRead(communityId, selected.pubkey),
        ]);
        if (cancelled) return;
        setModelCatalog(catalog?.options ?? null);
        setAgentSelection(catalog?.selection ? { model: catalog.selection.model, effort: catalog.selection.effort } : null);
        setModelSelection(config ? { model: config.model, effort: config.effort } : null);
      } catch {
        if (!cancelled) {
          setModelCatalog(null);
          setAgentSelection(null);
          setModelSelection(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [communityId, selected, transport]);

  const chooseModelOption = useCallback(
    async (axis: AgentModelConfigOption, choiceId: string) => {
      if (!selected) return;
      const input: AgentModelConfigInput =
        axis.category === 'model' ? { model: choiceId } : { effort: choiceId };
      setModelConfigWorking(true);
      setError(null);
      try {
        const { transport: ready, communityId: workspaceId } = await requireConnection();
        await ready.agentModelConfigSet(workspaceId, selected.pubkey, input);
        setModelSelection((prev) => ({ ...prev, ...input }));
        setOpenModelAxis(null);
        setCustomModelAxis(null);
        setCustomModelText('');
      } catch (caught) {
        setError(`Could not set ${axis.category}: ${String(caught)}`);
      } finally {
        setModelConfigWorking(false);
      }
    },
    [requireConnection, selected],
  );

  const saveSoul = useCallback(
    async (nextName = name, nextSoul = soul) => {
      if (!selected || !canManageWorkspace) return;
      setWorking('save-soul');
      setError(null);
      try {
        const { transport: ready, communityId: workspaceId } = await requireConnection();
        const client = await ready.ensureClient();
        await client.setAgentSoul(workspaceId, selected.pubkey, {
          name: nextName,
          soul: nextSoul,
          avatarSeed: selected.pubkey,
          ...(avatarUrl ? { avatar: avatarUrl } : {}),
        });
        setName(nextName);
        setSoul(nextSoul);
        await refreshAgents(ready, workspaceId);
      } catch (caught) {
        setError(`Could not save soul: ${String(caught)}`);
      } finally {
        setWorking(null);
      }
    },
    [avatarUrl, canManageWorkspace, name, refreshAgents, requireConnection, selected, soul],
  );

  const changeAvatar = useCallback(async () => {
    if (!selected || !canManageWorkspace) return;
    setWorking('change-avatar');
    setError(null);
    try {
      const { transport: ready, communityId: workspaceId } = await requireConnection();
      const client = await ready.ensureClient();
      const nextAvatar = await pickAndUploadAvatar(client);
      if (!nextAvatar) return;
      await client.setAgentSoul(workspaceId, selected.pubkey, {
        name,
        soul,
        avatarSeed: selected.pubkey,
        avatar: nextAvatar,
      });
      setAvatarUrl(nextAvatar);
      await refreshAgents(ready, workspaceId);
    } catch (caught) {
      setError(`Could not set Agent picture: ${String(caught)}`);
    } finally {
      setWorking(null);
    }
  }, [canManageWorkspace, name, refreshAgents, requireConnection, selected, soul]);

  const resetAvatar = useCallback(async () => {
    if (!selected || !canManageWorkspace) return;
    setWorking('reset-avatar');
    setError(null);
    try {
      const { transport: ready, communityId: workspaceId } = await requireConnection();
      const client = await ready.ensureClient();
      await client.setAgentSoul(workspaceId, selected.pubkey, {
        name,
        soul,
        avatarSeed: selected.pubkey,
      });
      setAvatarUrl(undefined);
      await refreshAgents(ready, workspaceId);
    } catch (caught) {
      setError(`Could not restore generated Agent mark: ${String(caught)}`);
    } finally {
      setWorking(null);
    }
  }, [canManageWorkspace, name, refreshAgents, requireConnection, selected, soul]);

  const handleUseDefault = useCallback(() => {
    if (!selected) return;
    const fallback = defaultAgentPersona(selected.pubkey);
    setName(fallback.name);
    setSoul(fallback.soul);
  }, [selected]);

  const removeSelectedAgent = useCallback(async () => {
    if (!selected || !canManageWorkspace) return;
    setWorking('remove-agent');
    setError(null);
    try {
      const { transport: ready, communityId: workspaceId } = await requireConnection();
      const client = await ready.ensureClient();
      await client.removeAgent(workspaceId, selected.pubkey);
      setSelectedPubkey(null);
      setSoul('');
      setName('');
      setAvatarUrl(undefined);
      setConfirmingRemoval(false);
      await refreshAgents(ready, workspaceId);
    } catch (caught) {
      setError(`Could not remove Agent: ${String(caught)}`);
    } finally {
      setWorking(null);
    }
  }, [canManageWorkspace, refreshAgents, requireConnection, selected]);

  const messageSelectedAgent = useCallback(async () => {
    if (!selected) return;
    setWorking('message-agent');
    setError(null);
    try {
      const { transport: ready, communityId: workspaceId } = await requireConnection();
      const result = await ready.resolveDirectMessage(workspaceId, selected.pubkey);
      router.push(`/buzz/chat/${encodeURIComponent(result.channelId)}` as Href);
    } catch (caught) {
      setError(`Could not message Agent: ${String(caught)}`);
    } finally {
      setWorking(null);
    }
  }, [requireConnection, selected]);

  if (loading) {
    return (
      <View style={[styles.loading, { paddingTop: insets.top }]}>
        <PixelLoader />
      </View>
    );
  }

  return (
    <BuzzCommunityShell
      communities={communities}
      activeCommunityId={communityId ?? null}
      onSelect={(id) => {
        if (!id) return;
        router.replace({ pathname: '/buzz/channels', params: { communityId: id } });
      }}
      onAdd={() => router.push('/buzz/community' as Href)}
      onSettings={() => router.push('/buzz/settings' as Href)}
      onWorkspaceSettings={(id) =>
        router.push(
          { pathname: '/buzz/settings/workspace', params: { communityId: id } } as unknown as Href,
        )
      }
      canManageActiveCommunity={canManageWorkspace}
      viewerPubkey={identity?.publicKey}
      viewerAvatarUrl={viewerAvatarUrl}
    >
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {/* Chrome sits on the same obsidian as the list below it. */}
        <View style={styles.header}>
          <TouchableOpacity
            accessibilityLabel={`Back to ${ROOM_LABEL}s`}
            style={styles.backButton}
            onPress={() => router.back()}
          >
            <Text style={styles.backText}>‹</Text>
          </TouchableOpacity>
          <View style={styles.headerCopy}>
            <Text style={styles.title}>
              {MEMBERS_GLYPH} {MEMBERS_LABEL}
            </Text>
            {activeCommunity && <Text style={styles.headerMeta}>{activeCommunity.name}</Text>}
          </View>
        </View>

        <KeyboardAwareScrollView
          bottomOffset={16}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {pairCommand && (
            <View style={styles.pairPanel}>
              <Text style={styles.pairNote}>Run this where your agent lives.</Text>
              <Text style={styles.stepLabel}>Install beeline (one-time):</Text>
              <TouchableOpacity
                accessibilityLabel="Copy install command"
                style={styles.commandRow}
                onPress={() => Clipboard.setStringAsync(INSTALL_COMMAND)}
              >
                <Text selectable style={styles.command}>
                  {INSTALL_COMMAND}
                </Text>
                <Text style={styles.copyText}>Copy</Text>
              </TouchableOpacity>
              <Text style={styles.stepLabel}>Then pair this Agent:</Text>
              <TouchableOpacity
                accessibilityLabel="Copy pairing command"
                style={styles.commandRow}
                onPress={() => Clipboard.setStringAsync(pairCommand)}
              >
                <Text selectable style={styles.command}>
                  {pairCommand}
                </Text>
                <Text style={styles.copyText}>Copy</Text>
              </TouchableOpacity>
              <View style={styles.waitingRow}>
                <HullWaveSignal compact label="WAITING" />
                <Text style={styles.expiry}>
                  Expires{' '}
                  {pairExpiresAt ? new Date(pairExpiresAt * 1000).toLocaleTimeString() : 'soon'}
                </Text>
              </View>
            </View>
          )}

          {error && (
            <View accessibilityRole="alert" style={styles.errorPanel}>
              <Text style={styles.errorLabel}>! ERROR</Text>
              <Text style={styles.error}>{error}</Text>
            </View>
          )}

          <View style={styles.memberSection} testID="members-people-section">
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>People</Text>
              <Text style={styles.count} testID="members-people-count">
                {visiblePeople.length}
              </Text>
              {canManageWorkspace && (
                <MonoButton
                  label={working === 'invite-person' ? 'Creating invite' : 'Invite person'}
                  loading={working === 'invite-person'}
                  disabled={busy}
                  onPress={() => void invitePerson()}
                  variant="secondary"
                  style={styles.sectionAction}
                  testID="invite-person"
                />
              )}
            </View>
            {visiblePeople.length === 0 ? (
              <Text style={styles.sectionEmpty}>No people in this Workspace yet.</Text>
            ) : (
              <View style={styles.peopleList}>
                {visiblePeople.map((person) => {
                  const profile = profileByPubkey.get(person.pubkey);
                  const immutableOwner = person.pubkey === activeCommunity?.ownerPubkey;
                  const isSelf = person.pubkey === identity?.publicKey;
                  const actorCanChange =
                    !immutableOwner &&
                    !isSelf &&
                    (canManageWorkspace &&
                      (activeCommunity?.viewerRole === 'owner' || person.role === 'member'));
                  return (
                    <View key={person.pubkey} style={styles.personRow}>
                      <IdentityMark
                        kind="human"
                        seed={person.pubkey}
                        avatarUrl={profile?.avatar}
                        name={profile?.name ?? shortMemberNpub(person.pubkey)}
                        size={44}
                      />
                      <View style={styles.personCopy}>
                        <Text
                          numberOfLines={1}
                          style={styles.personName}
                          testID={`member-${person.pubkey}-identity`}
                        >
                          {personIdentityLabel(profile, person.pubkey, nip05Status.get(person.pubkey))}
                          {isSelf ? ' (you)' : ''}
                        </Text>
                      </View>
                      <View style={styles.personTrailing}>
                        {roleEditorPubkey === person.pubkey ? (
                          <View style={styles.roleSegment}>
                            {(['owner', 'admin', 'member'] as const).map((role, index) => {
                              const selectedRole = person.role === role;
                              const allowed =
                                actorCanChange &&
                                (activeCommunity?.viewerRole === 'owner' || role !== 'owner');
                              return (
                                <TouchableOpacity
                                  accessibilityState={{ selected: selectedRole, disabled: !allowed }}
                                  disabled={!allowed || selectedRole || busy}
                                  key={role}
                                  onPress={() => {
                                    setRoleEditorPubkey(null);
                                    void setPersonRole(person.pubkey, role);
                                  }}
                                  style={[styles.roleSegmentButton, index > 0 && styles.roleSegmentDivider]}
                                  testID={`member-${person.pubkey}-${role}`}
                                >
                                  <Text
                                    style={[
                                      styles.roleText,
                                      selectedRole && styles.roleTextSelected,
                                    ]}
                                  >
                                    {roleLabel(role)}
                                  </Text>
                                </TouchableOpacity>
                              );
                            })}
                          </View>
                        ) : (
                          <TouchableOpacity
                            accessibilityLabel={`${profile?.name ?? shortMemberNpub(person.pubkey)} role: ${roleLabel(person.role)}${actorCanChange ? '. Tap to change role.' : ''}`}
                            disabled={!actorCanChange}
                            onPress={() => setRoleEditorPubkey(person.pubkey)}
                            style={styles.roleLabelButton}
                            testID={`member-${person.pubkey}-role-label`}
                          >
                            <Text
                              style={[styles.roleLabelText, { color: roleAccentColor(person.role, theme.buzz) }]}
                            >
                              {roleLabel(person.role)}
                            </Text>
                          </TouchableOpacity>
                        )}
                        {actorCanChange && (
                          <TouchableOpacity
                            accessibilityLabel={`Remove ${profile?.name ?? shortMemberNpub(person.pubkey)}`}
                            disabled={busy}
                            onPress={() => void removePerson(person.pubkey)}
                            style={styles.removePersonButton}
                            testID={`member-${person.pubkey}-remove`}
                          >
                            <Text style={styles.removePersonText}>×</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </View>

          <View style={styles.memberSection} testID="members-agents-section">
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Agents</Text>
              <Text style={styles.count}>{agents.length}</Text>
              {canManageWorkspace && (
                <MonoButton
                  label={working === 'add-agent' ? 'Adding agent' : 'Add agent'}
                  loading={working === 'add-agent'}
                  disabled={busy}
                  onPress={() => void handleAdd()}
                  variant="secondary"
                  style={styles.sectionAction}
                  testID="add-agent"
                />
              )}
            </View>
            {agents.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyGlyph}>{MEMBERS_GLYPH}</Text>
              <Text style={styles.emptyTitle}>No agents yet</Text>
              <Text style={styles.emptyCopy}>
                Connect once, then use the Agent in every {ROOM_LABEL}.
              </Text>
            </View>
          ) : (
            agents.map((agent) => {
              const display = resolveAgentDisplayIdentity(agent.pubkey, agent);
              const online = isAgentPresenceOnline(agentPresences[agent.pubkey], presenceNow);
              const presenceKnown = presenceResolved || Boolean(agentPresences[agent.pubkey]);
              // The tier door, not a screen-local reinterpretation: the same
              // lease record every surface reads. DORMANT means the lease has
              // been dark past the sustained-absence grace — identity stays
              // in the roster, but this label never claims liveness.
              const tier = presenceKnown
                ? resolveAgentPresenceTier(agentPresences[agent.pubkey], presenceNow)
                : undefined;
              const presenceWord = online ? 'ONLINE' : tier === 'dormant' ? 'DORMANT' : presenceKnown ? 'OFFLINE' : '—';
              return (
                <TouchableOpacity
                  key={agent.agentId}
                  accessibilityLabel={`${display.name}, ${display.personality}, ${online ? 'online' : 'offline'}`}
                  style={[
                    styles.agentRow,
                    selectedPubkey === agent.pubkey && styles.agentRowActive,
                  ]}
                  onPress={() => chooseAgent(agent)}
                >
                  <IdentityMark
                    kind="agent"
                    seed={display.avatarSeed ?? agent.pubkey}
                    avatarUrl={display.avatarUrl}
                    name={display.name}
                    size={44}
                    alive={online}
                  />
                  <View style={styles.agentCopy}>
                    <Text
                      style={styles.agentName}
                      numberOfLines={1}
                      testID={`agent-${agent.pubkey}-identity`}
                    >
                      {display.name}
                    </Text>
                    <Text style={styles.personality} numberOfLines={2}>
                      {display.personality}
                    </Text>
                  </View>
                  <View style={styles.agentPresence} testID={`agent-${agent.pubkey}-presence`}>
                    <Text
                      style={[styles.presenceDot, online ? styles.presenceOnline : styles.presenceOffline]}
                    >
                      {online ? '●' : '○'}
                    </Text>
                    <Text
                      style={[
                        styles.presenceLabel,
                        online ? styles.presenceOnlineLabel : styles.presenceOfflineLabel,
                      ]}
                      testID={`agent-${agent.pubkey}-presence-label`}
                    >
                      {presenceWord}
                    </Text>
                  </View>
                  <Text style={styles.chevron}>›</Text>
                </TouchableOpacity>
              );
            })
          )}
          </View>

          {selected && canManageWorkspace && (
            <View style={styles.editor}>
              <View style={styles.editorTitleRow}>
                <IdentityMark
                  kind="agent"
                  seed={resolveAgentDisplayIdentity(selected.pubkey, selected).avatarSeed ?? selected.pubkey}
                  avatarUrl={avatarUrl}
                  name={resolveAgentDisplayIdentity(selected.pubkey, selected).name}
                  size={42}
                />
                <View style={styles.editorTitleCopy}>
                  <Text style={styles.editorTitle}>
                    {selected.soulProfile ? 'Edit Agent' : 'Give this Agent a face'}
                  </Text>
                  <Text style={styles.editorHint}>
                    These instructions shape how the Agent works. They never grant permissions.
                  </Text>
                </View>
              </View>
              {(presenceResolved || Boolean(agentPresences[selected.pubkey])) &&
                !isAgentPresenceOnline(agentPresences[selected.pubkey], presenceNow) && (
                <View style={styles.agentOfflineNotice} testID={`agent-${selected.pubkey}-offline-notice`}>
                  <Text style={styles.agentOfflineNoticeTitle}>
                    {resolveAgentPresenceTier(agentPresences[selected.pubkey], presenceNow) === 'dormant'
                      ? '○ DORMANT'
                      : '○ OFFLINE'}
                  </Text>
                  <Text style={styles.agentOfflineNoticeText}>
                    {resolveAgentPresenceTier(agentPresences[selected.pubkey], presenceNow) === 'dormant'
                      ? 'No daemon has reported in for over a day. Reconnect it, or re-pair the Agent to replace this key.'
                      : 'No daemon is reporting in. Messages will wait until it reconnects.'}
                  </Text>
                </View>
              )}
              <View style={styles.avatarActions}>
                <TouchableOpacity
                  accessibilityLabel={`Message ${resolveAgentDisplayIdentity(selected.pubkey, selected).name}`}
                  style={styles.secondaryButton}
                  disabled={busy}
                  onPress={() => void messageSelectedAgent()}
                  testID={`message-agent-${selected.pubkey}`}
                >
                  <Text style={styles.secondaryButtonText}>Message</Text>
                </TouchableOpacity>
                {/* Photo-override darkflight: the Agent picture buttons render
                    nothing while PHOTO_OVERRIDES_ENABLED is false. changeAvatar/
                    resetAvatar stay intact for revival. */}
                {PHOTO_OVERRIDES_ENABLED && (
                <TouchableOpacity
                  style={styles.secondaryButton}
                  disabled={busy}
                  onPress={() => void changeAvatar()}
                >
                  <Text style={styles.secondaryButtonText}>
                    {avatarUrl ? 'Change picture' : 'Set picture'}
                  </Text>
                </TouchableOpacity>
                )}
                {PHOTO_OVERRIDES_ENABLED && avatarUrl && (
                  <TouchableOpacity
                    style={styles.avatarReset}
                    disabled={busy}
                    onPress={() => void resetAvatar()}
                  >
                    <Text style={styles.avatarResetText}>Use generated mark</Text>
                  </TouchableOpacity>
                )}
              </View>
              <Text style={styles.label}>Soul</Text>
              <TextInput
                style={[styles.input, styles.soulInput]}
                value={soul}
                onChangeText={setSoul}
                placeholder="Keep the test suite green and refactor mercilessly. Be direct and practical."
                placeholderTextColor={theme.buzz.dim}
                multiline
                maxLength={1000}
              />
              <Text style={styles.label}>Name</Text>
              <TextInput
                style={styles.input}
                testID="agent-soul-name"
                value={name}
                onChangeText={setName}
                placeholderTextColor={theme.buzz.dim}
                maxLength={AGENT_NAME_MAX_LENGTH}
                autoCapitalize="words"
              />
              <Text style={styles.fieldHint}>
                A short spoken name — one word or a compound like "Quiet
                Keeper". Mention as @
                {name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'name'}.
              </Text>
              <View style={styles.editorActions}>
                <MonoButton
                  label="Save"
                  style={[styles.primaryButton, styles.flexButton]}
                  disabled={
                    !soul.trim() || !isReasonableAgentName(name) || busy
                  }
                  onPress={() => void saveSoul()}
                />
                <TouchableOpacity
                  style={[styles.secondaryButton, styles.flexButton]}
                  disabled={busy}
                  onPress={handleUseDefault}
                >
                  <Text style={styles.secondaryButtonText}>Suggest locally</Text>
                </TouchableOpacity>
              </View>
              {selected && (
                <View style={styles.modelConfigSection} testID={`agent-${selected.pubkey}-model-config`}>
                  <Text style={styles.label}>Model / Effort</Text>
                  {!modelCatalog && (
                    <Text style={styles.modelConfigHint} testID="model-catalog-missing">
                      This agent has not reported its model catalog yet. You can still set a
                      value by hand — it applies on the agent's next session.
                    </Text>
                  )}
                  {(modelCatalog && modelCatalog.length > 0 ? modelCatalog : MODEL_FALLBACK_AXES).map((axis) => {
                    const persisted = axis.category === 'model' ? modelSelection?.model : modelSelection?.effort;
                    const configured = axis.category === 'model' ? agentSelection?.model : agentSelection?.effort;
                    // A human in-app pick wins, then what the agent itself
                    // reports running with (a CLI `beeline pair --model`/
                    // `--effort` default), then the harness's own snapshot.
                    const currentValue = persisted ?? configured ?? axis.currentValue;
                    const isEffortAxis = axis.category !== 'model';
                    const choices: Array<{ id: string; name?: string }> =
                      axis.options.length > 0
                        ? axis.options
                        : isEffortAxis
                          ? EFFORT_FALLBACK_LEVELS.map((id) => ({ id }))
                          : [];
                    const isOpen = openModelAxis === axis.id;
                    const isCustomOpen = customModelAxis === axis.id;
                    return (
                      <View key={axis.id} style={styles.modelAxisBlock}>
                        <TouchableOpacity
                          style={styles.modelAxisRow}
                          disabled={modelConfigWorking}
                          onPress={() => {
                            setOpenModelAxis(isOpen ? null : axis.id);
                            setCustomModelAxis(null);
                            setCustomModelText('');
                          }}
                          testID={`model-axis-${axis.id}`}
                        >
                          <Text style={styles.modelAxisLabel}>
                            {isEffortAxis ? 'Effort' : 'Model'}
                          </Text>
                          <Text
                            style={[styles.modelAxisValue, !currentValue && styles.modelAxisValueUnset]}
                            numberOfLines={1}
                            testID={`model-axis-value-${axis.id}`}
                          >
                            {currentValue ?? 'Not set — tap to choose'}
                          </Text>
                          {/* Every row is tappable: an effort axis always offers
                              its levels and the model axis always offers manual
                              entry, even when no catalog has been advertised. */}
                          <Text style={styles.chevron}>{isOpen ? '⌄' : '›'}</Text>
                        </TouchableOpacity>
                        {isOpen &&
                          choices.map((choice) => (
                            <TouchableOpacity
                              key={choice.id}
                              style={styles.modelOptionRow}
                              disabled={modelConfigWorking}
                              onPress={() => void chooseModelOption(axis, choice.id)}
                              testID={`model-option-${axis.id}-${choice.id}`}
                            >
                              <Text
                                style={[
                                  styles.modelOptionText,
                                  choice.id === currentValue && styles.modelOptionTextActive,
                                ]}
                              >
                                {choice.name ?? choice.id}
                              </Text>
                              {choice.id === currentValue && <Text style={styles.modelOptionCheck}>✓</Text>}
                            </TouchableOpacity>
                          ))}
                        {/* Custom-id escape, MODEL ONLY: a catalog miss is not
                            evidence a model is unusable — harnesses like pi
                            accept unknown ids verbatim as custom model ids —
                            so any id can be entered by hand and the harness's
                            own response (even a warning) is what comes back at
                            launch. Effort never gets this: its values are a
                            small fixed set, so it is always a level picker. */}
                        {isOpen && !isEffortAxis && (
                          <View style={styles.modelCustomBlock}>
                            <TouchableOpacity
                              style={styles.modelOptionRow}
                              disabled={modelConfigWorking}
                              onPress={() => {
                                setCustomModelAxis(isCustomOpen ? null : axis.id);
                                setCustomModelText('');
                              }}
                              testID={`model-custom-${axis.id}`}
                            >
                              <Text style={[styles.modelOptionText, isCustomOpen && styles.modelOptionTextActive]}>
                                Enter a custom id…
                              </Text>
                            </TouchableOpacity>
                            {isCustomOpen && (
                              <View style={styles.modelCustomEntry}>
                                <TextInput
                                  style={styles.modelCustomInput}
                                  value={customModelText}
                                  onChangeText={setCustomModelText}
                                  autoCapitalize="none"
                                  autoCorrect={false}
                                  placeholder={axis.category === 'model' ? 'provider/model-id' : 'low | medium | high | …'}
                                  placeholderTextColor={theme.buzz.textMuted}
                                  editable={!modelConfigWorking}
                                  testID={`model-custom-input-${axis.id}`}
                                />
                                <TouchableOpacity
                                  disabled={modelConfigWorking || customModelText.trim().length === 0}
                                  onPress={() => void chooseModelOption(axis, customModelText.trim())}
                                  testID={`model-custom-submit-${axis.id}`}
                                >
                                  <Text
                                    style={[
                                      styles.modelCustomApply,
                                      customModelText.trim().length > 0 && styles.modelOptionTextActive,
                                    ]}
                                  >
                                    Apply
                                  </Text>
                                </TouchableOpacity>
                              </View>
                            )}
                          </View>
                        )}
                      </View>
                    );
                  })}
                </View>
              )}
              <TouchableOpacity
                accessibilityLabel="Remove this Agent"
                accessibilityHint="Stops the Agent and ends its work on the host machine"
                style={styles.removeButton}
                disabled={busy}
                onPress={() => setConfirmingRemoval(true)}
              >
                <Text style={styles.removeButtonLabel}>Remove Agent</Text>
                <Text style={styles.removeButtonHint}>Stops host sessions and disconnects</Text>
              </TouchableOpacity>
              {confirmingRemoval && (
                <View accessibilityRole="alert" style={styles.removeConfirm}>
                  <Text style={styles.removeConfirmFlag}>STOP AGENT</Text>
                  <Text style={styles.removeConfirmTitle}>
                    Remove {resolveAgentDisplayIdentity(selected.pubkey, selected).name}?
                  </Text>
                  <Text style={styles.removeConfirmCopy}>
                    This stops the Agent, ends its work and running sessions on the host, and
                    disconnects it from every Room in this Workspace.
                  </Text>
                  <View style={styles.removeConfirmActions}>
                    <TouchableOpacity
                      accessibilityLabel="Cancel Agent removal"
                      style={[styles.secondaryButton, styles.flexButton]}
                      disabled={busy}
                      onPress={() => setConfirmingRemoval(false)}
                    >
                      <Text style={styles.secondaryButtonText}>Cancel</Text>
                    </TouchableOpacity>
                    <MonoButton
                      label={working === 'remove-agent' ? 'Stopping Agent' : 'Stop & Remove'}
                      loading={working === 'remove-agent'}
                      style={[styles.primaryButton, styles.flexButton]}
                      disabled={busy}
                      onPress={() => void removeSelectedAgent()}
                    />
                  </View>
                </View>
              )}
            </View>
          )}
        </KeyboardAwareScrollView>
      </View>
    </BuzzCommunityShell>
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return ({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: groknight.bgTerminal,
  },
  container: { flex: 1, minWidth: 0, backgroundColor: groknight.bgTerminal },
  header: {
    minHeight: 58,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: groknight.bgTerminal,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  backButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  backText: { ...Typography.default(), color: groknight.chrome, fontSize: 30, fontWeight: '300' },
  headerCopy: { flex: 1, minWidth: 0, paddingLeft: 4 },
  title: {
    ...Typography.default('semiBold'), fontFamily: groknight.proseSemibold,
    color: groknight.textPrimary,
    fontSize: 20,
    lineHeight: 24,
  },
  headerMeta: { ...Typography.default(), fontFamily: groknight.proseRegular, marginTop: 2, color: groknight.muted, fontSize: 11 },
  scrollContent: { paddingHorizontal: 18, paddingTop: 20, paddingBottom: 56 },
  pairPanel: {
    paddingBottom: 24,
    marginBottom: 20,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  pairNote: { ...Typography.default(), fontFamily: groknight.proseRegular, color: groknight.textSecondary, fontSize: 13, lineHeight: 19 },
  stepLabel: {
    ...Typography.default('semiBold'), fontFamily: groknight.proseSemibold,
    marginTop: 14,
    color: groknight.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  commandRow: {
    marginTop: 6,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: groknight.name === 'ledger' ? 8 : 13,
    backgroundColor: groknight.bgBase,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
  },
  command: {
    flex: 1,
    minWidth: 0,
    color: groknight.textPrimary,
    ...Typography.mono('semiBold'),
    fontSize: 13,
  },
  copyText: {
    ...Typography.default('semiBold'), fontFamily: groknight.proseSemibold,
    marginLeft: 10,
    color: groknight.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  waitingRow: { marginTop: 10, flexDirection: 'row', alignItems: 'center', gap: 7 },
  expiry: { ...Typography.mono(), color: groknight.textMuted, fontSize: 11, lineHeight: 15 },
  errorPanel: {
    padding: 10,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    backgroundColor: groknight.bgHighlight,
  },
  errorLabel: {
    ...Typography.mono('semiBold'),
    color: groknight.textPrimary,
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 0.8,
  },
  error: {
    ...Typography.default(), fontFamily: groknight.proseRegular,
    marginTop: 4,
    color: groknight.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  memberSection: { marginBottom: 32 },
  sectionHeader: { marginBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 10 },
  sectionTitle: {
    ...Typography.default('semiBold'), fontFamily: groknight.proseSemibold,
    flex: 1,
    color: groknight.textPrimary,
    fontSize: 14,
  },
  count: { ...Typography.default(), fontFamily: groknight.proseRegular, color: groknight.muted, fontSize: 12 },
  sectionAction: { alignSelf: 'center' },
  sectionEmpty: {
    ...Typography.default(), fontFamily: groknight.proseRegular,
    paddingVertical: 18,
    color: groknight.textMuted,
    fontSize: 13,
  },
  peopleList: {},
  personRow: {
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  personCopy: { flex: 1, minWidth: 0 },
  personName: { ...Typography.default('semiBold'), fontFamily: groknight.proseSemibold, color: groknight.textPrimary, fontSize: groknight.name === 'ledger' ? 13 : 15 },
  personTrailing: { flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 4 },
  roleLabelButton: {
    minHeight: 28,
    minWidth: 44,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roleLabelText: {
    ...Typography.mono('semiBold'),
    fontSize: 10,
    letterSpacing: 0.5,
  },
  roleSegment: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: groknight.border,
    borderRadius: 3,
    overflow: 'hidden',
  },
  roleSegmentButton: {
    minHeight: 28,
    paddingHorizontal: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roleSegmentDivider: { borderLeftWidth: 1, borderLeftColor: groknight.border },
  roleText: {
    ...Typography.mono('semiBold'),
    color: groknight.textMuted,
    fontSize: 8,
    letterSpacing: 0.4,
  },
  roleTextSelected: { color: groknight.textPrimary },
  removePersonButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  removePersonText: { ...Typography.default(), fontFamily: groknight.proseRegular, color: groknight.steel, fontSize: 22 },
  empty: {
    alignItems: 'center',
    paddingTop: 46,
    paddingBottom: 34,
    paddingHorizontal: 22,
  },
  emptyGlyph: {
    ...Typography.default(),
    width: 44,
    height: 44,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    borderRadius: 3,
    color: groknight.steel,
    fontSize: 26,
    lineHeight: 42,
    textAlign: 'center',
  },
  emptyTitle: {
    ...Typography.default('semiBold'), fontFamily: groknight.proseSemibold,
    marginTop: 10,
    color: groknight.textPrimary,
    fontSize: 16,
  },
  emptyCopy: {
    ...Typography.default(), fontFamily: groknight.proseRegular,
    marginTop: 7,
    color: groknight.textSecondary,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  agentRow: {
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: groknight.name === 'ledger' ? 8 : 13,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  agentRowActive: { backgroundColor: groknight.bgBase },
  agentCopy: { flex: 1, minWidth: 0 },
  agentName: {
    ...Typography.default('semiBold'), fontFamily: groknight.proseSemibold,
    color: groknight.textPrimary,
    fontSize: 15,
  },
  personality: {
    ...Typography.default(), fontFamily: groknight.proseRegular,
    marginTop: 3,
    color: groknight.textSecondary,
    fontSize: 11,
    lineHeight: 16,
  },
  agentPresence: { flexShrink: 0, alignItems: 'flex-end' },
  presenceDot: { ...Typography.default(), fontSize: 8 },
  presenceOnline: { color: groknight.accent },
  presenceOffline: { color: groknight.textMuted },
  presenceLabel: {
    ...Typography.mono('semiBold'),
    marginTop: 2,
    fontSize: 9,
    letterSpacing: 0.5,
  },
  presenceOnlineLabel: { color: groknight.accent },
  presenceOfflineLabel: { color: groknight.textMuted },
  agentOfflineNotice: {
    marginBottom: 14,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    backgroundColor: groknight.bgBase,
  },
  agentOfflineNoticeTitle: {
    ...Typography.mono('semiBold'),
    color: groknight.textPrimary,
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 0.55,
  },
  agentOfflineNoticeText: {
    ...Typography.default(), fontFamily: groknight.proseRegular,
    marginTop: 3,
    color: groknight.textSecondary,
    fontSize: 11,
    lineHeight: 15,
  },
  chevron: { ...Typography.default(), color: groknight.chrome, fontSize: 24 },
  editor: {
    marginTop: 24,
    paddingTop: 20,
    borderTopWidth: 1,
    borderTopColor: groknight.border,
  },
  editorTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  editorTitleCopy: { flex: 1, minWidth: 0 },
  avatarActions: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 18 },
  avatarReset: { minHeight: 44, justifyContent: 'center' },
  avatarResetText: {
    ...Typography.default('semiBold'), fontFamily: groknight.proseSemibold,
    color: groknight.textSecondary,
    fontSize: 12,
  },
  fieldHint: {
    ...Typography.mono(),
    marginTop: 6,
    color: groknight.textMuted,
    fontSize: 10,
    lineHeight: 15,
  },
  editorTitle: {
    ...Typography.default('semiBold'), fontFamily: groknight.proseSemibold,
    color: groknight.textPrimary,
    fontSize: 16,
  },
  editorHint: {
    ...Typography.default(), fontFamily: groknight.proseRegular,
    marginTop: 4,
    color: groknight.steel,
    fontSize: 12,
    lineHeight: 17,
  },
  label: {
    ...Typography.default('semiBold'), fontFamily: groknight.proseSemibold,
    marginTop: 10,
    marginBottom: 6,
    color: groknight.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  input: {
    ...Typography.default(), fontFamily: groknight.proseRegular,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: groknight.textPrimary,
    fontSize: 13,
    borderWidth: 1,
    borderColor: groknight.border,
    backgroundColor: groknight.bgTerminal,
  },
  soulInput: { minHeight: 112, textAlignVertical: 'top' },
  primaryButton: {
    marginTop: 10,
  },
  secondaryButton: {
    marginTop: 10,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    backgroundColor: 'transparent',
  },
  secondaryButtonText: {
    ...Typography.default('semiBold'), fontFamily: groknight.proseSemibold,
    color: groknight.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  editorActions: { flexDirection: 'row', gap: 8 },
  flexButton: { flex: 1, minWidth: 0 },
  modelConfigSection: { marginTop: 12 },
  modelConfigHint: {
    ...Typography.default(), fontFamily: groknight.proseRegular,
    color: groknight.textMuted,
    fontSize: 12,
    paddingBottom: 8,
  },
  modelAxisBlock: { borderBottomWidth: 1, borderBottomColor: groknight.border },
  modelAxisRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
  },
  modelAxisLabel: {
    ...Typography.default('semiBold'), fontFamily: groknight.proseSemibold,
    color: groknight.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  modelAxisValue: {
    ...Typography.mono(),
    flex: 1,
    minWidth: 0,
    textAlign: 'right',
    color: groknight.textPrimary,
    fontSize: 12,
  },
  modelAxisValueUnset: { color: groknight.textMuted },
  modelCustomBlock: { paddingBottom: 8 },
  modelCustomEntry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 12,
    paddingRight: 12,
    paddingBottom: 8,
  },
  modelCustomInput: {
    ...Typography.mono(),
    flex: 1,
    minWidth: 0,
    color: groknight.textPrimary,
    fontSize: 12,
    borderWidth: 1,
    borderColor: groknight.border,
    borderRadius: 3,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  modelCustomApply: {
    ...Typography.default('semiBold'), fontFamily: groknight.proseSemibold,
    color: groknight.textMuted,
    fontSize: 12,
    paddingHorizontal: 4,
  },
  modelOptionRow: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    paddingLeft: 12,
  },
  modelOptionText: { ...Typography.mono(), color: groknight.textMuted, fontSize: 12 },
  modelOptionTextActive: { color: groknight.accent },
  modelOptionCheck: { ...Typography.default(), fontFamily: groknight.proseRegular, color: groknight.accent, fontSize: 12 },
  removeButton: {
    marginTop: 22,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    backgroundColor: groknight.bgBase,
  },
  removeButtonLabel: {
    ...Typography.default('semiBold'), fontFamily: groknight.proseSemibold,
    color: groknight.textPrimary,
    fontSize: 12,
    letterSpacing: 0.3,
  },
  removeButtonHint: {
    ...Typography.default(), fontFamily: groknight.proseRegular,
    marginTop: 3,
    color: groknight.textMuted,
    fontSize: 9,
    letterSpacing: 0.4,
  },
  removeConfirm: {
    marginTop: 8,
    padding: 14,
    borderWidth: 1,
    borderColor: groknight.textPrimary,
    backgroundColor: groknight.bgHighlight,
  },
  removeConfirmFlag: {
    ...Typography.default('semiBold'), fontFamily: groknight.proseSemibold,
    color: groknight.textPrimary,
    fontSize: 9,
    letterSpacing: 1.4,
  },
  removeConfirmTitle: {
    ...Typography.default('semiBold'), fontFamily: groknight.proseSemibold,
    marginTop: 7,
    color: groknight.textPrimary,
    fontSize: 16,
  },
  removeConfirmCopy: {
    ...Typography.default(), fontFamily: groknight.proseRegular,
    marginTop: 6,
    color: groknight.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  removeConfirmActions: { flexDirection: 'row', gap: 8, marginTop: 8 },
  disabled: { backgroundColor: groknight.bgBase },
  });
});
