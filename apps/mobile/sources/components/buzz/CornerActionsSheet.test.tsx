import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
vi.mock('./HullActionSheet', () => ({
  HullActionSheetModal: (props: any) =>
    React.createElement('Sheet', props, props.visible ? props.children : null),
  HullActionSheetRow: (props: any) => React.createElement('Row', props),
  HullActionSheetCancel: (props: any) => React.createElement('Cancel', props),
}));
vi.mock('./CornerLockAction', () => ({ CornerLockAction: () => null }));
import { CornerActionsSheet as FixedCornerActionsSheet } from './CornerActionsSheet';
import { HullActionSheetModal, HullActionSheetRow, HullActionSheetCancel } from './HullActionSheet';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// For the requested before proof, render the exact main sheet JSX and close
// handler in a narrow harness. This avoids mounting the whole chat runtime.
function mainSheet() {
  const source = readFileSync(
    new URL('../../app/(app)/beeline/chat/_chat-surface.tsx', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('  const [closingCorner, setClosingCorner]');
  const handler = source.slice(start, source.indexOf('  const handleCommunitySelect', start));
  const sheetStart = source.indexOf(
    '      <HullActionSheetModal\n        accessibilityLabel={`Close ${CORNER_LABEL} actions`}',
  );
  const sheet = source.slice(sheetStart, source.indexOf('\n      <HullDialog', sheetStart));
  const body = `return function MainSheet(props) {
    const { useState, useCallback } = React;
    const decodedId = 'corner', CORNER_LABEL = 'corner';
    const transport = {closeCorner:props.closeCorner};
    const handleBack = props.onClosed;
    const Haptics = {notificationAsync:()=>Promise.resolve(),NotificationFeedbackType:{Warning:1,Error:2}};
    const Modal = {alert:(_title,error)=>props.onError(error)};
    const cornerActionsVisible = props.visible;
    const setCornerActionsVisible = ()=>props.onClose();
    const headerTitle = props.title, cornerOwnerDisplay = null;
    const roomSurface = {}, refreshSignal = {force:()=>{}};
    ${handler}
    return (${sheet});
  }`;
  const js = ts.transpile(body, { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 });
  return new Function(
    'React',
    'HullActionSheetModal',
    'HullActionSheetRow',
    'HullActionSheetCancel',
    'CornerLockAction',
    js,
  )(React, HullActionSheetModal, HullActionSheetRow, HullActionSheetCancel, () => null);
}
const CornerActionsSheet =
  process.env.WAITING_BASELINE === '1' ? mainSheet() : FixedCornerActionsSheet;

describe('Reproduction R1: Close corner back while waiting', () => {
  it.each(['back', 'cancel', 'backdrop'])(
    '%s dismisses a pending close and ignores its late success',
    async (method) => {
      let resolve!: () => void;
      const onClose = vi.fn();
      const onClosed = vi.fn();
      const onError = vi.fn();
      const props = {
        visible: true,
        title: 'Corner',
        locked: false,
        connected: true,
        onClose,
        closeCorner: () =>
          new Promise<void>((done) => {
            resolve = done;
          }),
        setLocked: vi.fn(),
        onClosed,
        onSaved: vi.fn(),
        onError,
      };
      let tree: any;
      await act(async () => {
        tree = create(<CornerActionsSheet {...props} />);
      });
      await act(async () => {
        tree.root.findByType('Row').props.onPress();
      });
      expect(tree.root.findByType('Row').props.label).toBe('Closing corner…');
      await act(async () => {
        const sheet = tree.root.findByType('Sheet');
        if (method === 'backdrop') expect(sheet.props.dismissOnBackdrop).not.toBe(false);
        const button = method === 'cancel' ? tree.root.findByType('Cancel') : sheet;
        expect(button.props.disabled).not.toBe(true);
        (method === 'cancel' ? button.props.onPress : button.props.onClose)();
      });
      expect(onClose).toHaveBeenCalledOnce();
      await act(async () => {
        tree.update(<CornerActionsSheet {...props} visible={false} />);
        resolve();
      });
      expect(onClosed).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      await act(async () => tree.unmount());
    },
  );
  it('shows an error and enables retry when the action times out', async () => {
    const error = new Error('The result is unknown. Refresh to check before trying again.');
    const onError = vi.fn();
    let tree: any;
    await act(async () => {
      tree = create(
        <CornerActionsSheet
          visible
          title="Corner"
          locked={false}
          connected
          onClose={vi.fn()}
          closeCorner={() => Promise.reject(error)}
          setLocked={vi.fn()}
          onClosed={vi.fn()}
          onSaved={vi.fn()}
          onError={onError}
        />,
      );
    });
    await act(async () => tree.root.findByType('Row').props.onPress());
    expect(onError).toHaveBeenCalledWith(error);
    expect(tree.root.findByType('Row').props.disabled).toBe(false);
    await act(async () => tree.unmount());
  });
});
