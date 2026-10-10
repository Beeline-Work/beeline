import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { CornerObjectiveLine } from '@/components/buzz/CornerObjectiveLine';
      import { useRoomWorkflowRun } from '@/buzz/use-room-workflow-run';
      import { workflowRunHref } from '@/buzz/workflow-run-copy';
      import regularFont from '@/assets/fonts/SpaceGrotesk-Regular.ttf';
      const fontStyle = document.createElement('style');
      fontStyle.textContent = '@font-face{font-family:SpaceGrotesk-Regular;src:url(' + regularFont + ')}';
      document.head.appendChild(fontStyle);
      function Corner() {
        const { workflow, otherLiveRuns } = useRoomWorkflowRun('mm-corner');
        return <CornerObjectiveLine workflow={workflow} otherLiveRuns={otherLiveRuns}
          onOpenBrief={() => { window.briefOpened = true; }}
          onOpenWorkflow={run => { window.opened = workflowRunHref(run); }} />;
      }
      createRoot(document.getElementById('root')).render(<Corner/>);
      setTimeout(() => {
        const more = document.querySelector('[data-testid="corner-objective-line-workflow-more"]');
        const primary = document.querySelector('[data-testid="corner-objective-line-workflow-copy"]');
        window.before = { primary: primary?.textContent, count: more?.textContent,
          role: more?.getAttribute('role'), label: more?.getAttribute('aria-label'),
          height: more?.getBoundingClientRect().height,
          sameLine: more?.getBoundingClientRect().top === document.querySelector('[data-testid="corner-objective-line-brief"]')?.getBoundingClientRect().top,
          overflow: document.documentElement.scrollWidth > innerWidth };
        more?.click();
      }, 1000);
      setTimeout(() => {
        const rows = [...document.querySelectorAll('[data-testid^="corner-objective-line-workflow-other-"]')];
        window.labels = rows.map(row => row.textContent);
        rows.find(row => row.textContent.includes('Macro paper desk'))?.click();
      }, 1400);
      setTimeout(() => {
        // Chrome's virtual clock may retain the fading Modal until animationend.
        // A dismissed Modal disables pointer events immediately while it fades.
        const sheet = document.querySelector('[data-testid="corner-objective-line-workflow-list"]');
        let closed = !sheet;
        for (let node = sheet; node; node = node.parentElement) {
          if (getComputedStyle(node).pointerEvents === 'none') closed = true;
        }
        document.getElementById('result').textContent = JSON.stringify({ ...window.before,
          rows: window.labels, opened: window.opened ?? null,
          closed,
          briefOpened: Boolean(window.briefOpened) });
      }, 1800);