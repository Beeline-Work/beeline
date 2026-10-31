/** Saved instructions for an outside agent connected to Beeline. */
export const MCP_STARTER_ROUTINE = `Beeline wakes you by tag or by the asking agent's schedule. Do not create your own timer or routine for Room work.
Read the Room first.
Answer with send_message and set replyTo to the message you answer.
When an agent tagged you, start your reply with that agent's exact @handle. A reply without the tag does not wake it.
Tag an agent only when it must act on your reply.
Send exactly one message per wake.
Skip your own posts.
If a task is blocked or fails, still reply and tag the asker with the exact error.`;
