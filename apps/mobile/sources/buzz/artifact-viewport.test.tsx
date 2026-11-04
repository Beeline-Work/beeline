import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatDisplayMessage } from './room-view-presentation';
import { artifactObjectIdsFromVisibleRows, observeArtifactRows, setArtifactViewportActive, useArtifactRowVisible } from './artifact-viewport';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { setArtifactViewportActive('room-test', false); vi.restoreAllMocks(); });
const id = '11111111-1111-4111-8111-111111111111';
const row = { id: 'message', text: '', isUser: true, timestamp: 1, attachments: [{ url: `/v1/media/${id}`, name: 'image.png', mimeType: 'image/png', size: 2 }] } as ChatDisplayMessage;
describe('actual artifact viewport demand', () => {
  it('extracts only committed current media references from visible DTO rows', () => {
    expect(artifactObjectIdsFromVisibleRows([row, row, { ...row, id: 'pending', isPendingSend: true },
      { ...row, isAgentDraft: true }, { ...row, isAgentLiveTurn: true }, { ...row, deleted: true }])).toEqual([id]);
    expect(artifactObjectIdsFromVisibleRows([{ ...row, attachments: [{ ...row.attachments![0]!, expired: true }] }])).toEqual([]);
  });
  it('overscan and inactive Room owners remain hidden; real viewport entry and exit update only local visibility', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const states: boolean[] = [];
    function Consumer() { const visible = useArtifactRowVisible('message', true); states.push(visible); return null; }
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<Consumer />); }); expect(states.at(-1)).toBe(false);
    act(() => { observeArtifactRows('room-test', ['message']); }); expect(states.at(-1)).toBe(false);
    act(() => { setArtifactViewportActive('room-test', true); }); expect(states.at(-1)).toBe(true);
    act(() => { observeArtifactRows('room-test', ['other-row']); }); expect(states.at(-1)).toBe(false);
    act(() => { observeArtifactRows('room-test', ['message']); }); expect(states.at(-1)).toBe(true);
    act(() => { setArtifactViewportActive('room-test', false); }); expect(states.at(-1)).toBe(false);
    act(() => { tree.unmount(); });
  });
});
