import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import TrayScreen from '../sources/app/(app)/beeline/tray';
import WorkbenchScreen from '../sources/app/(app)/beeline/settings/workbench';
import BuzzCorners from '../sources/app/(app)/beeline/corners/[roomId]';
import WorkspaceSettings from '../sources/app/(app)/beeline/settings/workspace';
import ChangelogScreen from '../sources/app/(app)/changelog';
import ScheduledWork from '../sources/app/(app)/beeline/settings/schedules';
import { cornerSectionsView } from './corner-sections-fixture';

// The shimmed RoomViewClient reads corners through this seam.
(globalThis as { cornerSectionsView?: typeof cornerSectionsView }).cornerSectionsView =
  cornerSectionsView;

/**
 * Paints one real section page (`?page=tray|workbench|corners|workspace|changelog|schedules`)
 * and reports
 * how its top header is drawn: where the back chevron sits, the title,
 * eyebrow and trailing type, and the divider under the header. The browser test compares
 * the three reports, so a page that drifts from the others fails.
 */
const page = new URLSearchParams(location.search).get('page') ?? 'tray';
const screens: Record<
  string,
  { Screen: React.ComponentType; title: string; eyebrow?: string; trailing?: string }
> = {
  tray: { Screen: TrayScreen, title: 'Tray', eyebrow: 'Workspace' },
  workbench: { Screen: WorkbenchScreen, title: 'Workbench', eyebrow: 'Settings' },
  corners: { Screen: BuzzCorners, title: 'Corners', eyebrow: '#alpha' },
  workspace: { Screen: WorkspaceSettings, title: 'Workspace' },
  changelog: { Screen: ChangelogScreen, title: "What's New" },
  schedules: { Screen: ScheduledWork, title: 'Scheduled Work', eyebrow: '#alpha' },
};

const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
const report = (text: string) => {
  document.getElementById('result')!.textContent = text;
};
const textNode = (text: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('#root *')).find(
    (node) => node.childElementCount === 0 && node.textContent === text,
  );

async function run() {
  const { Screen, title, eyebrow, trailing } = screens[page]!;
  createRoot(document.getElementById('root')!).render(<Screen />);
  for (let i = 0; i < 6; i += 1) await pause();

  const back = document.querySelector<HTMLElement>('[aria-label^="Back"]');
  const titleNode = textNode(title);
  const eyebrowNode = eyebrow ? textNode(eyebrow) : undefined;
  if (!back || !titleNode || (eyebrow && !eyebrowNode)) {
    throw new Error(
      `${page}: header parts missing (back ${!!back}, title ${!!titleNode}, eyebrow ${!!eyebrowNode})`,
    );
  }
  const header = back.parentElement!;
  const headerStyle = getComputedStyle(header);
  const titleStyle = getComputedStyle(titleNode);
  const eyebrowStyle = eyebrowNode ? getComputedStyle(eyebrowNode) : undefined;
  const trailingNode = trailing ? textNode(trailing) : undefined;
  if (trailing && !trailingNode) throw new Error(`${page}: trailing "${trailing}" missing`);
  const trailingStyle = trailingNode ? getComputedStyle(trailingNode) : undefined;
  report(
    JSON.stringify({
      page,
      backLeft: Math.round(back.getBoundingClientRect().left),
      backSize: Math.round(back.getBoundingClientRect().width),
      titleLeft: Math.round(titleNode.getBoundingClientRect().left),
      headerMinHeight: headerStyle.minHeight,
      divider: `${headerStyle.borderBottomWidth} ${headerStyle.borderBottomStyle}`,
      titleFont: `${titleStyle.fontSize} ${titleStyle.fontFamily}`,
      ...(eyebrowNode && eyebrowStyle
        ? {
            eyebrowFont: `${eyebrowStyle.fontSize} ${eyebrowStyle.fontFamily}`,
            eyebrowAboveTitle:
              eyebrowNode.getBoundingClientRect().bottom <=
              titleNode.getBoundingClientRect().top + 1,
          }
        : {}),
      ...(trailingStyle
        ? {
            trailingFont: `${trailingStyle.fontSize} ${trailingStyle.color} ${trailingStyle.textAlign}`,
          }
        : {}),
      // Every written word in the Corners header, so a count beside the add
      // button would show up here.
      ...(page === 'corners'
        ? {
            headerText: Array.from(header.querySelectorAll<HTMLElement>('*'))
              .filter((node) => node.childElementCount === 0 && node.textContent)
              .map((node) => node.textContent),
          }
        : {}),
    }),
  );
}

run().catch((error) => report(`FAIL ${String(error)}`));
