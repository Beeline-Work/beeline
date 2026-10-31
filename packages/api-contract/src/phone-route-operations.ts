import type {
  AgentDetailView, ChatListView, CornerListView, RoomHistoryOutline, RoomHistoryView,
  RoomView, WorkspaceListView, WorkspaceMemberListQuery, WorkspaceMemberListView, WorkspaceView, MessageSearchView,
} from './phone-types.js';
import type { AgentVoiceCatalog, AgentVoicePreview, VoiceCall, VoiceIdleState, VoiceJoin } from './voice.js';

/** Former REST-only operations. HTTP wrappers and socket requests use one dispatcher. */
export type PhoneRouteOperationMap = {
  readWorkspaces: { input: Record<string, never>; output: WorkspaceListView };
  readWorkspace: { input: { workspaceId: string }; output: WorkspaceView };
  readWorkspaceMembers: { input: { workspaceId: string } & WorkspaceMemberListQuery; output: WorkspaceMemberListView };
  readChats: { input: { workspaceId: string }; output: ChatListView };
  readAgent: { input: { workspaceId: string; agentId: string; workCursor?: string }; output: AgentDetailView };
  resolveMessageLink: { input: { messageId: string }; output: { roomId: string; messageId: string; workspaceId: string } };
  searchMessages: { input: { workspaceId: string; query: string; before?: string }; output: MessageSearchView };
  readRoom: { input: { roomId: string }; output: RoomView };
  readHistory: { input: { roomId: string; before?: { createdAt: number; id: string } }; output: RoomHistoryView };
  readHistoryAfter: { input: { roomId: string; messageId: string }; output: RoomHistoryView };
  readHistoryAround: { input: { roomId: string; messageId: string }; output: RoomHistoryView };
  readHistoryOutline: { input: { roomId: string; timeZone: string }; output: RoomHistoryOutline };
  readCorners: { input: { roomId: string; archived?: boolean; before?: string; openBefore?: string }; output: CornerListView };
  markRead: { input: { roomId: string; messageId: string }; output: void };
  markUnread: { input: { roomId: string; messageId: string }; output: void };
  voiceCurrent: { input: { roomId: string }; output: VoiceCall | null };
  voiceJoin: { input: { roomId: string; expectedCallId?: string }; output: VoiceJoin };
  voiceLeave: { input: { callId: string; sessionId?: string }; output: { left: true } };
  voiceIdle: { input: { callId: string; sessionId?: string }; output: VoiceIdleState };
  voiceState: { input: { callId: string; sessionId?: string }; output: VoiceIdleState };
  voiceResume: { input: { callId: string; sessionId: string }; output: { resumed: true } };
  readAgentVoices: { input: { workspaceId: string; agentId: string; roomId?: string }; output: AgentVoiceCatalog };
  saveAgentVoice: { input: { workspaceId: string; agentId: string; voiceId: string }; output: AgentVoiceCatalog };
  previewAgentVoice: { input: { workspaceId: string; agentId: string; voiceId: string }; output: AgentVoicePreview };
  reportPageLoad: { input: { durationMs: number; failed: boolean; network?: {
    requestToFirstByteMs: number; serverProcessingMs: number; jsResponseDelayMs?: number;
  } }; output: void };
  reportClientError: { input: {
    scope: 'app' | 'conversation' | 'voice-join' | 'voice-cleanup' | 'native-crash';
    message: string; stack: string; platform: string; platformVersion: string;
    releaseSha: string; runtimeVersion: string; updateId: string;
    device?: string; appVersion?: string; crashTimestamp?: string;
  }; output: void };
};

export const PHONE_ROUTE_READ_OPERATIONS = [
  'readWorkspaces', 'readWorkspace', 'readWorkspaceMembers', 'readChats', 'readAgent',
  'resolveMessageLink', 'searchMessages', 'readRoom', 'readHistory', 'readHistoryAfter',
  'readHistoryAround', 'readHistoryOutline', 'readCorners', 'voiceCurrent', 'voiceState',
  'readAgentVoices',
] as const satisfies readonly (keyof PhoneRouteOperationMap)[];

export const PHONE_ROUTE_OPERATION_NAMES = [
  ...PHONE_ROUTE_READ_OPERATIONS, 'markRead', 'markUnread', 'voiceJoin', 'voiceLeave',
  'voiceIdle', 'voiceResume', 'saveAgentVoice', 'previewAgentVoice',
  'reportPageLoad', 'reportClientError',
] as const satisfies readonly (keyof PhoneRouteOperationMap)[];
