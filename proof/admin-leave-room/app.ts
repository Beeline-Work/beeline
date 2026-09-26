import { leaveRoomWithConfirmation } from '../../apps/mobile/sources/buzz/room-leave';

type State = {
  chats: { room: { id: string; name: string }; leaveDeletesRoom?: boolean }[];
  remainingIds: string[];
  ordinaryId: string;
  lastId: string;
};
const deck = document.getElementById('deck')!;
const result = document.getElementById('result')!;
async function readState(): Promise<State> {
  return (await fetch('/api/state')).json();
}
async function render() {
  const state = await readState();
  deck.innerHTML = '';
  for (const [id, name] of [
    [state.ordinaryId, 'CloverGTO'],
    [state.lastId, 'Final admin'],
  ] as const) {
    const chat = state.chats.find((item) => item.room.id === id);
    const exists = state.remainingIds.includes(id);
    const card = document.createElement('section');
    card.className = 'card';
    const heading = document.createElement('h2');
    heading.textContent = `#${name}`;
    card.append(heading);
    const detail = document.createElement('p');
    detail.textContent = chat
      ? chat.leaveDeletesRoom
        ? 'You are the last admin in this Room.'
        : 'Another admin can still manage this Room.'
      : exists
        ? 'You left. The Room remains open for everyone else.'
        : 'Room deleted for everyone.';
    card.append(detail);
    if (chat) {
      const button = document.createElement('button');
      button.textContent = 'Leave Room';
      button.onclick = async () => {
        try {
          const left = await leaveRoomWithConfirmation(
            `#${name}`,
            chat.leaveDeletesRoom === true,
            async (confirmDelete) => {
              const response = await fetch('/api/leave', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ roomId: id, confirmDelete }),
              });
              if (!response.ok) throw new Error((await response.json()).error);
            },
          );
          if (left) {
            result.textContent = chat.leaveDeletesRoom
              ? `PASS: Last admin left #${name}; Room deleted from the local server.`
              : `PASS: Admin left #${name}; Room remains for other members.`;
            await render();
          }
        } catch (error) {
          result.textContent = String(error);
        }
      };
      card.append(button);
    }
    deck.append(card);
  }
}
void render();
