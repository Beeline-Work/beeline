import { monolithSession } from './monolith-session';

type Session = Pick<typeof monolithSession, 'identityId' | 'subscribeIdentityChange'>;

/** Only confirmed local credential removal redirects a mounted signed-in screen. */
export function watchSessionRequired(onRequired: () => void, session: Session = monolithSession): () => void {
  let generation = 0;
  const stop = session.subscribeIdentityChange(() => {
    const current = ++generation;
    void session.identityId().then((identity) => {
      if (current === generation && !identity) onRequired();
    }).catch(() => undefined);
  });
  return () => { generation += 1; stop(); };
}
