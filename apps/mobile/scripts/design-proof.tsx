import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Button } from '../sources/components/buzz/Button';
import { ConversationRow } from '../sources/components/buzz/ConversationRow';
import { WorkflowGlyph } from '../sources/components/buzz/WorkflowGlyph';
import { WritePermissionOutcome } from '../sources/components/buzz/WritePermissionOutcome';
import { DesktopRoomCorners } from '../sources/components/buzz/DesktopRoomCorners';
import { HullFloatingSurface } from '../sources/components/buzz/HullDialog';
import { HullActionSheetModal, HullActionSheetRow } from '../sources/components/buzz/HullActionSheet';
import { UpdateReadyPrompt } from '../sources/components/UpdateReadyPrompt';
import { TranscriptCard } from '../sources/components/buzz/TranscriptCard';
import { MonoMarkdown } from '../sources/components/buzz/MonoMarkdown';
import { WelcomeCards } from '../sources/components/buzz/WelcomeCards';
import { ArtifactCard } from '../sources/components/buzz/ArtifactCard';
import {
  AppSignInCard,
  NotificationLifecycleCard,
} from '../sources/app/(app)/beeline/chat/RoomMessageVariants';
import WorkflowsScreen from '../sources/app/(app)/beeline/settings/workflows';
import TextSelectionScreen from '../sources/app/(app)/text-selection';
import { Typography } from '../sources/constants/Typography';

/**
 * The design-inconsistency proof (DESIGN.md, PR #2044). Paints the changed
 * surfaces with the real components in the theme the shimmed Unistyles hands
 * them; `scripts/render-design-proof.mjs` captures every page in Obsidian and
 * Bone. Pages (`?page=`): board, frames, workflows, text-selection,
 * members, welcome-1 … welcome-4.
 */
const page = new URLSearchParams(location.search).get('page') ?? 'board';

const message = (overrides: Record<string, unknown>) =>
  ({ id: 'message', text: 'hello', isUser: false, timestamp: 1, ...overrides }) as never;
const latestMessage = {
  id: 'm1',
  text: 'PR #2034 is open',
  createdAt: Date.now() - 60_000,
  author: { pubkey: 'ruby', kind: 'agent', name: 'Ruby', handle: '@ruby' },
};
const row = (name: string, unread: boolean) =>
  ({ room: { id: name, name, updatedAt: Date.now() }, latestMessage, unread }) as never;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const { theme } = useUnistyles();
  return (
    <View style={{ marginBottom: 24, width: 520 }}>
      <Text style={{ ...theme.buzz.type.sectionHead, color: theme.buzz.ledgerQuiet, marginBottom: 8 }}>
        {title}
      </Text>
      {children}
    </View>
  );
}

function Canvas({ children }: { children: React.ReactNode }) {
  const { theme } = useUnistyles();
  return (
    <View
      style={{
        backgroundColor: theme.buzz.bgBase,
        padding: 32,
        minHeight: '100%',
        flexDirection: 'row',
        flexWrap: 'wrap',
        columnGap: 48,
      }}
    >
      {children}
    </View>
  );
}

function Board() {
  const { theme } = useUnistyles();
  return (
    <Canvas>
      <View>
        <Text style={{ ...theme.buzz.type.hero, color: theme.buzz.textPrimary, marginBottom: 24 }}>
          {theme.buzz.label}
        </Text>
        <Section title="1 · Transcript card (theme brass) · 2 · 16/13 sizes">
          <TranscriptCard
            tier="ask"
            title="Merge approval"
            subline="Ruby · feature/corner-99be89a5d913"
            stamp="12:41"
            rows={[{ id: 'r', state: 'passed', title: 'Mobile suite', kindLine: 'ci · 2m' }] as never}
            code={<Text style={{ ...theme.buzz.type.machine, color: theme.buzz.textSecondary }}>npx vitest run</Text>}
            codePath="apps/mobile"
            actions={[
              { label: 'Approve', onPress: () => undefined, primary: true },
              { label: 'Later', onPress: () => undefined },
            ]}
          />
        </Section>
        <Section title="1 · Idle and live workflow glyph">
          <View style={{ flexDirection: 'row', gap: 16, alignItems: 'center' }}>
            <WorkflowGlyph live={false} size={28} />
            <Text style={{ ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet }}>idle (ledgerGhost)</Text>
            <WorkflowGlyph live size={28} />
            <Text style={{ ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet }}>live</Text>
          </View>
        </Section>
        <Section title="2 · Unread row fill (bgUnread) vs read">
          <ConversationRow item={row('docs-refresh', true)} viewer="me" now={Date.now()} onPress={() => undefined} onPin={() => undefined} testID="unread" />
          <ConversationRow item={row('release-corner', false)} viewer="me" now={Date.now()} onPress={() => undefined} onPin={() => undefined} testID="read" />
        </Section>
        <Section title="3 · Emphasis by weight, default face Space Grotesk">
          <MonoMarkdown
            markdown={'The deploy did *not* finish; the helper restarted mid-cutover.'}
            textStyle={{
              fontFamily: theme.buzz.proseRegular,
              fontSize: theme.buzz.proseSize,
              lineHeight: theme.buzz.proseLineHeight,
              color: theme.buzz.ledgerBody,
            }}
          />
          <Text style={{ ...Typography.default(), ...theme.buzz.type.body, color: theme.buzz.dialogDanger, marginTop: 8 }}>
            Couldn't reach GitHub. Try again.
          </Text>
        </Section>
      </View>
      <View style={{ paddingTop: 56 }}>
        <Section title="5 · One Button: primary / secondary / brass">
          <View style={{ gap: 8 }}>
            <Button label="Continue" onPress={() => undefined} />
            <Button label="Not now" variant="secondary" onPress={() => undefined} />
            <Button label="Approve merge" variant="brass" onPress={() => undefined} />
          </View>
        </Section>
        <Section title="6 · Flat update prompt (no shadow, no elevation, radius 3)">
          <View style={{ height: 84, position: 'relative' }}>
            <UpdateReadyPrompt />
          </View>
        </Section>
        <Section title="6 · Dialog shadow (per-theme opacity)">
          <View style={{ padding: 24 }}>
            <HullFloatingSurface style={{ padding: 16 }}>
              <Text style={{ ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary }}>Archive this corner?</Text>
              <Text style={{ ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet }}>Its branch stays on GitHub.</Text>
            </HullFloatingSurface>
          </View>
        </Section>
        <Section title="7 · Corner approved link (44pt) · corner dropdown # mark">
          <WritePermissionOutcome status="allowed" subchannelId="c1" onOpen={() => undefined} />
          <DesktopRoomCorners
            item={{
              room: { id: 'r', name: 'alpha', updatedAt: 1 },
              openCorners: [
                { id: 'c1', name: 'Docs refresh', state: 'waiting', mine: true },
                { id: 'c2', name: 'Design fixes', state: 'working', mine: true },
              ],
            } as never}
            onOpen={() => undefined}
            renderDrag={(_id: string, child: React.ReactNode) => child}
          />
        </Section>
      </View>
    </Canvas>
  );
}

