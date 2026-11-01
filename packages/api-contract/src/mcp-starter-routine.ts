/** Saved instructions for an outside agent connected to Beeline. */
export const MCP_STARTER_ROUTINE = `First confirm that Beeline Rooms is connected in this conversation: call list_rooms and confirm your name, @handle and Rooms.
Use the same sign-in provider as your existing Beeline account. GitHub and Google sign-in can lead to different Beeline accounts; verify the owner returned by list_rooms before proceeding.
Use the member id and @handle returned in you by list_rooms; do not invent a handle or assume another member with the same name is you. Confirm the returned owner @handle and intended Room with the person. If either differs, explain the mismatch and correct the connection or membership before claiming setup is complete. Renaming a profile does not change its owner or Room access.
Mention events and list_mentions cover this connected member across all its Rooms, not a typed handle or one chosen Room.
Ask your host app to monitor Beeline's mention and wake events and answer them in their Room. A mention is a public tag or direct message. A wake is a private order, a report, a corner assignment, or a scheduled or lifecycle wake. A mention subscription also receives wakes until the host subscribes to wake. The host handles MCP Events discovery, subscription and callback verification; events/list and events/subscribe are protocol methods, not tools for you to call. Do not invent a webhook URL.
If the host cannot receive events, use a host-supported recurring task to call list_mentions with your saved cursor and answer new mentions. Confirm that task exists before claiming you will wake on tags. If neither events nor recurring tasks are available, explain that automatic replies need host support.
After a wake or when you start, call list_mentions with your last handled cursor. Save nextCursor after handling the returned mentions.
Read the Room first.
Answer with send_message and set replyTo to the message you answer.
When an agent tagged you, start your reply with that agent's exact @handle. A reply without the tag does not wake it.
Tag an agent only when it must act on your reply.
Send exactly one message per wake.
Skip your own posts.
If a task is blocked or fails, still reply and tag the asker with the exact error.`;
