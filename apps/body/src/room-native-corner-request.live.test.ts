/**
 * Live proof that a permission-capable Room agent initiates an edit-corner
 * request through ACP itself. This drives the installed codex-acp adapter and
 * a real model turn; there is no relay and no text-marker extraction in the
 * loop. Body's relay ceremony and post-approval creation are covered in
 * body.test.ts, where the same permission payload reaches
 * handleRoomPermissionRequest.
 *
 * Soft-skips when codex-acp or its model credentials are unavailable. Once a
 * prompt completes successfully, failing to request a mutating tool is a real
 * regression rather than a skip.
 */
import { describe, expect, it } from 'vitest';
import { AcpClient, isMutatingPermissionRequest, type AcpPermissionRequest } from './acp.js';
import { roomEditPolicyInstructions } from './body.js';

const ADAPTER = process.env.BUZZY_LIVE_CORNER_ADAPTER ?? 'codex-acp';
const REPO_ROOT = new URL('../../..', import.meta.url).pathname;

describe('native edit-corner request against a real permission-capable harness', () => {
  it('turns a plain change request into session/request_permission without a text sentinel', async () => {
    const permissions: AcpPermissionRequest[] = [];
    const client = new AcpClient({
      agentCommand: ADAPTER,
      agentLabel: ADAPTER,
      agentEnv: {},
      inheritProcessEnv: true,
      autoApprovePermissions: false,
      permissionHandler: async (request) => {
        permissions.push(request);
        return 'reject';
      },
    });

    let agentText = '';
    try {
      await client.start();
      const session = await client.sessionNew({
        cwd: REPO_ROOT,
        mode: 'readonly',
        systemPrompt: [
          'You are a coding assistant in a read-only Room.',
          'The current checkout must remain unchanged until a human approves an edit corner.',
          ...roomEditPolicyInstructions('repository', ADAPTER),
        ].join('\n'),
      });
      const result = await client.sessionPrompt(
        session.sessionId,
        'Add a short native-corner-request proof note to README.md. Do the requested work.',
        180_000,
      );
      agentText = result.agentText;
    } catch (error) {
      if (permissions.length === 0) {
        console.warn(
          `[live] ${ADAPTER} or its credentials unavailable; skipping native corner proof (${String(error)})`,
        );
        return;
      }
      // A harness may report the rejected operation as a failed turn. The
      // permission event is still the end-to-end fact this test exercises.
    } finally {
      await client.stop();
    }

    const mutation = permissions.find(isMutatingPermissionRequest);
    expect(mutation).toBeDefined();
    expect(agentText).not.toContain('CORNER_REQUEST:');
    console.info(
      `[live] human: Add a short native-corner-request proof note to README.md. Do the requested work.\n` +
        `[live] ACP session/request_permission: ${mutation?.toolCall?.title ?? mutation?.toolCall?.kind ?? 'mutation'}\n` +
        `[live] agent: ${agentText.trim() || '(adapter ended after the host rejected the in-Room mutation)'}`,
    );
  }, 240_000);
});
