import { PhoneOperationError } from "./phone-operations.js";
import { WorkflowAuthorizationError } from "./workflow-admin.js";
import { CommandRefusalError } from "./commander.js";
import { WorkspaceSkillNotFoundError } from "./institutional-skills.js";
import { institutionalMemoryErrorStatus } from "./institutional-memory-shadow.js";
import { AGENT_OWNER_AUTHORITY_MESSAGE, WORKSPACE_ADMIN_AUTHORITY_MESSAGE, SPENDING_OWNER_AUTHORITY_MESSAGE, YOLO_AUTHORITY_MESSAGE, CONNECTOR_OFFER_AUTHORITY_MESSAGE, CONNECTOR_OFFER_WALLET_AUTHORITY_MESSAGE } from "./phone-service.js";
import { GitHubHttpError } from "@beeline/auth/github";





export function requestErrorStatus(error: unknown): number {
  if (error instanceof PhoneOperationError) return error.status;
  const message = error instanceof Error ? error.message : 'request failed';
  let status =
    error instanceof WorkflowAuthorizationError ||
    error instanceof CommandRefusalError ||
    error instanceof WorkspaceSkillNotFoundError
      ? error.status
      : institutionalMemoryErrorStatus(message) ??
        ((message.startsWith('corner brief attachment ') &&
            message.endsWith('is missing or unavailable in this Room')) ||
          message.includes('required') ||
          message.includes('invalid') ||
          message.includes('too large') ||
          message.includes('size is outside')
        ? 400
        : message === 'github_account_mismatch' ||
            message.includes('already linked') ||
            message.includes('already claimed') ||
            message.includes('conflict') ||
            message.includes('checks are failing')
          ? 409
          : message.includes('access denied') ||
              message.includes('command output authority rejected') ||
              message.includes('command turn cancelled') ||
              message.includes('command already completed') ||
              message.includes('manager') ||
              message.includes(AGENT_OWNER_AUTHORITY_MESSAGE) ||
              message.includes(WORKSPACE_ADMIN_AUTHORITY_MESSAGE) ||
              message.includes(SPENDING_OWNER_AUTHORITY_MESSAGE) ||
              message.includes('yolo cannot be enabled in a public workspace') ||
              message.includes(YOLO_AUTHORITY_MESSAGE) ||
              message.includes(CONNECTOR_OFFER_AUTHORITY_MESSAGE) ||
              message.includes(CONNECTOR_OFFER_WALLET_AUTHORITY_MESSAGE)
            ? 403
            : message.includes('not found')
              ? 404
              : 503);
  // GitHub's own outage or rate limit is a bad gateway, not this server
  // being unavailable; the message already names GitHub's status.
  if (error instanceof GitHubHttpError && (error.status >= 500 || error.status === 429 || error.rateLimited)) {
    status = 502;
  }
  return status;
}
