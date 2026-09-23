/**
 * User-path proof for typed connector adapters.
 *
 * A person who pairs Squire or YouTube sees owner-only lifecycle and
 * Workbench controls; another requester is refused. Prints each verdict
 * the server and helper now take from the adapter.
 */
import {
  CONNECTOR_ADAPTER_DENIED,
  SQUIRE_CONNECTOR_ADAPTER,
  YOUTUBE_CONNECTOR_ADAPTER,
  connectorAdapter,
  connectorRequesterRole,
} from '../packages/api-contract/src/connector-adapter.js';

function line(label: string, value: string): void {
  process.stdout.write(`${label}: ${value}\n`);
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const owner = connectorRequesterRole('human-a', 'human-a');
const other = connectorRequesterRole('human-b', 'human-a');
if (owner !== 'owner' || other !== 'other') fail('requester role misfired');

if (connectorAdapter('trusty-squire') !== SQUIRE_CONNECTOR_ADAPTER)
  fail('Squire is not registered');
if (connectorAdapter('google-youtube') !== YOUTUBE_CONNECTOR_ADAPTER)
  fail('YouTube is not registered');
if (connectorAdapter('google-gmail') || connectorAdapter('tailscale'))
  fail('unmigrated kinds must not have an adapter yet');

const squireConnect = SQUIRE_CONNECTOR_ADAPTER.authorize('connect', owner);
const squireOther = SQUIRE_CONNECTOR_ADAPTER.authorize('disconnect', other);
const squireWorkbench = SQUIRE_CONNECTOR_ADAPTER.workbenchActions('connected');
if (!squireConnect.allowed) fail('Squire owner was refused connect');
if (squireOther.allowed || squireOther.reason !== CONNECTOR_ADAPTER_DENIED)
  fail('Squire other requester was not refused disconnect');
if (squireWorkbench.join(',') !== 'reconnect,disconnect,revoke-grants')
  fail(`Squire connected Workbench was ${squireWorkbench.join(',')}`);

const youtubeConnect = YOUTUBE_CONNECTOR_ADAPTER.authorize('connect', owner);
const youtubeRevoke = YOUTUBE_CONNECTOR_ADAPTER.authorize('revoke-grants', owner);
const youtubeOther = YOUTUBE_CONNECTOR_ADAPTER.authorize('disconnect', other);
const youtubeAssign = YOUTUBE_CONNECTOR_ADAPTER.assignmentKinds('connected');
if (!youtubeConnect.allowed) fail('YouTube owner was refused connect');
if (youtubeRevoke.allowed) fail('YouTube owner was offered vault revoke-grants');
if (youtubeOther.allowed || youtubeOther.reason !== CONNECTOR_ADAPTER_DENIED)
  fail('YouTube other requester was not refused disconnect');
if (youtubeAssign.join(',') !== 'refresh-google-grant')
  fail(`YouTube connected assignments were ${youtubeAssign.join(',')}`);

line('Squire owner connect', 'allowed');
line('Squire other disconnect', `refused (${squireOther.reason})`);
line('Squire connected Workbench', squireWorkbench.join(', '));
line('Squire installing Workbench', SQUIRE_CONNECTOR_ADAPTER.workbenchActions('installing').join(', '));
line('YouTube owner connect', 'allowed');
line('YouTube owner revoke-grants', 'refused');
line('YouTube other disconnect', `refused (${youtubeOther.reason})`);
line('YouTube connected assignments', youtubeAssign.join(', '));
line('YouTube connected Workbench', YOUTUBE_CONNECTOR_ADAPTER.workbenchActions('connected').join(', '));
line('observable', 'owner-only Squire and YouTube lifecycle; Workbench controls from workbenchActions(); stale reports cannot overwrite disconnect or re-pair');
