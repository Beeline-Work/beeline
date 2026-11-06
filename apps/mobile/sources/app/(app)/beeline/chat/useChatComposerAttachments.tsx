import { focusComposerSelection } from '@/buzz/composer-selection';
import React, { useCallback } from 'react';
import { TextInput, Platform } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { Modal } from '@/modal';
import { scheduleAnimationFrame } from '@/buzz/host-scheduler';
import { replaceActiveChannel, type ChannelSuggestion } from '@/buzz/channel-suggestions';
import { activeMentionAtCursor, recordMentionPick, replaceActiveMention } from '@/buzz/room-participants';
import { MAX_MESSAGE_ATTACHMENTS, pastedImageAttachment, pickedPhotoAttachments, type PickedChatAttachment } from '@/buzz/chat-attachment';
import { RoomMemberOption } from './chat-surface-values';

type Props = [
  pendingAttachments: PickedChatAttachment[],
  replacePendingAttachments: (update: PickedChatAttachment[] | ((current: PickedChatAttachment[]) => PickedChatAttachment[])) => void,
  setAttachmentPickerVisible: React.Dispatch<React.SetStateAction<boolean>>,
  activeMention: import("@/buzz/room-participants").ActiveMention | null,
  inputTextRef: React.RefObject<string>,
  selectedAgentMentionsRef: React.RefObject<Map<string, string>>,
  selectedMentionsRef: React.RefObject<Map<string, string>>,
  setInputText: (update: string | ((previous: string) => string)) => void,
  setInputSelection: React.Dispatch<React.SetStateAction<{ start: number; end: number; }>>,
  setDismissedMentionKey: React.Dispatch<React.SetStateAction<string | null>>,
  setHighlightedMentionIndex: React.Dispatch<React.SetStateAction<number>>,
  composerRef: React.RefObject<TextInput | null>,
  activeChannel: import("@/buzz/channel-suggestions").ActiveChannel | null,
];

export function useChatComposerAttachments([
  pendingAttachments, replacePendingAttachments, setAttachmentPickerVisible, activeMention,
  inputTextRef, selectedAgentMentionsRef, selectedMentionsRef, setInputText, setInputSelection,
  setDismissedMentionKey, setHighlightedMentionIndex, composerRef, activeChannel,
]: Props): [
  selectMention: (participant: RoomMemberOption) => void,
  selectChannel: (suggestion: ChannelSuggestion) => void,
  chooseAttachment: () => void,
  pickDocument: () => Promise<void>,
  pickPhoto: () => Promise<void>,
  pasteImage: () => Promise<void>,
] {


  const pickPhoto = useCallback(async () => {
    const remaining = MAX_MESSAGE_ATTACHMENTS - pendingAttachments.length;
    if (remaining <= 0) {
      Modal.alert(
        'Attachment limit reached',
        `A message can include up to ${MAX_MESSAGE_ATTACHMENTS} attachments.`,
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: remaining,
      quality: 1,
      exif: false,
    });
    if (result.canceled || result.assets.length === 0) return;
    replacePendingAttachments((current) => [
      ...current,
      ...pickedPhotoAttachments(result.assets).slice(0, MAX_MESSAGE_ATTACHMENTS - current.length),
    ]);
  }, [pendingAttachments.length, replacePendingAttachments]);


  const pickDocument = useCallback(async () => {
    if (pendingAttachments.length >= MAX_MESSAGE_ATTACHMENTS) {
      Modal.alert(
        'Attachment limit reached',
        `A message can include up to ${MAX_MESSAGE_ATTACHMENTS} attachments.`,
      );
      return;
    }
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: false,
      type: '*/*',
    });
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset) return;
    replacePendingAttachments((current) => [
      ...current,
      {
        uri: asset.uri,
        name: asset.name?.trim() || `file-${Date.now()}`,
        mimeType: asset.mimeType ?? 'application/octet-stream',
        size: asset.size ?? 0,
        source: 'file',
      },
    ]);
  }, [pendingAttachments.length, replacePendingAttachments]);


  const pasteImage = useCallback(async () => {
    if (pendingAttachments.length >= MAX_MESSAGE_ATTACHMENTS) {
      Modal.alert(
        'Attachment limit reached',
        `A message can include up to ${MAX_MESSAGE_ATTACHMENTS} attachments.`,
      );
      return;
    }
    if (!(await Clipboard.hasImageAsync())) {
      Modal.alert('Nothing to paste', 'Copy an image first, then try again.');
      return;
    }
    const image = await Clipboard.getImageAsync({ format: 'png' });
    if (!image) return;
    const attachment = await pastedImageAttachment(image);
    replacePendingAttachments((current) => [...current, attachment]);
  }, [pendingAttachments.length, replacePendingAttachments]);


  const chooseAttachment = useCallback(() => {
    setAttachmentPickerVisible(true);
  }, []);


  const selectMention = useCallback(
    (participant: RoomMemberOption) => {
      if (!activeMention) return;
      const inserted = replaceActiveMention(
        inputTextRef.current,
        activeMention,
        participant.handle,
      );
      if (participant.kind === 'agent') {
        selectedAgentMentionsRef.current.set(participant.handle, participant.pubkey);
      }
      // `@channel` (a broadcast) and `@system` (a report) are tokens, never
      // resolvable identities — neither may earn a picker→pubkey binding.
      recordMentionPick(selectedMentionsRef.current, participant);
      const nextSelection = { start: inserted.cursor, end: inserted.cursor };
      const completedMention = activeMentionAtCursor(inserted.text, inserted.cursor);
      inputTextRef.current = inserted.text;
      setInputText(inserted.text);
      setInputSelection((current) =>
        current.start === nextSelection.start && current.end === nextSelection.end
          ? current
          : nextSelection,
      );
      setDismissedMentionKey(
        completedMention
          ? `${inserted.text}:${completedMention.start}:${completedMention.end}`
          : null,
      );
      setHighlightedMentionIndex(0);
      scheduleAnimationFrame(() => {
        focusComposerSelection(
          composerRef.current,
          nextSelection,
          Platform.OS,
        );
      });
      void Haptics.selectionAsync();
    },
    [activeMention],
  );


  const selectChannel = useCallback(
    (suggestion: ChannelSuggestion) => {
      if (!activeChannel) return;
      const inserted = replaceActiveChannel(inputTextRef.current, activeChannel, suggestion.token);
      const nextSelection = { start: inserted.cursor, end: inserted.cursor };
      inputTextRef.current = inserted.text;
      setInputText(inserted.text);
      setInputSelection(nextSelection);
      setHighlightedMentionIndex(0);
      scheduleAnimationFrame(() => {
        focusComposerSelection(
          composerRef.current,
          nextSelection,
          Platform.OS,
        );
      });
      void Haptics.selectionAsync();
    },
    [activeChannel],
  );
  return [
    selectMention, selectChannel, chooseAttachment, pickDocument, pickPhoto, pasteImage,
  ];
}
