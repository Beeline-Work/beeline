import { type DaemonAttachment, readAgentUsage, usageSummary, usageIsOld, type RoomConversationResult, type CornerRestoreResult, cornerTextRefusal, type ConnectResult } from "@beeline/api-contract/daemon";
import { withoutImageData, deliverAttachments, attachmentId } from "./attachment-delivery.js";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { beelineManagedSkills, runningBeelineReleaseId } from "./beeline-skill.js";
import { nonhumanSilentWake } from "./silent-wake.js";
import { writeFileSync } from "node:fs";
import { scratchBudgetMessage, allocatedDirectoryBytes } from "./scratch-lifecycle.js";
import { normalizeAppContinuation } from "@beeline/api-contract/app-connections";
import { squireSessionSignedIn } from "./squire-sign-in.js";
import { JsonObject, readTurnContextFile, daemonExecute, requiredEnv, downloadAttachment, memorySources, activeCommandContext, commandRequest, fetchImage, asObject, stringArg, connectorOfferDepsFromEnv } from './read-only-mcp.js';
import { agentScheduleRoomId, reactToMessage, postArtifact, bindBriefFiles, agentScheduleDepsFromEnv } from './read-only-mcp-download-attachment.js';
import { reportFeedback, openCorner, reviseCornerBrief, readCornerBrief, closeCorner, prChecksStatus, approveMerge, targetCornerId, writeScratchFile } from './read-only-mcp-open-corner.js';
import { shareBrowser, requestGrant, listGrants, workbenchStatus } from './read-only-mcp-agent-grant-deps.js';
import { runGrantedCommand } from './read-only-mcp-open-poll.js';









