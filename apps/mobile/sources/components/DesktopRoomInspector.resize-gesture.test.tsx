// @vitest-environment jsdom
//
// The right work-pane divider must behave exactly like the left navigation
// divider (see SidebarNavigator.resize-gesture.test.tsx): a col-resize
// handle whose PanResponder stays stable for the whole drag, a persisted
// width, and a ceiling that never squeezes the transcript below its minimum.
// This renders the real react-native-web PanResponder in jsdom and drives it
// with real mousedown/mousemove/mouseup events.
import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-dom/client has no declarations in this workspace.
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom has no ResizeObserver, so react-native-web's onLayout never fires.
// This stand-in lets a test report the row the work pane sits in.
const observed = vi.hoisted(() => new Set<Element>());
const resizeCallbacks = vi.hoisted(() => [] as ((entries: { target: Element }[]) => void)[]);
vi.hoisted(() => {
  (globalThis as any).ResizeObserver = class {
    constructor(callback: (entries: { target: Element }[]) => void) {
      resizeCallbacks.push(callback);
    }
    observe(node: Element) {
      observed.add(node);
    }
    unobserve(node: Element) {
      observed.delete(node);
    }
    disconnect() {}
  };
});

vi.mock('react-native', async () => {
  // @ts-expect-error react-native-web has no declarations in this workspace.
  const rnw = await import('react-native-web');
  return {
    FlatList: rnw.FlatList,
    PanResponder: rnw.PanResponder,
    Platform: rnw.Platform,
    Pressable: rnw.Pressable,
    Text: rnw.Text,
    TextInput: rnw.TextInput,
    View: rnw.View,
  };
});

const theme = vi.hoisted(() => ({
  colors: {
    groupped: { background: '#14091a' },
    divider: '#333',
    text: '#fff',
    textSecondary: '#aaa',
    textLink: '#b08a4a',
    surface: '#190e21',
  },
  buzz: {
    accent: '#b08a4a',
    radius: 3,
    bgHighlight: '#1e1326',
    type: { hero: {}, body: {}, bodyStrong: {}, meta: {}, machine: {}, sectionHead: {} },
  },
}));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    hairlineWidth: 1,
    create: (factory: any) => (typeof factory === 'function' ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
}));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: () => null }));
vi.mock('@/components/buzz/TurnProgressLine', () => ({ TurnProgressLine: () => null }));
vi.mock('@/components/buzz/ConversationComposer', () => ({
  COMPOSER_SINGLE_LINE_INPUT_HEIGHT: 26,
  COMPOSER_MAX_INPUT_HEIGHT: 115,
  ConversationComposer: () => null,
}));
vi.mock('@/components/buzz/Ledger', () => ({
  LedgerRoomUpdate: () => null,
  LedgerSystemLine: () => null,
  withLedgerDayCaption: (node: unknown) => node,
}));
vi.mock('@/app/(app)/beeline/chat/RoomMessageVariants', () => ({
  DaemonFactCard: () => null,
  GitHubEventCard: () => null,
  OrdinaryLedgerMessage: () => null,
}));
vi.mock('@/components/buzz/DesktopArtifactPane', () => ({ DesktopArtifactPane: () => null }));
vi.mock('@/components/buzz/SurfaceGlyphLoader', () => ({ SurfaceGlyphLoader: () => null }));
vi.mock('@/auth/buzz-identity-storage', () => ({ loadBuzzIdentity: vi.fn(async () => null) }));
vi.mock('@/sync/transport', () => ({ BuzzRigTransport: class {} }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: vi.fn() }));
vi.mock('@/modal', () => ({ Modal: { confirm: vi.fn() } }));

const loadDesktopPaneWidthMock = vi.hoisted(() => vi.fn(async () => 400));
const saveDesktopPaneWidthMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/buzz/desktop-workbench-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/buzz/desktop-workbench-state')>()),
  loadDesktopPaneWidth: loadDesktopPaneWidthMock,
  saveDesktopPaneWidth: saveDesktopPaneWidthMock,
}));

import { DESKTOP_TRANSCRIPT_MIN_WIDTH } from '@/buzz/desktop-workbench-state';
import { DesktopRoomInspector } from './DesktopRoomInspector';

const room = {
  room: { id: 'room-1', name: 'general', workspaceId: 'workspace' },
} as any;

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