/** Class 5: the artifact, connector and notification cards on the TranscriptCard frame. */
function Frames() {
  return (
    <Canvas>
      <View>
        <Section title="5 · Artifact card on the TranscriptCard frame">
          <ArtifactCard
            attachment={{
              url: 'https://usebeeline.app/v1/media/9f0f6a50-1111-4222-8333-444455556666',
              name: 'notes.md',
              mimeType: 'text/markdown',
              size: 2048,
              kind: 'artifact',
              title: 'Release notes',
              author: 'hoots',
            } as never}
            authorHandle="hoots"
            isDesktop
          />
        </Section>
        <Section title="5 · Connector card on the TranscriptCard frame">
          <AppSignInCard
            message={message({
              appSignIn: {
                appId: 'app-slack',
                appKey: 'slack',
                name: 'Slack',
                ownerId: 'zeke',
                agentId: 'monarch',
                status: 'pending',
                continuation: 'Monarch posts the notes right after.',
              },
            })}
            agentName="Monarch"
            canConnect
            onConnect={() => undefined}
            busy={false}
          />
        </Section>
      </View>
      <View>
        <Section title="5 · Notification card on the TranscriptCard frame">
          <NotificationLifecycleCard
            message={message({
              notificationLifecycleRun: {
                headline: 'Check 2 passed',
                subline: '11:07 – 11:07',
                items: [
                  { id: 'build', title: 'Build', state: 'Checks passed', kindLine: 'check', kind: 'check' },
                  { id: 'lint', title: 'Lint', state: 'Checks passed', kindLine: 'check', kind: 'check' },
                ],
              },
            })}
            onOpenCorner={() => undefined}
            onOpenUrl={() => undefined}
          />
        </Section>
      </View>
    </Canvas>
  );
}

/** Class 7: the corner overflow sheet's Members row, as the corner surface renders it. */
function Members() {
  return (
    <HullActionSheetModal
      accessibilityLabel="Close corner actions"
      onClose={() => undefined}
      testID="corner-actions-sheet"
      title="#app/Sign-in retry"
      visible
    >
      <HullActionSheetRow
        accessibilityLabel="View 4 members"
        chevron="right"
        label="Members"
        metadata="4 members"
        onPress={() => undefined}
        testID="corner-participant-roster-trigger"
      />
      <HullActionSheetRow
        accessibilityLabel="Close corner"
        description="Ends the edit session and archives this corner. Unmerged work is lost."
        label="Close corner"
        destructive
        onPress={() => undefined}
      />
    </HullActionSheetModal>
  );
}

function Welcome() {
  return <WelcomeCards visible onDone={() => undefined} />;
}

const pages: Record<string, React.ComponentType> = {
  board: Board,
  frames: Frames,
  workflows: WorkflowsScreen,
  'text-selection': TextSelectionScreen,
  members: Members,
  'welcome-1': Welcome,
  'welcome-2': Welcome,
  'welcome-3': Welcome,
  'welcome-4': Welcome,
};

const Page = pages[page] ?? Board;
createRoot(document.getElementById('root')!).render(<Page />);

/** A welcome page past the first is reached by pressing Next, as a person would. */
const welcomeStep = /^welcome-(\d)$/.exec(page);
async function advance() {
  const steps = welcomeStep ? Number(welcomeStep[1]) - 1 : 0;
  for (let i = 0; i < steps; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    document.querySelector<HTMLElement>('[data-testid="welcome-next"]')?.click();
  }
  await new Promise((resolve) => setTimeout(resolve, 600));
  document.getElementById('result')!.textContent = 'READY';
}
void advance();
