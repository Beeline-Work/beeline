import { routes } from './routes.js';
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
  const acknowledgement: ReturnType<typeof routes['phone.markRead']['result']['parse']> = null;
  // @ts-expect-error void is explicitly null on the wire
  const missingAck: ReturnType<typeof routes['phone.markRead']['result']['parse']> = undefined;
  // @ts-expect-error binary upload is not a JSON socket operation
  const socketUpload: typeof routes['phone.uploadMedia']['transport'] = 'main-socket';
  void acknowledgement; void missingAck; void socketUpload;
  void count; void invalid; void unknown; void forged;
}
void rejected;
