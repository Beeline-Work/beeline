self.addEventListener('push', (event) => {
  let payload;
  try { payload = event.data?.json(); } catch { return; }
  if (!payload || typeof payload.body !== 'string') return;
  const path = typeof payload.url === 'string' && payload.url.startsWith('/beeline/') &&
    !payload.url.startsWith('//') ? payload.url : '/beeline/channels';
  event.waitUntil(self.registration.showNotification('Beeline', {
    body: payload.body.slice(0, 200),
    icon: '/favicon-active.ico',
    data: { path },
    tag: typeof payload.messageId === 'string' ? payload.messageId : undefined,
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = event.notification.data?.path || '/beeline/channels';
  event.waitUntil((async () => {
    const url = new URL(path, self.location.origin);
    if (url.origin !== self.location.origin) return;
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = clients.find((client) => new URL(client.url).origin === url.origin);
    if (existing) {
      await existing.navigate(url.href);
      return existing.focus();
    }
    return self.clients.openWindow(url.href);
  })());
});
