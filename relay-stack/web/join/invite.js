(() => {
  const match = window.location.pathname.match(/^\/join\/(bzi_[0-9a-f]{64})\/?$/);
  const code = document.querySelector('#invite-code');
  const open = document.querySelector('#open-app');
  const copy = document.querySelector('#copy-invite');
  const status = document.querySelector('#status');

  if (!match || !code || !open || !copy || !status) {
    if (status) status.textContent = 'This invite link is malformed.';
    return;
  }

  const token = match[1];
  code.textContent = token;
  open.href = `buzzy://join/${encodeURIComponent(token)}`;
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(token);
      status.textContent = 'Invite code copied.';
    } catch {
      status.textContent = 'Select the invite code above to copy it.';
    }
  });
})();
