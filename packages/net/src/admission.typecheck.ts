// Compiled by tsc, never executed; erased imports do not expose a factory.
import type { AdmissionOwner, Pass } from './private/admission.js';
import type { RouteInput, RouteOutput } from './routes.js';
function rejected(owner: AdmissionOwner, room: Pass<'phone.readRoom'>): void {
  // @ts-expect-error unknown route
  const unknown: RouteInput<'phone.fetchUrl'> = {};
  // @ts-expect-error a Room read cannot spend an AppShell pass
  owner.spend({ route: 'phone.countNeedsYou', input: { workspaceId: 'w' } }, room);
  // @ts-expect-error wrong screen
  owner.focus(1, 'AppShell', [{ route: 'phone.readRoom', input: { roomId: 'r' } }]);
  // @ts-expect-error arbitrary action
  owner.tap('Timer', { route: 'phone.sendRoomMessage', input: { roomId: 'r', text: 'x' } }, () => {});
  // @ts-expect-error pass cannot be constructed by features
  const forged: Pass<'phone.readRoom'> = {};
  const count: RouteOutput<'phone.countNeedsYou'> = { count: 1 };
  // @ts-expect-error count result cannot invent a string count
  const invalid: RouteOutput<'phone.countNeedsYou'> = { count: '1' };
  void count; void invalid; void unknown; void forged;
}
void rejected;
