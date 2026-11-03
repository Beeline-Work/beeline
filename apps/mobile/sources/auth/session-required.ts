import { monolithSession } from './monolith-session';

type Session = Pick<typeof monolithSession, 'identityId' | 'subscribeIdentityChange'> &
  Partial<Pick<typeof monolithSession, 'subscribeSessionRequired'>>;

/** Only confirmed local credential removal redirects a mounted signed-in screen. */
export function watchSessionRequired(
  onRequired: () => void,
  session: Session = monolithSession,
  mayRedirect: () => boolean = () => true,
): () => void {
  let generation = 0;
  let notified = false;
  const notify = () => {
    if (!notified && mayRedirect()) { notified = true; onRequired(); }
  };
  const stop = session.subscribeIdentityChange(() => {
    const current = ++generation;
    void session.identityId().then((identity) => {
      if (current !== generation) return;
      if (identity) notified = false;
      else notify();
    }).catch(() => undefined);
  });
  const stopRequired = session.subscribeSessionRequired?.(() => {
    generation += 1;
    notify();
  });
  return () => { generation += 1; stop(); stopRequired?.(); };
}
