// Two small things the page works without: a copy button on the install
// commands, and how many Atmosphere accounts like bundle.

// Copy buttons, only where the browser lets a page write to the clipboard.
if (navigator.clipboard && window.isSecureContext) {
  for (const pre of document.querySelectorAll('pre.copyable')) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy';
    button.textContent = 'Copy';
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pre.querySelector('code').textContent.trim() + '\n');
        button.textContent = 'Copied';
      } catch {
        button.textContent = 'Copy failed';
      }
      setTimeout(() => { button.textContent = 'Copy'; }, 2000);
    });
    pre.prepend(button);
  }
}

// A like is a record in the liker's own account whose `subject` is bundle's
// listing. Constellation, the open backlink index, counts the distinct accounts
// that link to it. Shown only when it answers with a number above zero.
const LISTING = 'at://did:plc:rwypz6edxmzyhob2k3rsl2fw/com.pipobscure.bundle.listing/bundle';
const likes = document.getElementById('likes');
if (likes && window.fetch && window.AbortSignal && AbortSignal.timeout) {
  const url = 'https://constellation.microcosm.blue/links/count/distinct-dids'
    + '?target=' + encodeURIComponent(LISTING)
    + '&collection=com.pipobscure.bundle.like&path=.subject';
  fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) })
    .then((response) => (response.ok ? response.json() : null))
    .then((body) => {
      const total = body && Number.isSafeInteger(body.total) ? body.total : 0;
      if (total <= 0) return;
      likes.textContent = total === 1
        ? '1 account on the Atmosphere likes bundle.'
        : total.toLocaleString('en') + ' accounts on the Atmosphere like bundle.';
      likes.hidden = false;
    })
    .catch(() => {});
}
