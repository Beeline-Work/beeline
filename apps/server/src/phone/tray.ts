import { phoneIdentity as identity } from '../phone-identity.js';
import { readMessageBookmarks } from '../tray-projection.js';
import { CommandRefusalError } from '../command-refusal.js';
import { clearNeedsYouQuestions, countNeedsYouItems, needsYouItems } from '../needs-you.js';
import type { PhoneContext } from './context.js';
import { Input, Output } from './types.js';

import { phoneRequireWorkspaceMember } from './access.js';
import { messageId } from './values.js';



  /**
   * The viewer's Needs-you cells (`needs-you.ts` owns the rule). Showing a
   * cell starts its 24-hour clock once, for every device; a clock already
   * running is left alone.
   */
  export async function phoneReadNeedsYou(ctx: PhoneContext, 
    input: Input<'readNeedsYou'>,
    viewerId: string,
  ): Promise<Output<'readNeedsYou'>> {
    return needsYouItems(
      ctx.database,
      input.workspaceId,
      viewerId,
      (row) => identity(row, ctx.publicOrigin),
      input.markSeen !== false,
    );
  }


  export async function phoneReadTray(ctx: PhoneContext, input: Input<'readTray'>, viewerId: string): Promise<Output<'readTray'>> {
    await phoneRequireWorkspaceMember(ctx, input.workspaceId, viewerId);
    const [needs, saved] = await Promise.allSettled([
      phoneReadNeedsYou(ctx, input, viewerId),
      phoneListMessageBookmarks(ctx, input, viewerId),
    ]);
    if (needs.status === 'rejected' && saved.status === 'rejected') throw needs.reason;
    return {
      ...(needs.status === 'fulfilled' ? { needs: needs.value } : {}),
      ...(saved.status === 'fulfilled' ? { saved: saved.value } : {}),
      ...(needs.status === 'rejected' ? { needsError: String(needs.reason) } : {}),
      ...(saved.status === 'rejected' ? { savedError: String(saved.reason) } : {}),
    };
  }


  export async function phoneCountNeedsYou(ctx: PhoneContext, 
    input: Input<'countNeedsYou'>,
    viewerId: string,
  ): Promise<Output<'countNeedsYou'>> {
    return countNeedsYouItems(ctx.database, input.workspaceId, viewerId);
  }


  /** A tap or a dismissal: the cell is handled, on every device. */
  export async function phoneClearNeedsYou(ctx: PhoneContext, input: Input<'clearNeedsYou'>, viewerId: string): Promise<void> {
    if (typeof input.messageId !== 'string' || !input.messageId)
      throw new Error('messageId is required');
    const cleared = await ctx.database.query(
      `INSERT INTO needs_you_marks(identity_id,message_id,workspace_id,cleared_at,reminder_dismissed_at)
       SELECT $1,message.id,room.workspace_id,now(),CASE WHEN $4::boolean THEN now() END
       FROM messages message
       JOIN rooms room ON room.id=message.room_id AND room.workspace_id=$3
       JOIN memberships member ON member.room_id=room.id AND member.identity_id=$1
         AND member.removed_at IS NULL
       WHERE message.id=$2
       ON CONFLICT(identity_id,message_id)
         DO UPDATE SET cleared_at=COALESCE(needs_you_marks.cleared_at,now()),
           reminder_dismissed_at=COALESCE(needs_you_marks.reminder_dismissed_at,EXCLUDED.reminder_dismissed_at)`,
      [viewerId, input.messageId, input.workspaceId, input.dismissReminder === true],
    );
    if (!cleared.rowCount) throw new CommandRefusalError('message is not available', 404);
  }


  export async function phoneClearNeedsYouSection(ctx: PhoneContext, 
    input: Input<'clearNeedsYouSection'>,
    viewerId: string,
  ): Promise<void> {
    await phoneRequireWorkspaceMember(ctx, input.workspaceId, viewerId);
    // Approval cards are dismissed for this viewer only. Their decision and
    // the paused agent's authority remain untouched.
    const { items } = await needsYouItems(ctx.database, input.workspaceId, viewerId, (row) =>
      identity(row, ctx.publicOrigin),
    );
    await clearNeedsYouQuestions(ctx.database, input.workspaceId, viewerId);
    const approvalIds = items.filter((item) => item.approval).map((item) => item.messageId);
    if (approvalIds.length) {
      await ctx.database.query(
        `INSERT INTO needs_you_marks(identity_id,message_id,workspace_id,cleared_at,reminder_dismissed_at)
         SELECT $1,id,$3,now(),now() FROM unnest($2::text[]) id
         ON CONFLICT(identity_id,message_id)
           DO UPDATE SET cleared_at=COALESCE(needs_you_marks.cleared_at,now()),
           reminder_dismissed_at=COALESCE(needs_you_marks.reminder_dismissed_at,EXCLUDED.reminder_dismissed_at)`,
        [viewerId, approvalIds, input.workspaceId],
      );
    }
  }


  export async function phoneListMessageBookmarks(ctx: PhoneContext, 
    input: Input<'listMessageBookmarks'>,
    viewerId: string,
  ): Promise<Output<'listMessageBookmarks'>> {
    return readMessageBookmarks(ctx.database, input, viewerId, row => identity(row, ctx.publicOrigin));
  }
