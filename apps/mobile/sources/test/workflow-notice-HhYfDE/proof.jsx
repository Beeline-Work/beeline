import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { LedgerEntry, LedgerSystemLine } from '@/components/buzz/Ledger';
      import { displayRoomMessage } from '@/buzz/room-view-presentation';
      import { useUnistyles } from 'react-native-unistyles';
      import regularFont from '@/assets/fonts/SpaceGrotesk-Regular.ttf';
      import mediumFont from '@/assets/fonts/SpaceGrotesk-Medium.ttf';
      import semiboldFont from '@/assets/fonts/SpaceGrotesk-SemiBold.ttf';
      import monoFont from '@/assets/fonts/IBMPlexMono-Regular.ttf';
      const fontStyle = document.createElement('style');
      fontStyle.textContent = [[ 'SpaceGrotesk-Regular', regularFont ], [ 'SpaceGrotesk-Medium', mediumFont ],
        [ 'SpaceGrotesk-SemiBold', semiboldFont ], [ 'IBMPlexMono-Regular', monoFont ]]
        .map(([name, url]) => '@font-face{font-family:' + name + ';src:url(' + url + ')}').join('') + '#result{display:none}';
      document.head.appendChild(fontStyle);
      const event = { subject: { kind: 'agent', id: 'impy', name: 'Impy' },
        verb: 'started workflow', object: { text: 'corner' }, consequence: 'run 7a434a73' };
      const text = 'Impy started workflow corner · run 7a434a73';
      function Proof() {
        const { theme } = useUnistyles();
        document.body.style.background = theme.buzz.bgBase;
        return <div style={{padding: 16}}>{['card', 'system'].map(presentation => {
          const message = displayRoomMessage({ id: presentation, text, createdAt: 1,
            author: { pubkey: 'impy', name: 'Impy', kind: 'agent' },
            presentation, systemEvent: event }, 'viewer');
          return <section key={presentation} style={{marginBottom: 32}}>
            <p style={{color: theme.buzz.textSecondary, fontFamily: 'SpaceGrotesk-Regular'}}>{presentation === 'card' ? 'Before' : 'After'}</p>
            {message.isSystemNotice
              ? <LedgerSystemLine id={message.id} text={message.text} event={message.systemEvent} stamp="09:41"/>
              : <LedgerEntry bodyText={message.text} bodyTestID="before-body" itemId={message.id}
                  byline={{name: 'Impy', role: 'agent', stamp: '09:41'}}/>}
          </section>;
        })}</div>;
      }
      createRoot(document.getElementById('root')).render(<Proof/>);
      setTimeout(() => {
        const line = document.querySelector('[data-testid="system-line-system"]');
        const copy = document.querySelector('[data-testid="system-line-text-system"]');
        const before = document.querySelector('[data-testid="before-body"]');
        document.getElementById('result').textContent = JSON.stringify({ text: copy?.textContent,
          beforeText: before?.textContent, systemLines: document.querySelectorAll('[data-testid="system-line-system"]').length,
          fontSize: copy && getComputedStyle(copy).fontSize,
          overflow: document.documentElement.scrollWidth > innerWidth,
          lineHeight: line?.getBoundingClientRect().height });
      }, 1500);