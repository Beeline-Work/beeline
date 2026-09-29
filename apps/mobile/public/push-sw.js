function focusedClientHasTarget(client, channelId, roomId) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const finish = (matches) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(matches);
    };
    const timer = setTimeout(() => finish(false), 120);
    channel.port1.onmessage = (event) => {
      const openId = event.data?.channelId;
      finish(typeof openId === 'string' && (openId === channelId || openId === roomId));
    };
    try {
      client.postMessage({ type: 'beeline-web-push-open-room' }, [channel.port2]);
    } catch {
      finish(false);
    }
  });
}

async function targetAlreadyOpen(payload) {
  const channelId = typeof payload.channelId === 'string' ? payload.channelId : null;
  const roomId = typeof payload.roomId === 'string' ? payload.roomId : null;
  if (!channelId && !roomId) return false;
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const focused = clients.filter((client) =>
    client.focused && client.visibilityState === 'visible' &&
    new URL(client.url).origin === self.location.origin);
  return (await Promise.all(focused.map((client) =>
    focusedClientHasTarget(client, channelId, roomId)))).some(Boolean);
}

self.addEventListener('push', (event) => {
  let payload;
  try { payload = event.data?.json(); } catch { return; }
  if (!payload || typeof payload.body !== 'string') return;
  const path = typeof payload.url === 'string' && payload.url.startsWith('/beeline/') &&
    !payload.url.startsWith('//') ? payload.url : '/beeline/channels';
  event.waitUntil((async () => {
    // A missing or slow tab reply never delays display beyond this deadline.
    const alreadyOpen = await Promise.race([
      targetAlreadyOpen(payload).catch(() => false),
      new Promise((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    if (alreadyOpen) return;
    await self.registration.showNotification('Beeline', {
      body: payload.body.slice(0, 200),
      icon: '/favicon-active.ico',
      data: { path },
      tag: typeof payload.messageId === 'string' ? payload.messageId : undefined,
    });
  })());
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
