import React from 'react';
// @ts-expect-error Standalone proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { IdentityMark } from '../sources/components/buzz/IdentityMark';
import { ConversationRow } from '../sources/components/buzz/ConversationRow';
import { ToolDetailsCell } from '../sources/components/buzz/ToolDetailsCell';
import type { ChatListItem } from '@beeline/buzz-client';

const bots = [
  ['trusty-squire', 'Trusty Squire', 'Browser and vault receipts'],
  ['wallet', 'Wallet', 'Payments and balance receipts'],
  ['system', 'System', 'Release and Workspace notices'],
  ['tailscale', 'Tailscale', 'Tailnet connection receipts'],
  ['google-gmail', 'Gmail', 'Mail tool receipts'],
  ['google-calendar', 'Google Calendar', 'Calendar tool receipts'],
  ['google-drive', 'Google Drive', 'Drive tool receipts'],
  ['google-youtube', 'YouTube', 'YouTube tool receipts'],
] as const;
const logo = (id: string) => `${location.origin}/v1/connectors/logo/${id}.svg`;
const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
document.documentElement.dataset.theme = theme;
const style = document.createElement('style');
style.textContent = `*{box-sizing:border-box}body{margin:0;background:${theme === 'dark' ? '#14091a' : '#f3eee4'};color:${theme === 'dark' ? '#f0f0f3' : '#211c1b'};font-family:Arial,sans-serif}.screen{max-width:430px;margin:auto;padding:24px 20px 48px}.title{font-size:19px;font-weight:700;margin:0 0 20px}.section{font:11px monospace;letter-spacing:.12em;text-transform:uppercase;color:${theme === 'dark' ? '#90909b' : '#6f6455'};margin:24px 0 10px}.header,.card-head{display:flex;align-items:center;gap:10px}.header{padding:12px 0;border-bottom:1px solid #7775}.header strong,.card-head strong{font-size:16px}.sub{font-size:12px;color:${theme === 'dark' ? '#90909b' : '#6f6455'};margin-top:3px}.card{border:1px solid #7776;border-radius:10px;padding:12px;margin:10px 0}.card p{font-size:13px;margin:10px 0 0}.list{display:grid;gap:2px}.proof-note{font-size:11px;line-height:1.5;color:${theme === 'dark' ? '#90909b' : '#6f6455'};margin:22px 0 0}`;
document.head.appendChild(style);
function BotMark({ id, name, size = 28 }: { id: string; name: string; size?: number }) {
  return <IdentityMark kind="human" seed={id} name={name} avatarUrl={logo(id)} size={size} />;
}
function item(id: string, name: string, description: string): ChatListItem {
  return {
    room: { id, name: 'Direct message', workspaceId: 'proof', updatedAt: Date.now() },
    directMessage: { peer: { pubkey: id, kind: 'human', name, handle: id, avatar: logo(id) } },
    latestMessage: {
      id: `${id}-last`,
      text: description,
      content: description,
      createdAt: Date.now(),
      author: { pubkey: id, kind: 'human', name, handle: id },
    },
    unread: false,
  } as ChatListItem;
}
createRoot(document.getElementById('root')!).render(
  <div className="screen">
    <h1 className="title">System bot identities</h1>
    <div className="section">Direct message header</div>
    <div className="header">
      <BotMark id="trusty-squire" name="Trusty Squire" size={26} />
      <div>
        <strong>Trusty Squire</strong>
        <div className="sub">Read-only receipts</div>
      </div>
    </div>
    <div className="section">Messages list</div>
    <div className="list">
      {bots.map(([id, name, description]) => (
        <ConversationRow
          key={id}
          item={item(id, name, description)}
          now={Date.now()}
          onPress={() => {}}
          onPin={() => {}}
          testID={`proof-${id}`}
        />
      ))}
    </div>
    <div className="section">Workbench tool rows</div>
    {bots
      .filter(([id]) => id !== 'system')
      .map(([id, name, description]) => (
        <ToolDetailsCell
          key={id}
          testID={`tool-${id}`}
          title={name}
          detailText={description}
          logoUrl={logo(id)}
          value="connected"
        />
      ))}
    <div className="section">Receipt and notice cards</div>
    {bots.slice(0, 3).map(([id, name, description]) => (
      <div className="card" key={id}>
        <div className="card-head">
          <BotMark id={id} name={name} size={26} />
          <strong>{name}</strong>
        </div>
        <p>{description}</p>
      </div>
    ))}
    <p className="proof-note">
      Fixture data; production IdentityMark, ConversationRow, and ToolDetailsCell components.
    </p>
  </div>,
);