beforeEach(() => {
  loadDesktopPaneWidthMock.mockClear();
  saveDesktopPaneWidthMock.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderInspector(): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(DesktopRoomInspector, {
        room,
        client: null,
        selectedCornerId: null,
        onSelectCorner: () => undefined,
        onOpenInMain: () => undefined,
        onClose: () => undefined,
        onNewCorner: () => undefined,
      }),
    );
    // Let the loadDesktopPaneWidth() effect resolve before dragging.
    await Promise.resolve();
    await Promise.resolve();
  });
}

function inspectorNode(): HTMLElement {
  const node = container.querySelector('[data-testid="desktop-inspector"]');
  if (!node) throw new Error('work pane not rendered');
  return node as HTMLElement;
}

function resizerNode(): HTMLElement {
  const node = container.querySelector('[data-testid="desktop-inspector-resizer"]');
  if (!node) throw new Error('resize handle not rendered');
  return node as HTMLElement;
}

function paneWidth(): number {
  return parseFloat(inspectorNode().style.width);
}

/** Lays the work pane out at the right edge of a row `rowWidth` wide. */
async function layOutRow(rowWidth: number): Promise<void> {
  const node = inspectorNode();
  Object.defineProperty(node, 'offsetWidth', { configurable: true, get: () => paneWidth() });
  Object.defineProperty(node, 'offsetLeft', {
    configurable: true,
    get: () => rowWidth - paneWidth(),
  });
  await act(async () => {
    for (const callback of resizeCallbacks) callback([{ target: node }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

let nextTimeStamp = 0;

function fireMouse(type: string, clientX: number, target: EventTarget) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 0 });
  Object.defineProperty(event, 'pageX', { value: clientX });
  Object.defineProperty(event, 'pageY', { value: 0 });
  Object.defineProperty(event, 'timeStamp', { value: (nextTimeStamp += 10) });
  act(() => {
    target.dispatchEvent(event);
  });
}

/** Drags the handle from `startX` to `startX + totalDx` in 10px steps. */
function drag(startX: number, totalDx: number): number[] {
  const widths: number[] = [];
  fireMouse('mousedown', startX, resizerNode());
  const step = totalDx > 0 ? 10 : -10;
  for (let dx = step; Math.abs(dx) < Math.abs(totalDx); dx += step) {
    fireMouse('mousemove', startX + dx, document);
    widths.push(paneWidth());
  }
  fireMouse('mousemove', startX + totalDx, document);
  widths.push(paneWidth());
  fireMouse('mouseup', startX + totalDx, document);
  return widths;
}

describe('DesktopRoomInspector resize handle (real gesture layer)', () => {
  it('is a col-resize handle straddling the pane edge, like the navigation divider', async () => {
    await renderInspector();
    const handle = resizerNode();
    expect(handle.style.cursor).toBe('col-resize');
    expect(handle.getAttribute('aria-label')).toBe('Resize work pane');
    expect(handle.style.left).toBe('-3px');
    expect(handle.style.width).toBe('7px');
  });

  it('tracks the cursor smoothly for the whole drag, not just the first frame', async () => {
    await renderInspector();
    expect(paneWidth()).toBe(400);

    // Dragging the left edge leftwards widens the pane. Stays within
    // [320, 480] so clamping never masks the assertion.
    const widths = drag(500, -50);

    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]).toBeGreaterThanOrEqual(widths[i - 1]);
    }
    expect(widths.at(-1)).toBe(450);
  });

  it('persists the width the user actually dragged to, not the pre-drag width', async () => {
    await renderInspector();
    drag(500, -50);

    expect(saveDesktopPaneWidthMock).toHaveBeenCalledWith('inspector', 450);
  });

  it('never squeezes the transcript below its minimum width', async () => {
    await renderInspector();
    const rowWidth = DESKTOP_TRANSCRIPT_MIN_WIDTH + 360;
    await layOutRow(rowWidth);

    // The stored 400px would leave the transcript 40px short; the pane yields.
    expect(paneWidth()).toBe(360);
    expect(rowWidth - paneWidth()).toBe(DESKTOP_TRANSCRIPT_MIN_WIDTH);

    drag(500, -80);
    expect(paneWidth()).toBe(360);
    expect(rowWidth - paneWidth()).toBeGreaterThanOrEqual(DESKTOP_TRANSCRIPT_MIN_WIDTH);
  });
});
