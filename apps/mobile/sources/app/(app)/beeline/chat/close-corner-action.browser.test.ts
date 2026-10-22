import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

describe.skipIf(!existsSync(CHROME))('R1: rendered close refusal', () => {
  it('renders the production refusal as a readable dialog after tapping Close corner', async () => {
    const mobile = process.cwd();
    const source = readFileSync(new URL('./_chat-surface.tsx', import.meta.url), 'utf8');
    const callback = source.slice(source.indexOf('  const [closingCorner, setClosingCorner]'), source.indexOf('  const handleCommunitySelect'));
    const directory = await mkdtemp(path.join(mobile, 'scripts/.close-corner-proof-'));
    try {
      const entry = path.join(directory, 'entry.tsx');
      await writeFile(entry, `import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { Screen } from 'close-corner-proof-screen';
        createRoot(document.getElementById('root')).render(<Screen />);
        setTimeout(() => document.querySelector('[data-testid="close-corner-action"]').click(), 500);
        setTimeout(() => {
          const dialog = document.querySelector('[data-testid="hull-alert-dialog"]');
          document.getElementById('result').textContent = dialog?.textContent || 'FAIL: no dialog';
        }, 1500);`);
      const result = await runBrowserProof({ entry, mobile, width: 390, height: 844,
        shims: {
          ...webProofShims(mobile),
          '@/auth/monolith-session': `export const MONOLITH_REQUEST_TIMEOUT_MS=10000; export const monolithSession = { fetch: async () => new Response(JSON.stringify({error:'close the corner pull request with close_corner_pr before closing the corner'}), {status:409}) };`,
          '@/buzz/runtime-config': `export const getBuzzRuntimeConfig = () => ({monolithUrl:'https://server.example'});`,
          'close-corner-proof-screen': `import React, {useState,useCallback,useEffect} from 'react';
            import { Modal } from '@/modal/ModalManager';
            import { WebAlertModal } from '@/modal/components/WebAlertModal';
            import { HullActionSheetRow } from '@/components/buzz/HullActionSheet';
            import { monolithPhoneOperation,phoneOperationFailureReason } from '@/sync/transport/monolith-operation';
            const Haptics={notificationAsync:async()=>{},NotificationFeedbackType:{Error:'error',Warning:'warning'}};
            const CORNER_LABEL='corner', decodedId='500f6c94-376b-4eed-a9b6-1f05059e558f';
            const transport={closeCorner:roomId=>monolithPhoneOperation('requestCornerClose',{roomId})};
            const handleBack=()=>{};
            export function Screen(){
              const [dialog,setDialog]=useState(null);
              useEffect(()=>Modal.setFunctions(config=>{setDialog(config);return 'proof';},()=>setDialog(null),()=>setDialog(null)),[]);
              ${callback}
              return <><HullActionSheetRow label="Close corner" destructive onPress={handleCloseCorner} testID="close-corner-action" />
                {dialog && <WebAlertModal config={dialog} onClose={()=>setDialog(null)} />}</>;
            }`,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.result).toContain('This corner still has an open pull request. Ask an agent to close the pull request, then try closing the corner again.');
      expect(result.result).not.toMatch(/Monolith|close_corner_pr/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);
});
