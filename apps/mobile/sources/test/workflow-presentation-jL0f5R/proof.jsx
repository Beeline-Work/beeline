import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { CornerObjectiveLine } from '@/components/buzz/CornerObjectiveLine';
      import { useRoomWorkflowRun } from '@/buzz/use-room-workflow-run';
      import { workflowRunHref } from '@/buzz/workflow-run-copy';
      function Corner({ roomId }) {
        const { workflow, error, retry } = useRoomWorkflowRun(roomId);
        return <CornerObjectiveLine objective="Build the agreed change" workflow={workflow}
          workflowError={error} onRetryWorkflow={retry} testID={roomId}
          onOpenWorkflow={() => { window.opened = workflowRunHref(workflow); }} />;
      }
      createRoot(document.getElementById('root')).render(<><Corner roomId="plain"/><Corner roomId="saved"/></>);
      setTimeout(() => {
        const plain = document.querySelector('[data-testid="plain"]');
        const saved = document.querySelector('[data-testid="saved-workflow"]');
        saved?.click();
        document.getElementById('result').textContent = JSON.stringify({
          objective: plain?.textContent, plainGlyphs: plain?.querySelectorAll('svg').length,
          plainLinks: plain?.querySelectorAll('[role="link"]').length,
          savedLabel: saved?.getAttribute('aria-label'), opened: window.opened,
        });
      }, 1500);