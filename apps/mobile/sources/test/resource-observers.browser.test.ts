import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { runBrowserProof, webProofShims } from './browserProof';

describe('resource observers in the desktop web renderer', () => {
  it('demonstrates R9a–R9c through the mounted corner line, sign-in and inspector', async () => {
    const mobile = process.cwd();
    const directory = await mkdtemp(path.join(mobile, 'sources/test/observer-proof-'));
    try {
      const entry = path.join(directory, 'proof.jsx');
      await writeFile(entry, `import React from 'react'; import { createRoot } from 'react-dom/client';
        import SignIn from '@/app/(app)/beeline/settings/workbench/connect-signin';
        import Installer from '@/app/(app)/beeline/settings/workbench/connect';
        import { DesktopRoomInspector } from '@/components/DesktopRoomInspector';
        import { CornerObjectiveLine } from '@/components/buzz/CornerObjectiveLine';
        import { useCornerWorkflowRun } from '@/buzz/use-corner-workflow-run';
        const room = { room: { id: 'parent', name: 'Room' }, messages: [], members: [], corners: [], latestAgentTurns: [], viewer: { identity: { pubkey: 'a', name: 'Person' }, role: 'owner', permissions: {} } };
        const client = { corners: async () => ({ corners: [] }), room: async id => {
          if (id === 'broken' && !globalThis.__recover) throw new Error('Selected corner unavailable');
          const detail = { ...room, room: { id, name: 'Original corner', about: 'Original detail', archived: false }, latestAgentTurns: [{ agentPubkey: 'b'.repeat(64), requestId: 'turn', status: 'working', requestedBy: 'a', createdAt: Date.now()/1000 }] };
          if (globalThis.__cornerReads) detail.messages = [{ id: 'sent', text: 'a new message', author: room.viewer.identity, presentation: 'message', createdAt: Date.now()/1000 }];
          if (id === 'original') { globalThis.__cornerReads = (globalThis.__cornerReads ?? 0) + 1;
            if (globalThis.__cornerReads === 2) return new Promise(resolve => { globalThis.__releaseCorner = () => resolve(detail); });
            if (globalThis.__cornerReads === 3) return new Promise(resolve => { globalThis.__releaseStop = () => resolve(detail); }); }
          return detail;
        } };
        function App() {
          const [id, select] = React.useState('original'); globalThis.__select = select;
          const workflow = useCornerWorkflowRun('corner');
          return <><CornerObjectiveLine objective="Observer proof" workflow={workflow.workflow} workflowError={workflow.error} onRetryWorkflow={workflow.retry} onOpenWorkflow={() => {}} />
            <SignIn /><Installer /><DesktopRoomInspector room={room} client={client} selectedCornerId={id} onSelectCorner={() => {}} onOpenInMain={() => {}} onNewCorner={() => {}} onClose={() => {}} /></>;
        }
        createRoot(document.getElementById('root')).render(<App />);
        const output = {};
        setTimeout(() => { globalThis.__transcript = document.querySelector('[data-testid="desktop-work-corner-transcript"]');
          globalThis.__composer.onChangeText('a new message'); }, 300);
        setTimeout(() => { globalThis.__composer.onSend(); }, 400);
        setTimeout(() => { output.sameTranscript = globalThis.__transcript === document.querySelector('[data-testid="desktop-work-corner-transcript"]');
          output.loaderDuringRefresh = !!document.querySelector('[data-testid="desktop-corner-loader"]');
          output.sentBeforeRead = !globalThis.__composer.disabled; globalThis.__releaseCorner(); }, 800);
        setTimeout(() => { output.sentAfterRead = !globalThis.__composer.disabled; output.messageVisible = document.getElementById('root').textContent.includes('a new message'); }, 1100);
        setTimeout(() => { globalThis.__stopSettled = false; globalThis.__composer.onStop().then(() => { globalThis.__stopSettled = true; }); }, 1200);
        setTimeout(() => { output.stoppedBeforeRead = globalThis.__stopSettled; globalThis.__releaseStop(); }, 1400);
        setTimeout(() => { output.stoppedAfterRead = globalThis.__stopSettled; }, 1600);
        setTimeout(() => { output.pendingReads = globalThis.__installReads;
          output.initialTranscript = !!document.querySelector('[data-testid="desktop-work-corner-transcript"]');
          globalThis.__release(null); globalThis.__select('broken'); }, 1800);
        setTimeout(() => { output.terminalReads = globalThis.__installReads;
          output.signInError = document.querySelector('[data-testid="signin-retry"]')?.textContent;
          output.installerError = document.querySelector('[data-testid="connect-error"]')?.textContent;
          output.inspectorError = document.querySelector('[data-testid="desktop-corner-retry"]')?.textContent;
          output.staleTranscript = !!document.querySelector('[data-testid="desktop-work-corner-transcript"]'); }, 7600);
        setTimeout(() => { output.stoppedReads = globalThis.__installReads;
          document.querySelector('[data-testid="signin-retry"]')?.click();
          globalThis.__recover = true;
          globalThis.__roomListeners.broken?.({ monolithLive: { type: 'invalidate', roomId: 'broken', reason: 'message' } });
          document.querySelector('[data-testid="connect-pair-retry"]')?.click(); }, 8500);
        setTimeout(() => { output.retryReads = globalThis.__installReads; output.repaired = globalThis.__repaired; output.returnedToInstaller = globalThis.__backs;
          output.recoveredTranscript = !!document.querySelector('[data-testid="desktop-work-corner-transcript"]');
          output.workflowReads = globalThis.__workflowReads;
          output.workflowText = document.querySelector('[data-testid="corner-objective-line-workflow-copy"]')?.textContent;
          document.getElementById('result').textContent = JSON.stringify(output); }, 9000);`);
      const shims = webProofShims(mobile);
      shims['react-native-unistyles'] = shims['react-native-unistyles'].replace('buzz: beelineThemes.obsidian', `buzz: beelineThemes.obsidian, colors: { groupped: { background: '#171717' }, divider: '#333', text: '#eee', textSecondary: '#aaa', surface: '#222' }`);
      const result = await runBrowserProof({ entry, mobile, width: 1200, budgetMs: 10000, shims: {
        ...shims,
        '@expo/vector-icons': `export const Ionicons = () => null; export const FontAwesome = () => null;`,
        'expo-web-browser': `export const openBrowserAsync = async () => undefined;`,
        'expo-router': `export const useLocalSearchParams = () => ({ workspaceId: 'workspace', connectorId: 'install', connectorName: 'Squire', pairedConnectorId: 'install', offerId: 'offer', roomId: 'parent', url: 'https://example.test', method: 'oauth' }); export const router = { back() { globalThis.__backs = (globalThis.__backs ?? 0) + 1; }, replace() {}, push() {} };`,
        '@/sync/transport/live-connection': `globalThis.__roomListeners = {}; export const sharedLiveConnection = () => ({ register: async (filters, listener) => { const id = filters[0]['#h'][0]; globalThis.__roomListeners[id] = listener; return () => { delete globalThis.__roomListeners[id]; }; } });`,
        '@/buzz/workbench-source': `export const getWorkbenchSource = () => ({ readInstallState: ({ connectorId }) => {
          globalThis.__installReads = (globalThis.__installReads ?? 0) + 1;
          if (connectorId === 'fresh-row') return Promise.resolve({ connectorId, connected: true, steps: [] });
          if (globalThis.__installReads === 1) return new Promise(resolve => { globalThis.__release = resolve; });
          return Promise.resolve(null);
        } });`,
        '@/sync/transport/monolith-operation': `export const monolithPhoneOperation = async operation => {
          if (operation === 'cancelAgentTurn') return {};
          if (operation === 'acceptConnectorOffer') { globalThis.__repaired = true; return { connectorId: 'fresh-row' }; }
          globalThis.__workflowReads = (globalThis.__workflowReads ?? 0) + 1;
          return { workflows: [{ runId: 'run', roomId: 'corner', workflowSlug: 'corner', state: 'implement', status: 'live' }] };
        };`,
        '@/buzz/app-sign-in': `export const takeAppSignInReturn = async () => null;`,
        '@/components/AnimatedOverlay': `export const AnimatedBlurBackdrop = () => null;`,
        '@/components/buzz/sandbox-webview': `export const useSandboxWebView = () => null;`,
        '@/auth/buzz-identity-storage': `export const loadBuzzIdentity = async () => ({ pubkey: 'a' });`,
        '@/sync/transport': `export class BuzzRigTransport { async composeMessage() { return {}; } async publishPreparedMessage() {} }`,
        '@/components/buzz/DesktopArtifactPane': `export const DesktopArtifactPane = () => null;`,
        '@/components/buzz/corner-brief-viewer': `export const openCornerBriefViewer = () => undefined;`,
        '@/components/buzz/IdentityMark': `export const IdentityMark = () => null;`,
        '@/components/buzz/ConversationComposer': `export const COMPOSER_MAX_INPUT_HEIGHT = 115; export const COMPOSER_SINGLE_LINE_INPUT_HEIGHT = 26; export const ConversationComposer = props => { globalThis.__composer = props; return null; };`,
        '@/app/(app)/beeline/chat/RoomMessageVariants': `export const DaemonFactCard = () => null; export const GitHubEventCard = () => null; export const NotificationLifecycleCard = () => null; export const OrdinaryLedgerMessage = ({ message }) => <span>{message.text}</span>;`,
        '@/buzz/desktop-workbench-state': `export const DESKTOP_INSPECTOR_DEFAULT_WIDTH = 400; export const DESKTOP_INSPECTOR_MIN_WIDTH = 320; export const DESKTOP_TRANSCRIPT_MIN_WIDTH = 300;
          export const clampDesktopPaneWidth = (_, width) => width; export const desktopComposerKeyAction = () => null; export const loadDesktopPaneWidth = async () => 400; export const saveDesktopPaneWidth = async () => undefined;`,
      } });
      expect(result.status, result.stderr).toBe(0);
      console.log('Reproductions R9a–R9c desktop web:', result.result);
      const proof = JSON.parse(result.result);
      expect(proof).toMatchObject({ pendingReads: 1, initialTranscript: true, staleTranscript: false, workflowReads: 1, recoveredTranscript: true, terminalReads: 8, stoppedReads: 8, retryReads: 9, returnedToInstaller: 1, sameTranscript: true, loaderDuringRefresh: false, sentBeforeRead: false, sentAfterRead: true, repaired: true, messageVisible: true, stoppedBeforeRead: false, stoppedAfterRead: true });
      expect(proof.signInError).toContain('Retry');
      expect(proof.installerError).toContain('Lost track');
      expect(proof.inspectorError).toContain('Selected corner unavailable');
      expect(proof.workflowText).toBe('Implement');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 90000);

  it('Reproductions R9d and R9-OBS-01: the open run updates and recovers on reconnect', async () => {
    const mobile = process.cwd();
    const directory = await mkdtemp(path.join(mobile, 'sources/test/observer-proof-'));
    try {
      const entry = path.join(directory, 'proof.jsx');
      await writeFile(entry, `import React from 'react';
        import { createRoot } from 'react-dom/client';
        import WorkflowRun from '@/app/(app)/beeline/workflow-run';
        createRoot(document.getElementById('root')).render(<WorkflowRun />);
        setTimeout(() => document.querySelector('[data-testid="workflow-change-owner"]')?.click(), 200);
        setTimeout(() => document.querySelector('[aria-label="Make Second agent the workflow owner"]')?.click(), 400);
        setTimeout(() => { globalThis.__invalidate?.({ monolithLive: { type: 'subscribed', roomId: 'corner' } }); globalThis.__offline = true;
          globalThis.__invalidate?.({ monolithLive: { type: 'invalidate', roomId: 'corner', reason: 'postgres:messages' } });
        }, 600);
        setTimeout(() => { globalThis.__failureText = document.getElementById('root').textContent; globalThis.__offline = false; globalThis.__done = true;
          globalThis.__invalidate?.({ monolithLive: { type: 'subscribed', roomId: 'corner' } }); }, 1000);
        setTimeout(() => { document.getElementById('result').textContent = JSON.stringify({
          ownerText: document.querySelector('[data-testid="workflow-ownership"]')?.textContent, failureText: globalThis.__failureText, status: document.querySelector('[data-testid="workflow-run-status"]')?.textContent,
          reads: globalThis.__reads, errors: globalThis.__console });
        }, 1600);`);
      const detail = {
        run: { runId: 'run', workflowSlug: 'demo', description: 'Demo', roomId: 'corner', roomName: 'Corner', state: 'work', status: 'live', viewerHolds: false, startedAt: 1790000000, updatedAt: 1790000001, earlierRunCount: 0 },
        ownership: { owner: { id: 'first', name: 'First agent' }, canTransfer: true, ownerCandidates: [{ id: 'second', name: 'Second agent' }] },
        contract: { slug: 'demo', description: 'Demo', initial: 'work', roles: {}, states: { work: { kind: 'terminal' } } }, history: [],
      };
      const result = await runBrowserProof({ entry, mobile, width: 1000, shims: {
        ...webProofShims(mobile),
        'expo-router': `import React from 'react'; export const useFocusEffect = effect => React.useEffect(effect, [effect]);
          export const useLocalSearchParams = () => ({ roomId: 'corner', runId: 'run' }); export const router = { back() {}, replace() {}, push() {} };`,
        '@/auth/buzz-identity-storage': `export const loadBuzzIdentity = async () => ({ publicKey: 'a' });`,
        '@/sync/transport/live-connection': `export const sharedLiveConnection = () => ({ register: async (_, listener) => { globalThis.__invalidate = listener; return () => { delete globalThis.__invalidate; }; } });`,
        '@/components/buzz/IdentityMark': `export const IdentityMark = () => null;`,
        '@/sync/transport/monolith-operation': `export const monolithPhoneOperation = async operation => {
          if (operation === 'transferWorkflowOwner') { globalThis.__transferred = true; return {}; }
          globalThis.__reads = (globalThis.__reads ?? 0) + 1; if (globalThis.__offline) throw new Error('offline'); const detail = ${JSON.stringify(detail)};
          if (globalThis.__transferred) detail.ownership.owner = { id: 'second', name: 'Second agent' };
          if (globalThis.__done) { detail.run.status = 'done'; detail.run.updatedAt = 1790000100; }
          return detail; };`,
      } });
      expect(result.status, result.stderr).toBe(0);
      console.log('Reproductions R9d and R9-OBS-01 desktop web:', result.result);
      expect(JSON.parse(result.result).status).toBe('Done');
      expect(JSON.parse(result.result).failureText).toContain('offline');
      expect(JSON.parse(result.result).reads).toBe(4);
      expect(JSON.parse(result.result).ownerText).toContain('Second agent');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 90000);
  it('Reproductions R9-OBS-06 and R12k: one inline workflow notice per failure streak, with Retry', async () => {
    const mobile = process.cwd();
    const directory = await mkdtemp(path.join(mobile, 'sources/test/observer-proof-'));
    try {
      const entry = path.join(directory, 'proof.jsx');
      await writeFile(entry, `import React from 'react'; import { createRoot } from 'react-dom/client';
        import { CornerObjectiveLine } from '@/components/buzz/CornerObjectiveLine';
        import { useCornerWorkflowRun } from '@/buzz/use-corner-workflow-run';
        function App() {
          const run = useCornerWorkflowRun('corner');
          return <CornerObjectiveLine objective="Workflow proof" workflow={run.workflow} workflowError={run.error} onRetryWorkflow={run.retry} onOpenWorkflow={() => {}} />;
        }
        let visible = false, notices = 0;
        const errorLine = () => document.querySelector('[data-testid="corner-objective-line-workflow-error"]');
        new MutationObserver(() => { const present = !!errorLine(); if (present && !visible) notices++; visible = present; })
          .observe(document.getElementById('root'), { childList: true, subtree: true });
        createRoot(document.getElementById('root')).render(<App />);
        const push = () => globalThis.__listener({ monolithLive: { type: 'invalidate', roomId: 'corner', reason: 'message' } });
        setTimeout(() => globalThis.__listener({ monolithLive: { type: 'subscribed', roomId: 'corner' } }), 150);
        for (let i = 1; i <= 5; i++) setTimeout(push, i * 200);
        setTimeout(() => { globalThis.__streakNotices = notices; globalThis.__streakText = errorLine()?.textContent; globalThis.__recover = true; push(); }, 1200);
        setTimeout(() => { globalThis.__clearedAfterSuccess = !errorLine(); }, 1400);
        setTimeout(() => { globalThis.__recover = false; push(); }, 1500);
        setTimeout(() => { globalThis.__secondError = errorLine()?.textContent; globalThis.__noticesAfterSuccess = notices;
          globalThis.__recover = true; document.querySelector('[data-testid="corner-objective-line-workflow-retry"]')?.click(); }, 1800);
        setTimeout(() => { document.getElementById('result').textContent = JSON.stringify({
          streakNotices: globalThis.__streakNotices, noticesAfterSuccess: globalThis.__noticesAfterSuccess,
          streakText: globalThis.__streakText, visibleError: globalThis.__secondError,
          clearedAfterSuccess: globalThis.__clearedAfterSuccess, retryRecovered: !errorLine(), reads: globalThis.__reads }); }, 2100);`);
      const result = await runBrowserProof({ entry, mobile, width: 1000, budgetMs: 2500, shims: {
        ...webProofShims(mobile),
        '@/sync/transport/live-connection': `export const sharedLiveConnection = () => ({ register: async (_, listener) => { globalThis.__listener = listener; return () => {}; } });`,
        '@/sync/transport/monolith-operation': `export const monolithPhoneOperation = async () => {
          globalThis.__reads = (globalThis.__reads ?? 0) + 1;
          await new Promise(resolve => setTimeout(resolve, 80));
          if (!globalThis.__recover) throw new Error('offline ' + globalThis.__reads); return { workflows: [] };
        };`,
      } });
      expect(result.status, result.stderr).toBe(0);
      console.log('Reproductions R9-OBS-06 and R12k desktop web:', result.result);
      expect(JSON.parse(result.result)).toMatchObject({ streakNotices: 1, noticesAfterSuccess: 2, reads: 9, clearedAfterSuccess: true, retryRecovered: true, streakText: 'offline 1Retry', visibleError: 'offline 8Retry' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 90000);

});
