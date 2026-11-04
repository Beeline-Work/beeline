// tsc compiles these negative capability assertions; this file is never executed.
import type { LiveConnection } from './live-connection';
function rejected(connection: LiveConnection): void {
  // @ts-expect-error raw RPCs cannot execute wallet writes
  void connection.request('sendFromWallet', {});
  // @ts-expect-error only the installed intent bridge holds the command executor
  void connection.requestCommand('markRead', {}, { v: 1, id: 'backdoor' });
}
void rejected;
function previewOnly(connection: LiveConnection): void {
  // @ts-expect-error the default read-and-mark-seen form is a command
  void connection.request('readNeedsYou', { workspaceId: 'w' });
  void connection.request('readNeedsYou', { workspaceId: 'w', markSeen: false });
}
void previewOnly;
