import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { NewRoomDialog } from '../sources/components/buzz/NewRoomDialog';

/**
 * Android draws the bottom sheet behind the 3-button navigation bar, which
 * covers the bottom `insets.bottom` pixels of the screen. This paints the real
 * New Room sheet at phone size with a 48px bottom inset (`?inset=` overrides
 * it), lays an opaque bar of that height over the page, and measures the space
 * between the bottom of the Cancel / Create Room footer and the bar's top edge.
 */
const INSET = Number(new URLSearchParams(location.search).get('inset') ?? 48);

const pause = () => new Promise((resolve) => setTimeout(resolve, 250));
const report = (text: string) => {
  document.getElementById('result')!.textContent = text;
};
const byTestID = (testID: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${testID}"]`);

async function read() {
  const root = document.getElementById('root')!;
  root.style.cssText = 'height:100vh';
  createRoot(root).render(
    <NewRoomDialog
      visible
      roomName="fantastik"
      setRoomName={() => undefined}
      inviteOnly={false}
      setInviteOnly={() => undefined}
      creatingRoom={false}
      createRoom={() => undefined}
      onClose={() => undefined}
      pendingRepo={null}
      showRepoPicker={false}
      handleToggleRepoPicker={() => undefined}
      handleSelectNoRepository={() => undefined}
      handleSelectRepoCandidate={() => undefined}
      repoCandidates={[]}
      repoInstallations={[]}
      repoPickerError={null}
    />,
  );
  await pause();
  await pause();

  const bar = document.createElement('div');
  bar.id = 'system-nav-bar';
  bar.style.cssText = `position:fixed;left:0;right:0;bottom:0;height:${INSET}px;background:#fff;z-index:9999`;
  document.body.appendChild(bar);
  const barTop = window.innerHeight - INSET;

  const cancel = byTestID('create-room-cancel');
  const submit = byTestID('create-room-submit');
  if (!cancel || !submit) return report('FAIL the New Room footer never painted');
  const footerBottom = Math.round(
    Math.max(cancel.getBoundingClientRect().bottom, submit.getBoundingClientRect().bottom),
  );
  const gap = barTop - footerBottom;
  const facts = `viewport=${window.innerHeight} inset=${INSET} barTop=${barTop} footerBottom=${footerBottom} gap=${gap}`;
  report(`${gap >= 12 ? 'PASS' : 'FAIL'} ${facts}`);
}

read().catch((error) => report(`FAIL ${String(error)}`));
