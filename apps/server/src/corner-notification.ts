import { questionForSql, questionLeavesAtSql } from './needs-you.js';

/** A delivered push, seen tray item, or currently available tray question. */
export function notifiedMessageSql(message: string, person: string): string {
  return `(EXISTS(SELECT 1 FROM push_delivery_claims delivery JOIN push_devices device ON device.token=delivery.device_token
      WHERE delivery.message_id=${message}.id AND device.identity_id=${person} AND delivery.status='delivered')
    OR EXISTS(SELECT 1 FROM needs_you_marks seen WHERE seen.message_id=${message}.id AND seen.identity_id=${person}
      AND seen.first_seen_at IS NOT NULL AND seen.cleared_at IS NULL)
    OR EXISTS(SELECT 1 FROM identities viewer
      LEFT JOIN needs_you_marks mark ON mark.message_id=${message}.id AND mark.identity_id=viewer.id
      WHERE viewer.id=${person} AND ${questionForSql('viewer.id',message)} AND ${questionLeavesAtSql(message)}>now())
    OR EXISTS(SELECT 1 FROM room_choices choice WHERE choice.message_id=${message}.id
      AND choice.mode='question' AND choice.status='open' AND (choice.closes_at IS NULL OR choice.closes_at>now()))
    OR ${message}.card_type IN ('grant-request','permission','squire-approval','connector-offer','app-sign-in','agent-sign-in'))`;
}

/** A currently blocking person has a real notification surface. Agent waits do not suppress supervision. */
export function cornerNotifiedPersonSql(corner: string): string {
  return `(EXISTS(SELECT 1 FROM corner_owed owed JOIN identities person ON person.id=owed.person_id AND person.kind='human'
      JOIN messages item ON item.id=owed.message_id WHERE owed.corner_id=${corner} AND owed.blocking
        AND (owed.expires_at IS NULL OR owed.expires_at>now()) AND ${notifiedMessageSql('item','owed.person_id')})
    OR EXISTS(SELECT 1 FROM corner_report_blockers report JOIN identities person ON person.id=report.person_id AND person.kind='human'
      JOIN messages item ON item.id=report.message_id WHERE report.corner_id=${corner}
        AND ${notifiedMessageSql('item','report.person_id')}))`;
}

