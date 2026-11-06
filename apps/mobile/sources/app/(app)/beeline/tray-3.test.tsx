import { layout, navigation, openExternal, phoneOperation, bookmark, need, serve, textOf, renderTray, fixtureScope9, fixtureScope10 } from "../../../test/fixtures/tray.test-support";
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { ButtonRow } from '@/components/buzz/ButtonRow';

describe('Tray section CLEAR', () => {
const scope9 = fixtureScope9();


  it('keeps the desktop Undo bar inside the list column', async () => {
    layout.os = 'web';
    layout.width = 1200;
    serve({ bookmarks: [bookmark()] });
    const tree = await renderTray();
    await act(async () => tree.root.findByProps({ testID: 'tray-clear-saved' }).props.onPress());
    const undo = tree.root.findByProps({ testID: 'tray-clear-undo' });
    const style = Object.assign({}, ...[undo.props.style].flat(Infinity as 1));
    expect(style.left + style.maxWidth).toBeLessThanOrEqual(390 - 16);
  });


  it('sends a held clear when the Tray closes', async () => {
    serve({ needs: [need()] });
    const tree = await renderTray();
    await act(async () => tree.root.findByProps({ testID: 'tray-clear-needs' }).props.onPress());
    await act(async () => tree.unmount());
    expect(scope9.calls('clearNeedsYouSection')).toHaveLength(1);
  });
});
describe('inline approval decisions in the tray', () => {
const scope10 = fixtureScope10();


  it.each([
    {
      action: { kind: 'grant', label: 'Approve once', grantId: 'grant-1', decision: 'once' },
      operation: 'decideAgentGrant',
      input: { grantId: 'grant-1', decision: 'once' },
    },
    {
      action: { kind: 'grant', label: 'Deny', grantId: 'grant-1', decision: 'deny' },
      operation: 'decideAgentGrant',
      input: { grantId: 'grant-1', decision: 'deny' },
    },
    {
      action: {
        kind: 'write-access',
        label: 'Approve',
        permissionId: 'p1',
        requestId: 'r1',
        agentId: 'a1',
        repository: 'owner/repo',
        decision: 'allow',
      },
      operation: 'decideWritePermission',
      input: {
        roomId: 'system-dm',
        permissionId: 'p1',
        requestId: 'r1',
        agentId: 'a1',
        repository: 'owner/repo',
        decision: 'allow',
      },
    },
    {
      action: {
        kind: 'write-access',
        label: 'Deny',
        permissionId: 'p1',
        requestId: 'r1',
        agentId: 'a1',
        repository: 'owner/repo',
        decision: 'deny',
      },
      operation: 'decideWritePermission',
      input: {
        roomId: 'system-dm',
        permissionId: 'p1',
        requestId: 'r1',
        agentId: 'a1',
        repository: 'owner/repo',
        decision: 'deny',
      },
    },
    {
      action: { kind: 'choice', label: 'Ship', choiceId: 'c1', optionId: 'A' },
      operation: 'answerChoice',
      input: { choiceId: 'c1', optionId: 'A' },
    },
    {
      action: { kind: 'skip-choice', label: 'Skip', choiceId: 'c1' },
      operation: 'skipChoice',
      input: { choiceId: 'c1' },
    },
  ])(
    'sends $operation directly without navigation or dismissal',
    async ({ action, operation, input }) => {
      layout.os = 'ios';
      layout.width = 390;
      let needs = [scope10.approvalItem([action])];
      phoneOperation.mockImplementation(async (name: string) => {
        if (name === 'readTray') return { needs: { items: needs }, saved: { bookmarks: [] } };
        if (name === 'readNeedsYou') return { items: needs };
        if (name === operation) needs = [];
      });
      const tree = await renderTray();
      await scope10.clickAction(tree);
      expect(phoneOperation).toHaveBeenCalledWith(operation, input);
      expect(phoneOperation).not.toHaveBeenCalledWith('clearNeedsYou', expect.anything());
      expect(navigation.push).not.toHaveBeenCalled();
      expect(tree.root.findAllByProps({ testID: 'needs-you-inline-1' })).toHaveLength(0);
    },
  );


  it('opens the Squire ceremony directly and leaves the item pending', async () => {
    const url = 'https://trustysquire.ai/vault/pay/pending';
    serve({
      needs: [scope10.approvalItem([{ kind: 'external', label: 'Approve', url }], { kind: 'squire' })],
    });
    const tree = await renderTray();
    // Squire's link is the cell's one primary Button, trailing in the action row.
    const row = tree.root.findAll((node: any) => node.type === ButtonRow)[0]!;
    expect(row.props.actions).toEqual([
      expect.objectContaining({
        label: 'Approve',
        variant: 'primary',
        accessibilityRole: 'button',
        destination: 'external',
      }),
    ]);
    phoneOperation.mockClear();
    await scope10.clickAction(tree);
    expect(openExternal).toHaveBeenCalledWith(url);
    expect(phoneOperation).not.toHaveBeenCalled();
    expect(navigation.push).not.toHaveBeenCalled();
    expect(tree.root.findAllByProps({ testID: 'needs-you-inline-1' }).length).toBeGreaterThan(0);
  });


  it('keeps a refused decision in the tray and explains the refusal', async () => {
    serve({
      needs: [
        scope10.approvalItem([{ kind: 'grant', label: 'Deny', grantId: 'grant-1', decision: 'deny' }]),
      ],
    });
    const tree = await renderTray();
    phoneOperation.mockImplementation(async () => {
      throw new Error('grant decision conflict: already decided');
    });
    await scope10.clickAction(tree);
    expect(textOf(tree)).toContain('grant decision conflict: already decided');
    expect(tree.root.findAllByProps({ testID: 'needs-you-inline-1' }).length).toBeGreaterThan(0);
  });
});
