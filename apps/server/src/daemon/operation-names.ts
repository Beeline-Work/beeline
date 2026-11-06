import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import { DAEMON_OPERATION_ROUTES } from './values.js';


export const DAEMON_OPERATION_NAMES = new Set(
  Object.keys(DAEMON_OPERATION_ROUTES) as (keyof DaemonOperationMap)[],
);
