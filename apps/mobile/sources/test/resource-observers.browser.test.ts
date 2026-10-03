import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { runBrowserProof, webProofShims } from './browserProof';

describe('resource observers in the desktop web renderer', () => {
  it('demonstrates R9a–R9c through the mounted corner line, sign-in and inspector', async () => {
    const mobile = process.cwd();
    const directory = await mkdtemp(path.join(mobile, 'sources/test/observer-proof-'));
    try {
      const entry = path.join(directory, 'proof.tsx');
      await writeFile(entry, `import React from 'react'; import { createRoot } from 'react-dom/client';
        import SignIn from '@/app/(app)/beeline/settings/workbench/connect-signin';
        import Installer from '@/app/(app)/beeline/settings/workbench/connect';
        import { DesktopRoomInspector } from '@/components/DesktopRoomInspector';
        import { CornerObjectiveLine } from '@/components/buzz/CornerObjectiveLine';
        import { useCornerWorkflowRun } from '@/buzz/use-corner-workflow-run';
        const room = { room: { id: 'parent', name: 'Room' }, messages: [], members: [], corners: [], latestAgentTurns: [], viewer: { identity: { pubkey: 'a', name: 'Person' }, permissions: {} } };
        const client = { corners: async () => ({ corners: [] }), room: async id => {
          if (id === 'broken' && !globalThis.__recover) throw new Error('Selected corner unavailable');
          return { ...room, room: { id, name: 'Original corner', about: 'Original detail', archived: true } };
        } };
        function App() {
          const [id, select] = React.useState('original'); globalThis.__select = select;
          const workflow = useCornerWorkflowRun('corner');
          return <><CornerObjectiveLine objective="Observer proof" workflow={workflow} onOpenWorkflow={() => {}} />
            <SignIn /><Installer /><DesktopRoomInspector room={room} client={client} selectedCornerId={id} onSelectCorner={() => {}} onOpenInMain={() => {}} onNewCorner={() => {}} onClose={() => {}} /></>;
        }
        createRoot(document.getElementById('root')).render(<App />);
        const output = {};
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
          document.querySelector('[data-testid="desktop-corner-retry"]')?.click(); }, 8500);
        setTimeout(() => { output.retryReads = globalThis.__installReads;
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
        'expo-router': `export const useLocalSearchParams = () => ({ workspaceId: 'workspace', connectorId: 'install', connectorName: 'Squire', pairedConnectorId: 'install', offerId: 'offer', roomId: 'parent', url: 'https://example.test', method: 'oauth' }); export const router = { back() {}, replace() {}, push() {} };`,
        '@/sync/transport/live-connection': `export const sharedLiveConnection = () => ({ register: async () => () => undefined });`,
        '@/buzz/workbench-source': `export const getWorkbenchSource = () => ({ readInstallState: () => {
          globalThis.__installReads = (globalThis.__installReads ?? 0) + 1;
          if (globalThis.__installReads === 1) return new Promise(resolve => { globalThis.__release = resolve; });
          return Promise.resolve(null);
        } });`,
        '@/sync/transport/monolith-operation': `export const monolithPhoneOperation = async () => {
          globalThis.__workflowReads = (globalThis.__workflowReads ?? 0) + 1;
          return { workflows: [{ runId: 'run', roomId: 'corner', workflowSlug: 'corner', state: 'implement', status: 'live' }] };
        };`,
        '@/buzz/app-sign-in': `export const takeAppSignInReturn = async () => null;`,
        '@/components/AnimatedOverlay': `export const AnimatedBlurBackdrop = () => null;`,
        '@/components/buzz/sandbox-webview': `export const useSandboxWebView = () => null;`,
        '@/auth/buzz-identity-storage': `export const loadBuzzIdentity = async () => null;`,
        '@/sync/transport': `export class BuzzRigTransport {}`,
        '@/components/buzz/DesktopArtifactPane': `export const DesktopArtifactPane = () => null;`,
        '@/components/buzz/corner-brief-viewer': `export const openCornerBriefViewer = () => undefined;`,
        '@/components/buzz/IdentityMark': `export const IdentityMark = () => null;`,
        '@/components/buzz/ConversationComposer': `export const COMPOSER_MAX_INPUT_HEIGHT = 115; export const COMPOSER_SINGLE_LINE_INPUT_HEIGHT = 26; export const ConversationComposer = () => null;`,
        '@/app/(app)/beeline/chat/RoomMessageVariants': `export const DaemonFactCard = () => null; export const GitHubEventCard = () => null; export const NotificationLifecycleCard = () => null; export const OrdinaryLedgerMessage = () => null;`,
        '@/buzz/desktop-workbench-state': `export const DESKTOP_INSPECTOR_DEFAULT_WIDTH = 400; export const DESKTOP_INSPECTOR_MIN_WIDTH = 320; export const DESKTOP_TRANSCRIPT_MIN_WIDTH = 300;
          export const clampDesktopPaneWidth = (_, width) => width; export const desktopComposerKeyAction = () => null; export const loadDesktopPaneWidth = async () => 400; export const saveDesktopPaneWidth = async () => undefined;`,
      } });
      expect(result.status, result.stderr).toBe(0);
      console.log('Reproductions R9a–R9c desktop web:', result.result);
      const proof = JSON.parse(result.result);
      expect(proof).toMatchObject({ pendingReads: 1, initialTranscript: true, staleTranscript: false, workflowReads: 1, recoveredTranscript: true, terminalReads: 8, stoppedReads: 8, retryReads: 9 });
      expect(proof.signInError).toContain('Retry');
      expect(proof.installerError).toContain('Lost track');
      expect(proof.inspectorError).toContain('Selected corner unavailable');
      expect(proof.workflowText).toBeTruthy();
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 90000);

  it('Reproduction R9d: the open run changes status without refocusing', async () => {
    const mobile = process.cwd();
    const directory = await mkdtemp(path.join(mobile, 'sources/test/observer-proof-'));
    try {
      const entry = path.join(directory, 'proof.tsx');
      await writeFile(entry, `import React from 'react';
        import { createRoot } from 'react-dom/client';
        import WorkflowRun from '@/app/(app)/beeline/workflow-run';
        createRoot(document.getElementById('root')).render(<WorkflowRun />);
        setTimeout(() => { globalThis.__done = true;
          globalThis.__invalidate?.({ monolithLive: { type: 'invalidate', roomId: 'corner', reason: 'postgres:messages' } });
        }, 600);
        setTimeout(() => { document.getElementById('result').textContent = JSON.stringify({
          status: document.querySelector('[data-testid="workflow-run-status"]')?.textContent,
          reads: globalThis.__reads, errors: globalThis.__console });
        }, 1200);`);
      const detail = {
        run: { runId: 'run', workflowSlug: 'demo', description: 'Demo', roomId: 'corner', roomName: 'Corner', state: 'work', status: 'live', viewerHolds: false, startedAt: 1790000000, updatedAt: 1790000001, earlierRunCount: 0 },
        contract: { slug: 'demo', description: 'Demo', initial: 'work', roles: {}, states: { work: { kind: 'terminal' } } }, history: [],
      };
      const result = await runBrowserProof({ entry, mobile, width: 1000, shims: {
        ...webProofShims(mobile),
        'expo-router': `import React from 'react'; export const useFocusEffect = effect => React.useEffect(effect, [effect]);
          export const useLocalSearchParams = () => ({ roomId: 'corner', runId: 'run' }); export const router = { back() {}, replace() {}, push() {} };`,
        '@/auth/buzz-identity-storage': `export const loadBuzzIdentity = async () => ({ publicKey: 'a' });`,
        '@/sync/transport/live-connection': `export const sharedLiveConnection = () => ({ register: async (_, listener) => { globalThis.__invalidate = listener; return () => { delete globalThis.__invalidate; }; } });`,
        '@/sync/transport/monolith-operation': `export const monolithPhoneOperation = async () => {
          globalThis.__reads = (globalThis.__reads ?? 0) + 1; const detail = ${JSON.stringify(detail)};
          if (globalThis.__done) { detail.run.status = 'done'; detail.run.updatedAt = 1790000100; }
          return detail; };`,
      } });
      expect(result.status, result.stderr).toBe(0);
      console.log('Reproduction R9d desktop web:', result.result);
      expect(JSON.parse(result.result).status).toBe('Done');
      expect(JSON.parse(result.result).reads).toBe(2);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 90000);
});
