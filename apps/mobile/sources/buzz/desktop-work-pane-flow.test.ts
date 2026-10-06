import { describe, expect, it } from 'vitest';
import { openArtifactInDesktopWorkPane, subscribeDesktopArtifact } from './desktop-artifact-pane';
import { selectDesktopWorkCorner, subscribeDesktopWorkCorner } from './desktop-work-pane';
import {
  DESKTOP_WORK_PANE_THRESHOLD,
  desktopWorkPaneVisibleContent,
  initialDesktopWorkPaneState,
  transitionDesktopWorkPane,
  type DesktopWorkPaneEvent,
  type DesktopWorkPaneState,
} from './desktop-workbench-state';

/**
 * One desktop window walked through the events the rail and artifact cards
 * send. The host listens the way the Room surface does: a rail corner is
 * taken only by the view of its Room, a switch of view closes the pane, and an
 * artifact the pane cannot take falls back to the full-screen viewer.
 */
function desktopWindow(width: number) {
  let view: { id: string; roomId: string; primary: 'room' | 'corner' } = {
    id: 'room-a',
    roomId: 'room-a',
    primary: 'room',
  };
  let state: DesktopWorkPaneState = initialDesktopWorkPaneState(width);
  const log: string[] = [];
  const commit = (event: DesktopWorkPaneEvent) => {
    const transition = transitionDesktopWorkPane(state, event);
    state = transition.state;
    return transition;
  };
  const navigate = (id: string, roomId: string, primary: 'room' | 'corner') => {
    view = { id, roomId, primary };
    commit({ type: 'close' });
  };
  const subscribe = () => [
    subscribeDesktopWorkCorner(({ roomId, cornerId }) => {
      if (roomId !== view.roomId) return false;
      const transition = commit({ type: 'open-corner', cornerId, primary: view.primary });
      if (transition.placement === 'primary') navigate(cornerId, roomId, 'corner');
      return true;
    }),
    subscribeDesktopArtifact(
      (artifact) =>
        commit({ type: 'open-artifact', artifact, primary: view.primary }).placement === 'pane',
    ),
  ];
  let unsubscribe = subscribe();
  const resubscribe = () => {
    for (const stop of unsubscribe) stop();
    unsubscribe = subscribe();
  };
  const describePane = () => {
    const content = desktopWorkPaneVisibleContent(state);
    if (!content) return 'closed';
    return content.kind === 'corner'
      ? `corner ${content.cornerId}`
      : `artifact ${content.artifact.attachment.name}`;
  };
  return {
    step(label: string, action: () => void) {
      action();
      log.push(`${label} -> primary: ${view.id}, pane: ${describePane()}`);
    },
    railCorner(roomId: string, cornerId: string) {
      selectDesktopWorkCorner({ roomId, cornerId });
      // The rail opens the corner's Room first when another view is in front.
      if (view.id !== roomId && view.roomId !== roomId) {
        navigate(roomId, roomId, 'room');
        resubscribe();
      }
    },
    artifact(name: string) {
      const taken = openArtifactInDesktopWorkPane({
        attachment: { id: name, name, mimeType: 'text/html', size: 1, url: `/${name}` } as never,
      });
      if (!taken) log.push(`  ${name} opened in the full-screen viewer`);
    },
    expand() {
      const content = desktopWorkPaneVisibleContent(state);
      if (content?.kind !== 'corner') return;
      commit({ type: 'expand' });
      navigate(content.cornerId, view.roomId, 'corner');
    },
    log,
    dispose: () => unsubscribe.forEach((stop) => stop()),
  };
}

describe('desktop second pane, end to end through the module events', () => {
  it('holds one thing, opens only for artifacts and the Room’s corners, and closes on a switch', () => {
    const desk = desktopWindow(DESKTOP_WORK_PANE_THRESHOLD + 200);
    desk.step('open #room-a', () => undefined);
    desk.step('click artifact plan.html', () => desk.artifact('plan.html'));
    desk.step('click rail corner a-1 of #room-a', () => desk.railCorner('room-a', 'a-1'));
    desk.step('click artifact notes.html', () => desk.artifact('notes.html'));
    desk.step('click rail corner b-1 of #room-b', () => desk.railCorner('room-b', 'b-1'));
    desk.step('press Expand', () => desk.expand());
    desk.step('click artifact diff.html', () => desk.artifact('diff.html'));
    desk.step('click rail corner b-2 of #room-b', () => desk.railCorner('room-b', 'b-2'));
    desk.step('click rail corner a-2 of #room-a', () => desk.railCorner('room-a', 'a-2'));
    desk.dispose();
    console.info(['wide window:', ...desk.log].join('\n'));
    expect(desk.log).toEqual([
      'open #room-a -> primary: room-a, pane: closed',
      'click artifact plan.html -> primary: room-a, pane: artifact plan.html',
      'click rail corner a-1 of #room-a -> primary: room-a, pane: corner a-1',
      'click artifact notes.html -> primary: room-a, pane: artifact notes.html',
      'click rail corner b-1 of #room-b -> primary: room-b, pane: corner b-1',
      'press Expand -> primary: b-1, pane: closed',
      'click artifact diff.html -> primary: b-1, pane: artifact diff.html',
      'click rail corner b-2 of #room-b -> primary: b-2, pane: closed',
      'click rail corner a-2 of #room-a -> primary: room-a, pane: corner a-2',
    ]);
  });

  it('opens corners in the primary view and artifacts in the viewer in a narrow window', () => {
    const desk = desktopWindow(DESKTOP_WORK_PANE_THRESHOLD - 200);
    desk.step('click artifact plan.html', () => desk.artifact('plan.html'));
    desk.step('click rail corner a-1 of #room-a', () => desk.railCorner('room-a', 'a-1'));
    desk.dispose();
    console.info(['narrow window:', ...desk.log].join('\n'));
    expect(desk.log).toEqual([
      '  plan.html opened in the full-screen viewer',
      'click artifact plan.html -> primary: room-a, pane: closed',
      'click rail corner a-1 of #room-a -> primary: a-1, pane: closed',
    ]);
  });
});
