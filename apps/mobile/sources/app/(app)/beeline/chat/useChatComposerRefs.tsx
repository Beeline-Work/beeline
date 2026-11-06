import React, { useRef } from 'react';
import { TextInput } from 'react-native';
import { createRoomMessageProjector } from '@/buzz/room-view-presentation';

type Props = [

];

export function useChatComposerRefs([

]: Props): [
  inputTextRef: React.RefObject<string>,
  composerRef: React.RefObject<TextInput | null>,
  roomMessageProjector: import("@/buzz/room-view-presentation").RoomMessageProjector,
  selectedAgentMentionsRef: React.RefObject<Map<string, string>>,
  selectedMentionsRef: React.RefObject<Map<string, string>>,
  sendInFlightRef: React.RefObject<boolean>,
  composerInputRevisionRef: React.RefObject<number>,
] {

  const composerRef = useRef<TextInput>(null);

  // React state can lag the final Android native text event when the user
  // immediately taps send. Keep the authoritative in-flight draft beside the
  // native TextInput so an @mention never drops trailing text.
  const inputTextRef = useRef('');

  // A successful send replaces the native input. Advance this ref before any
  // asynchronous React update so an event already queued by the consumed
  // native field cannot put its text back into the next draft.
  const composerInputRevisionRef = useRef(0);

  // The picker knows the exact agent key, whereas text-only lookup is a
  // fallback for manually typed mentions. Keep that identity through trailing
  // typing so an async roster refresh cannot turn a selected agent into an
  // unaddressed plain Room message.
  const selectedAgentMentionsRef = useRef(new Map<string, string>());

  const selectedMentionsRef = useRef(new Map<string, string>());

  // When each agent was last told about, so a standing offline condition is
  const sendInFlightRef = useRef(false);

  const roomMessageProjectorRef = useRef<ReturnType<typeof createRoomMessageProjector> | null>(
    null,
  );

  const roomMessageProjector =
    roomMessageProjectorRef.current ??
    (roomMessageProjectorRef.current = createRoomMessageProjector());
  return [
    inputTextRef, composerRef, roomMessageProjector, selectedAgentMentionsRef, selectedMentionsRef,
    sendInFlightRef, composerInputRevisionRef,
  ];
}