export async function executeAgentOperation(
  name: string, args: JsonObject, toolCallId: string,
): Promise<string> {
  if (process.env.BEELINE_TURN_CONTEXT_FILE && (await readTurnContextFile()).terminalReason)
    throw new Error('turn has ended; further tool calls are refused');
  switch (name) {
    case 'get_room_message': {
      const message = await daemonExecute('getRoomMessage', {
        roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
        messageId: args.messageId,
        ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
      });
      const attachments = (message.attachments ?? []) as DaemonAttachment[];
      if (!attachments.length) return JSON.stringify(message);
      const scratch = process.env.BEELINE_ATTACH_SCRATCH_ROOT?.trim();
      const delivered = scratch
        ? withoutImageData(
            await deliverAttachments(
              attachments,
              join(
                scratch,
                'beeline-attachments',
                createHash('sha256').update(String(message.messageId)).digest('hex'),
              ),
            ),
          )
        : attachments.map((attachment) => ({
            attachment,
            reason: 'download failed: no session scratch directory',
          }));
      return JSON.stringify({
        ...message,
        attachments: delivered.map(({ attachment, ...local }) => ({
          ...attachment,
          ...(attachmentId(attachment) ? { id: attachmentId(attachment) } : {}),
          ...local,
        })),
      });
    }
    case 'download_attachment':
      return downloadAttachment(args);
    case 'load_workspace_skill': {
      // Workspace procedures retain precedence over shipped skills with the same slug.
      try {
        return JSON.stringify(await daemonExecute('loadWorkspaceSkill', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          slug: args.slug,
        }));
      } catch (error) {
        // Only a missing procedure falls back; authorization and service failures stay visible.
        if (!(error instanceof Error) || !error.message.startsWith('daemon operation loadWorkspaceSkill failed (404:'))
          throw error;
        const skill = beelineManagedSkills(runningBeelineReleaseId(), { isReviewer: true })
          .find((candidate) => candidate.name === args.slug);
        if (!skill) throw error;
        return JSON.stringify({ slug: skill.name, markdown: skill.content, source: 'built-in' });
      }
    }
    case 'save_skill':
      return JSON.stringify(
        await daemonExecute('saveSkill', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          slug: args.slug,
          description: args.description,
          markdown: args.markdown,
        }),
      );
    case 'delete_skill':
      return JSON.stringify(
        await daemonExecute('deleteSkill', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          slug: args.slug,
          version: args.version,
          sourceMessageIds: memorySources(args),
        }),
      );
    case 'save_workflow':
      return JSON.stringify(
        await daemonExecute('saveWorkflow', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          contract: args.contract,
        }),
      );
    case 'start_workflow':
      return JSON.stringify(
        await daemonExecute('startWorkflow', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
          name: args.name,
          roleBindings: args.roleBindings,
        }),
      );
    case 'get_workflow_run':
      return JSON.stringify(await daemonExecute('getWorkflowRun', {
        agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
        roomId: agentScheduleRoomId(),
        runId: args.runId,
      }));
    case 'cancel_workflow_run':
      return JSON.stringify(await daemonExecute('cancelWorkflowRun', {
        agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
        roomId: agentScheduleRoomId(),
        runId: args.runId,
        reason: args.reason,
      }));
    case 'handoff':
      return JSON.stringify(
        await daemonExecute('handoff', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
          runId: args.runId,
          outcome: args.outcome,
          contents: args.contents,
          ...(args.receipt !== undefined ? { receipt: args.receipt } : {}),
          ...(args.attempt !== undefined ? { attempt: args.attempt } : {}),
        }),
      );
    case 'archive_workflow':
      return JSON.stringify(
        await daemonExecute('archiveWorkflow', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          name: args.name,
        }),
      );
    case 'assign_workflow_role':
      return JSON.stringify(
        await daemonExecute('assignWorkflowRole', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
          runId: args.runId,
          role: args.role,
          targetAgentId: args.agentId,
        }),
      );
    case 'search_history':
      return JSON.stringify(
        await daemonExecute('searchInstitutionalHistory', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          query: args.query,
          ...(typeof args.limit === 'number' ? { limit: Math.floor(args.limit) } : {}),
        }),
      );
    case 'search_memory':
      return JSON.stringify(
        await daemonExecute('searchInstitutionalMemory', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          query: args.query,
          ...(typeof args.limit === 'number' ? { limit: Math.floor(args.limit) } : {}),
        }),
      );
    case 'report_feedback':
      return reportFeedback(args);
    case 'notify_feedback_fixed':
      return JSON.stringify(
        await daemonExecute('notifyFeedbackFixed', {
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          itemIds: Array.isArray(args.item_ids) ? args.item_ids : [],
          title: String(args.title ?? ''),
          prUrl: String(args.pr_url ?? ''),
          ...(typeof args.notify === 'boolean' ? { notify: args.notify } : {}),
        }),
      );
    case 'save_memory':
      return JSON.stringify(
        await daemonExecute('saveInstitutionalMemory', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          memoryKind: args.subject_is_requester ? 'human_profile_fact' : 'workspace_fact',
          canonicalKey: args.canonical_key,
          body: args.body,
          keywords: Array.isArray(args.keywords) ? args.keywords : [],
          sourceMessageIds: memorySources(args),
          personAsked: args.person_asked,
          confidence: args.confidence,
        }),
      );
    case 'update_memory':
      return JSON.stringify(
        await daemonExecute('updateInstitutionalMemory', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          itemId: args.item_id,
          version: args.version,
          body: args.body,
          ...(Array.isArray(args.keywords) ? { keywords: args.keywords } : {}),
          sourceMessageIds: memorySources(args),
          personAsked: args.person_asked,
        }),
      );
    case 'delete_memory':
      return JSON.stringify(
        await daemonExecute('deleteInstitutionalMemory', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          itemId: args.item_id,
          version: args.version,
          reason: args.reason,
          sourceMessageIds: memorySources(args),
          personAsked: args.person_asked,
        }),
      );
    case 'report_memory_used':
      return JSON.stringify(
        await daemonExecute('reportInstitutionalMemoryUsed', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          itemIds: Array.isArray(args.item_ids) ? args.item_ids : [],
          snapshotItems: Array.isArray(args.snapshot_items) ? args.snapshot_items : [],
        }),
      );
    case 'wallet_address':
      return JSON.stringify(
        await daemonExecute('getWalletToolState', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
        }),
      );
    case 'wallet_balance':
      return JSON.stringify(
        await daemonExecute('getWalletToolBalance', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
        }),
      );
    case 'wallet_chains':
      return JSON.stringify(
        await daemonExecute('getWalletToolChains', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
        }),
      );
    case 'wallet_history':
      return JSON.stringify(
        await daemonExecute('getWalletToolHistory', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
          ...(typeof args.limit === 'number' ? { limit: Math.floor(args.limit) } : {}),
        }),
      );
    case 'wallet_quote':
      return JSON.stringify(
        await daemonExecute('getWalletToolQuote', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
          ...(typeof args.chain === 'string' ? { chain: args.chain } : {}),
          asset: String(args.asset ?? 'usdc'),
          amount: String(args.amount ?? ''),
        }),
      );
    case 'wallet_pay':
      return JSON.stringify(
        await daemonExecute('walletPay', {
          completionV1: true,
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
          ...(typeof args.chain === 'string' ? { chain: args.chain } : {}),
          asset: String(args.asset ?? 'usdc'),
          amount: String(args.amount ?? ''),
          to: String(args.to ?? ''),
        }),
      );
    case 'wallet_swap':
      return JSON.stringify(
        await daemonExecute('walletSwap', {
          completionV1: true,
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
          ...(typeof args.chain === 'string' ? { chain: args.chain } : {}),
          fromAsset: String(args.fromAsset ?? 'usdc'),
          toAsset: String(args.toAsset ?? 'eth'),
          amount: String(args.amount ?? ''),
        }),
      );
    case 'wallet_contract_call': {
      const approve = args.approve as JsonObject | undefined;
      return JSON.stringify(
        await daemonExecute('walletContractCall', {
          completionV1: true,
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
          chain: String(args.chain ?? ''),
          contract: String(args.contract ?? ''),
          data: String(args.data ?? ''),
          ...(typeof args.value === 'string' ? { value: args.value } : {}),
          ...(approve && typeof approve === 'object'
            ? { approve: { asset: String(approve.asset ?? ''), amount: String(approve.amount ?? '') } }
            : {}),
        }),
      );
    }
    case 'wallet_sign_typed_data':
      return JSON.stringify(
        await daemonExecute('walletSignTypedData', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
          domain: args.domain,
          types: args.types,
          primaryType: args.primaryType,
          message: args.message,
        }),
      );
    case 'set_corner_hold':
      return JSON.stringify(
        await daemonExecute('setCornerHold', {
          ...await activeCommandContext(),
          cornerId: typeof args.cornerId === 'string'
            ? args.cornerId : requiredEnv('BEELINE_DAEMON_CORNER_ID'),
          ...(typeof args.sourceMessageId === 'string' ? { sourceMessageId: args.sourceMessageId } : {}),
          ...(args.releaseHoldId !== undefined ? { releaseHoldId: args.releaseHoldId } : {}),
        }),
      );
    case 'send_operator_system_dm':
      return JSON.stringify(await daemonExecute('sendOperatorSystemDm', {
        ...await activeCommandContext(),
        agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
        recipients: args.recipients as string | string[], text: String(args.text ?? ''),
      }));
    case 'read_operator_system_dm':
      return JSON.stringify(await daemonExecute('readOperatorSystemDm', {
        ...await activeCommandContext(),
        agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'), sendId: String(args.sendId ?? ''),
      }));
    case 'order_corner_merge':
      return JSON.stringify(
        await daemonExecute('orderCornerMerge', {
          ...await activeCommandContext(),
          cornerId: typeof args.cornerId === 'string'
            ? args.cornerId : requiredEnv('BEELINE_DAEMON_CORNER_ID'),
        }),
      );
    case 'open_corner':
      return openCorner(args, toolCallId);
    case 'revise_corner_brief':
      return reviseCornerBrief(args);
    case 'read_corner_brief':
      return readCornerBrief(args);
    case 'read_agent_usage': {
      // The server answers only for the token's own agent; no provider is called here.
      const usage = readAgentUsage(
        await daemonExecute('getAgentUsage', { agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID') }),
      );
      return JSON.stringify({
        summary: usageSummary(usage),
        ...(usage ? { usage, old: usageIsOld(usage) } : {}),
      });
    }
    case 'order': {
      const result = await daemonExecute('order', { address: args.address as string, text: args.text as string, agent: args.agent as string | undefined });
      return JSON.stringify(result);
    }
    case 'stop':
      return JSON.stringify(await daemonExecute('stopAgentTurn', { address: args.address as string, agent: args.agent as string | undefined }));
    case 'no_reply_needed': {
      await activeCommandContext();
      const context = await readTurnContextFile();
      const selected = (context.commands as {requestId:string;commandReason:string}[] | undefined)?.find(command => command.requestId === commandRequest.getStore());
      const commandReason = selected?.commandReason ?? context.commandReason;
      if (!args.messageId && !nonhumanSilentWake(commandReason)) throw new Error('no_reply_needed requires a nonhuman report, order, lifecycle, scheduler or system wake. Call post({text: <your reply>}), then end the turn.');
      await daemonExecute('markAgentTurnSilent', { ...(args.messageId ? { messageId: args.messageId } : {}) });
      // The server ends only this request. End the invocation after delivering
      // its tool result; intake consumes the other wakes seen by this turn.
      const path = requiredEnv('BEELINE_TURN_CONTEXT_FILE');
      writeFileSync(path, JSON.stringify({ ...context, terminalReason: 'no-reply' }), { mode: 0o600 });
      return JSON.stringify({ acknowledged: true });
    }
    case 'report':
      return JSON.stringify(await daemonExecute('report', { status: args.status as import('@beeline/api-contract/daemon').AgentReportStatus, text: args.text as string, ask: args.ask as string | undefined, to: args.to as string | undefined }));
    case 'inspect_corner': {
      if (typeof args.cornerId !== 'string' || !args.cornerId)
        throw new Error('cornerId is required');
      if (args.after !== undefined && (typeof args.after !== 'string' || !args.after))
        throw new Error('after must be a nonempty cursor');
      if (args.mode !== undefined && args.mode !== 'status' && args.mode !== 'transcript')
        throw new Error('mode must be status or transcript');
      if (args.after && args.mode !== 'transcript')
        throw new Error('after requires transcript mode');
      if (args.from !== undefined && args.from !== 'oldest' && args.from !== 'newest')
        throw new Error('from must be oldest or newest');
      if (args.from !== undefined && args.mode !== 'transcript')
        throw new Error('from requires transcript mode');
      if (args.before !== undefined && (typeof args.before !== 'string' || !args.before))
        throw new Error('before must be a nonempty cursor');
      if (args.before && args.from !== 'newest') throw new Error('before requires from newest');
      if (args.from === 'newest' && (args.after || args.offset !== undefined))
        throw new Error('from newest pages with before, not after or offset');
      if (
        args.offset !== undefined &&
        (!Number.isSafeInteger(args.offset) ||
          (args.offset as number) < 0 ||
          args.mode !== 'transcript')
      )
        throw new Error('offset requires transcript mode and a nonnegative safe integer');
      // The server authorizes each read against the target corner: a member of
      // the corner or of its parent Room reaches it; anyone else is refused.
      const itemLimit = Math.min(typeof args.limit === 'number' ? args.limit : 8, 8);
      // Time-only cursors exclude the entire millisecond in either direction.
      for (const direction of ['before', 'after'] as const) {
        const value = args[direction];
        if (typeof value === 'string' && /^\d+$/.test(value))
          args[direction] = `${value},${(direction === 'before' ? '0' : 'f').repeat(64)}`;
      }
      const hasContent = (item: RoomConversationResult['items'][number]) =>
        Boolean(item.body.trim() || item.attachments.length || item.systemEvent);
      // Bound reads even when an entire stretch contains only activity. Keep
      // the raw scan boundary so the next call can advance through that stretch.
      const readMessagePage = async (newest: boolean) => {
        const rows: RoomConversationResult['items'][number][] = [];
        let boundary = (newest ? args.before : args.after) as string | undefined;
        let more = false;
        for (let scan = 0; scan < 16; scan++) {
          const page = await daemonExecute('getRoomConversation', {
            roomId: args.cornerId as string,
            limit: itemLimit + 1,
            ...(newest ? { window: 'recent' as const, ...(boundary ? { before: boundary } : {}) }
              : boundary ? { after: boundary } : { window: 'earliest' as const }),
          }) as unknown as RoomConversationResult;
          const batch = page.items;
          if (newest) rows.unshift(...batch);
          else rows.push(...batch);
          const nextBoundary = (newest ? batch[0] : batch.at(-1))?.cursor;
          more = batch.length === itemLimit + 1;
          if (!more || rows.filter(hasContent).length > itemLimit || !nextBoundary || nextBoundary === boundary) break;
          boundary = nextBoundary;
        }
        return { items: rows.filter(hasContent).map(item => item.systemEvent && !item.body.trim()
            ? { ...item, body: JSON.stringify(item.systemEvent) } : item), more,
          boundary: (newest ? rows[0] : rows.at(-1))?.cursor };
      };
      if (args.mode === 'transcript' && args.from === 'newest') {
        const page = await readMessagePage(true);
        // Walk back from the newest message; return the kept rows in transcript order.
        const items: Record<string, unknown>[] = [];
        for (const item of page.items.slice(-itemLimit).reverse()) {
          let body = item.body.slice(0, 1000);
          const row = {
            id: item.id,
            cursor: item.cursor,
            authorId: item.authorId,
            createdAt: item.createdAt,
            type: item.type,
            ...(item.attachments.length ? { attachmentCount: item.attachments.length } : {}),
          };
          while (body && JSON.stringify([...items, { ...row, body }]).length > 11000)
            body = body.slice(0, Math.floor(body.length / 2));
          if (!body && item.body) break;
          items.unshift({
            ...row,
            body,
            ...(body.length < item.body.length ? { bodyContinues: true } : {}),
          });
        }
        const oldest = items[0]?.cursor as string | undefined;
        return JSON.stringify({
          cornerId: args.cornerId,
          items,
          ...((page.items.length > items.length || page.more) && (oldest || page.boundary)
            ? { next: { before: page.items.length > items.length ? oldest : page.boundary } } : {}),
          limits: { items: itemLimit, bodyChars: 1000, responseChars: 12000 },
        });
      }
      if (args.mode === 'transcript') {
        const page = await readMessagePage(false);
        const items: Record<string, unknown>[] = [];
        let nextAfter = args.after as string | undefined;
        let nextOffset = args.offset as number | undefined;
        let hasMore = false;
        for (const item of page.items.slice(0, itemLimit)) {
          const offset = nextOffset ?? 0;
          if (offset > item.body.length) throw new Error('offset exceeds message body');
          let body = item.body.slice(offset, offset + 1000);
          const row = {
            id: item.id,
            cursor: item.cursor,
            authorId: item.authorId,
            createdAt: item.createdAt,
            type: item.type,
            ...(offset ? { bodyOffset: offset } : {}),
            ...(item.attachments.length ? { attachmentCount: item.attachments.length } : {}),
          };
          // Escaped control characters can occupy six JSON characters each.
          while (body && JSON.stringify([...items, { ...row, body }]).length > 11000)
            body = body.slice(0, Math.floor(body.length / 2));
          if (!body && item.body.length > offset) {
            hasMore = true;
            break;
          }
          items.push({
            ...row,
            body,
            ...(offset + body.length < item.body.length ? { bodyContinues: true } : {}),
          });
          if (offset + body.length < item.body.length) {
            nextOffset = offset + body.length;
            hasMore = true;
            break;
          }
          nextAfter = item.cursor;
          nextOffset = undefined;
        }
        if (!hasMore) {
          hasMore = page.items.length > items.length || page.more;
          if (page.items.length === items.length && nextOffset === undefined) nextAfter = page.boundary ?? nextAfter;
        }
        return JSON.stringify({
          cornerId: args.cornerId,
          items,
          ...(hasMore
            ? {
                next: {
                  ...(nextAfter ? { after: nextAfter } : {}),
                  ...(nextOffset ? { offset: nextOffset } : {}),
                },
              }
            : {}),
          limits: { items: itemLimit, bodyChars: 1000, responseChars: 12000 },
        });
      }
      const status = (await daemonExecute('getCornerRestoreState', {
        cornerId: args.cornerId,
      })) as unknown as CornerRestoreResult;
      const pr = status.lifecycle?.pr;
      // GitHub can be unavailable while the server-owned lifecycle remains readable.
      const verdict = pr
        ? await daemonExecute('getPrChecksStatus', {
            cornerId: args.cornerId,
            pullRequest: pr.number,
          }).catch(() => undefined)
        : undefined;
      return JSON.stringify({
        cornerId: args.cornerId,
        state: status.state ?? 'unknown',
        lifecycle: status.lifecycle?.lifecycle ?? 'unknown',
        activity: status.activity ?? 'unknown',
        ...(status.awaiting ? { awaiting: status.awaiting } : {}),
        ...(status.lastMessage ? { lastMessage: status.lastMessage } : {}),
        ...(pr ? { pr: { number: pr.number, url: pr.url, title: pr.title } } : {}),
        ...(verdict?.headSha || pr?.headSha ? { headSha: verdict?.headSha ?? pr?.headSha } : {}),
        checks: verdict?.checks ?? status.lifecycle?.checks ?? 'unknown',
        verdict: verdict
          ? {
              stage: verdict.stage,
              approved: verdict.approved,
              held: verdict.held,
              holds: verdict.holds,
              mergeAllowed: verdict.mergeAllowed,
              ...(verdict.blockedReason ? { blockedReason: verdict.blockedReason } : {}),
              reviewer: verdict.reviewer,
              reviewerExists: verdict.reviewerExists,
              reviewerWake: verdict.reviewerWake,
            }
          : { mergeAllowed: false, status: 'unavailable', held: status.held === true, holds: status.holds ?? [] },
        merge: {
          mergeability: pr?.mergeability ?? 'unknown',
          ...(pr?.mergedAt ? { mergedAt: pr.mergedAt } : {}),
        },
      });
    }
    case 'react_to_message':
      return reactToMessage(args);
    case 'close_corner':
      return closeCorner(args);
    case 'pr_checks_status':
      return prChecksStatus(args);
    case 'approve_merge':
      return approveMerge(args);
    case 'dispatch_release':
      return JSON.stringify(await daemonExecute('dispatchRoomWorkflow', {
        ...await activeCommandContext(),
        ...(args.inputs === undefined ? {} : { inputs: args.inputs }),
      }));
    case 'merge_corner':
      return JSON.stringify(
        await daemonExecute('mergeCorner', { cornerId: targetCornerId(args) }),
      );
    case 'close_pull_request':
      return JSON.stringify(
        await daemonExecute('closeCornerPullRequest', { cornerId: targetCornerId(args) }),
      );
    case 'list_rooms':
      return JSON.stringify(await daemonExecute('listRooms', { roomId: agentScheduleRoomId() }));
    case 'list_corners':
      return JSON.stringify(
        await daemonExecute('listReachableCorners', {
          roomId: typeof args.address === 'string' ? args.address : requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          ...(typeof args.activeOnly === 'boolean' ? { activeOnly: args.activeOnly } : {}),
        }),
      );
    case 'list_room_members':
      return JSON.stringify(
        await daemonExecute('listRoomMembers', {
          roomId:
            typeof args.address === 'string' ? args.address : typeof args.cornerId === 'string' && args.cornerId
              ? args.cornerId
              : process.env.BEELINE_DAEMON_CORNER_ID?.trim() ||
                requiredEnv('BEELINE_DAEMON_ROOM_ID'),
        }),
      );
    case 'read_pull_request':
      return JSON.stringify(
        await daemonExecute('readCornerPullRequest', { cornerId: targetCornerId(args) }),
      );
    case 'post': {
      const cornerId = typeof args.cornerId === 'string' && args.cornerId
        ? args.cornerId : process.env.BEELINE_DAEMON_CORNER_ID?.trim() || requiredEnv('BEELINE_DAEMON_ROOM_ID');
      if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 16000)
        throw new Error('text must contain 1 to 16000 characters');
      return JSON.stringify(
        await daemonExecute('postCornerMessage', { cornerId, text: args.text, ...(args.replyTo ? { replyTo: args.replyTo } : {}) }),
      );
    }
    case 'write_scratch_file':
      return writeScratchFile(args);
    case 'scratch_status': {
      const root = requiredEnv('BEELINE_CORNER_SCRATCH_ROOT');
      return scratchBudgetMessage(await allocatedDirectoryBytes(root));
    }
    case 'get_avatar':
      return JSON.stringify(
        await daemonExecute('getAgentAvatar', { roomId: agentScheduleRoomId() }),
      );
    case 'set_avatar':
      return JSON.stringify(
        await daemonExecute('postAgentAvatar', {
          roomId: agentScheduleRoomId(),
          drawing: args.drawing,
        }),
      );
    case 'fetch_image':
      return fetchImage(args);
    case 'post_artifact':
      return postArtifact(args);
    case 'post_vault_save_card':
      return JSON.stringify(await daemonExecute('postVaultSaveCard', { ...args, roomId: agentScheduleRoomId() } as never));
    case 'share_browser':
      return shareBrowser(args);
    case 'end_browser_share': {
      if (typeof args.sessionId !== 'string' || !args.sessionId.trim())
        throw new Error('A shared browser sessionId is required');
      await daemonExecute('endComputerSession', { roomId: agentScheduleRoomId(), sessionId: args.sessionId });
      return 'Browser share ended';
    }
    case 'rename_corner': {
      const cornerId = targetCornerId(args);
      const refusal = args.name === undefined && args.reviewer !== undefined ? null : cornerTextRefusal('name', args.name);
      if (refusal) throw new Error(refusal);
      const result = await daemonExecute('renameCorner', {
        cornerId,
        ...(args.name !== undefined ? { name: String(args.name) } : {}),
        ...(args.reviewer !== undefined ? { reviewer: args.reviewer as string } : {}),
        ...(args.objective !== undefined ? { objective: args.objective } : {}),
        ...(args.brief !== undefined ? { brief: await bindBriefFiles(asObject(args.brief)) } : {}),
      });
      return args.name === undefined ? 'updated the corner reviewer' : `renamed the corner to ${String(result.name)}`;
    }
    case 'create_subscription': {
      const source = stringArg(args, 'source');
      const event = stringArg(args, 'event');
      const prompt = stringArg(args, 'prompt');
      if (source !== 'room' && source !== 'repository' && source !== 'service' && source !== 'webhook')
        throw new Error('source must be room, repository, service, or webhook');
      if (!event) throw new Error('event is required');
      if (!prompt) throw new Error('prompt is required');
      const result = await daemonExecute('createAgentSubscription', {
        roomId: agentScheduleRoomId(), source, event, prompt,
        title: args.title, when: args.when,
        ...(typeof args.repository === 'string' ? { repository: args.repository } : {}),
        ...(typeof args.channelId === 'string' ? { channelId: args.channelId } : {}),
        ...(typeof args.channelName === 'string' ? { channelName: args.channelName } : {}),
        ...(typeof args.workflowName === 'string' ? { workflowName: args.workflowName } : {}),
      });
      return result.registrationStatus === 'registering'
        ? `Subscription ${String(result.id)} created for ${source} ${event}. The connected helper is registering its webhook; it runs your action once registration completes.`
        : `Subscription ${String(result.id)} created for ${source} ${event}. It runs your action when the event arrives.`;
    }
    case 'delete_subscription': {
      const subscriptionId = stringArg(args, 'subscriptionId');
      if (!subscriptionId) throw new Error('subscriptionId is required');
      await daemonExecute('deleteAgentSubscription', { roomId: agentScheduleRoomId(), subscriptionId });
      return `Subscription ${subscriptionId} stopped.`;
    }
    case 'watch': {
      const deps = agentScheduleDepsFromEnv();
      const result = await deps.execute('watchCorner', {
        roomId: deps.roomId,
        cornerId: args.address,
        kinds: ['opened', 'merged'],
      });
      const kinds = (result.kinds as string[]).join(', ');
      const headline =
        result.state === 'merged'
          ? `Corner already merged${result.woken ? '; one merged wake queued now' : '; no new wake (already delivered)'}`
          : result.state === 'closed'
            ? 'Corner closed without merging; nothing to watch'
            : kinds
              ? `Watching for ${kinds}`
              : 'Watch removed';
      return `${headline}\n${JSON.stringify(result.snapshot, null, 2)}`;
    }
    case 'request_grant':
      return requestGrant(args);
    case 'list_grants':
      return listGrants();
    case 'connectors_status':
      return workbenchStatus();
    case 'create_link_spend_request': {
      const context = await activeCommandContext();
      const merchant = stringArg(args, 'merchant')?.trim();
      const merchantUrl = stringArg(args, 'merchantUrl')?.trim();
      const description = stringArg(args, 'description')?.trim();
      const amount = args.amount;
      if (!merchant || (args.credentialType !== 'shared_payment_token' && !merchantUrl)
        || !description || typeof amount !== 'number'
        || !Number.isSafeInteger(amount) || amount <= 0)
        throw new Error('merchant, merchantUrl, positive amount in cents, and description are required');
      const idempotencyKey = createHash('sha256').update(
        `link:${context.requestId}:${context.generationId}:${toolCallId || randomUUID()}`).digest('hex');
      return JSON.stringify(await daemonExecute('createLinkSpendRequest', {
        ...context, agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
        merchant, ...(merchantUrl ? { merchantUrl } : {}), amount, description, idempotencyKey,
        ...(args.test === true ? { test: true } : {}),
        ...(args.credentialType === 'shared_payment_token'
          ? { credentialType: 'shared_payment_token', networkId: stringArg(args, 'networkId') }
          : {}),
      }));
    }
    case 'wait_link_spend_request': {
      const id = stringArg(args, 'id')?.trim();
      if (!id || !/^lsrq_[A-Za-z0-9]+$/.test(id)) throw new Error('valid Link request ID required');
      const context = await activeCommandContext();
      // Provider without correlated push support stays pending until an
      // explicit later tool action. A tool named wait cannot hide status polls.
      return JSON.stringify(await daemonExecute('retrieveLinkSpendRequest',{
        ...context,agentId:requiredEnv('BEELINE_DAEMON_AGENT_ID'),id}));
    }
    case 'connect': {
      const service = stringArg(args, 'service')?.trim();
      const reason = stringArg(args, 'reason')?.trim();
      if (!service || !reason) throw new Error('service and reason are required');
      const continuation = normalizeAppContinuation(args.continuation);
      const signedInUrl = stringArg(args, 'signedInUrl')?.trim();
      const { squireReach: reach, squireCall } = connectorOfferDepsFromEnv();
      // Refresh vault metadata before the server decides whether this app is ready.
      const squireAvailable = reach ? (await reach())?.reachable === true : false;
      const input = {
        ...await activeCommandContext(), service, reason,
        squireAvailable,
        ...(continuation ? { continuation } : {}),
        ...(args.reconnect === true ? { reconnect: true } : {}),
        ...(args.noApi === true ? { noApi: true } : {}),
        ...(args.switchGoogleAccount === true ? { switchGoogleAccount: true } : {}),
        ...(signedInUrl ? { signedInUrl } : {}),
      };
      const result = await daemonExecute('connect', input) as unknown as ConnectResult;
      // A browser app signed in through OAuth or SSO has no login to save:
      // the agent's own signed-in Squire session is what makes it ready.
      if (result.status === 'needs_squire' && result.transport === 'squire-browser' && result.appKey &&
          signedInUrl && squireCall && await squireSessionSignedIn(squireCall, signedInUrl, result.appKey))
        return JSON.stringify(await daemonExecute('connect', { ...input, squireSignedIn: true }));
      return JSON.stringify(result);
    }
    case 'find_connectors': {
      const query = stringArg(args, 'query')?.trim();
      if (!query) throw new Error('query is required');
      return JSON.stringify(await daemonExecute('findConnectors', { roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'), query }));
    }
    case 'list_app_tools': {
      const appId = stringArg(args, 'appId');
      if (!appId) throw new Error('appId is required');
      return JSON.stringify(await daemonExecute('listAppTools', {
        ...await activeCommandContext(),
        agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
        appId,
        ...(typeof args.query === 'string' ? { query: args.query } : {}),
      }));
    }
    case 'execute_app_tool': {
      const appId = stringArg(args, 'appId');
      const tool = stringArg(args, 'tool');
      if (!appId || !tool || !args.arguments || typeof args.arguments !== 'object' ||
        Array.isArray(args.arguments)) throw new Error('appId, tool, and arguments are required');
      return JSON.stringify(await daemonExecute('executeAppTool', {
        ...await activeCommandContext(),
        agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
        appId, tool, arguments: args.arguments,
      }));
    }
    case 'post_starter_video_preview':
      return JSON.stringify(await daemonExecute('postStarterVideoPreview', { ...await activeCommandContext(), videoObjectId: args.videoObjectId, frameObjectId: args.frameObjectId, title: args.title, description: args.description, visibility: args.visibility }));
    case 'post_starter_welcome':
      return JSON.stringify(await daemonExecute('postStarterWelcome', { ...await activeCommandContext() }));
    case 'post_room_invite':
      return JSON.stringify(await daemonExecute('postRoomInvite', { ...await activeCommandContext() }));
    case 'post_repository_card':
    case 'post_starters_card':
      return JSON.stringify(await daemonExecute('postRepositoryOnboarding', {
        ...await activeCommandContext(), kind: name === 'post_repository_card' ? 'repository' : 'starters',
      }));
    case 'run_granted_command':
      return runGrantedCommand(args);
    default:
      throw new Error(`tool is not available on the agent surface: ${name}`);
  }
}
