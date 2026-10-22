// Three things the page works without: a copy button on the install commands,
// how many Atmosphere accounts like bundle, and the apps published on the
// Atmosphere, to browse and install.

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

// The apps published on the Atmosphere, found as `bundle search` finds them
// (src/listing.ts): every app's listing has the same `subject`, so the backlink
// index says who lists apps, and each publisher's own PDS says what they list.
// Each handle is checked both ways, through DNS over HTTPS or the handle's
// well-known file, and an app whose handle does not check out is shown, and
// linked, by DID. Nothing here is verified, and nothing needs to be: a listing
// vouches for nothing, and an `nzip:` link goes through the same review as
// `bundle install`.
//
// What was found is kept in localStorage and shown at once on the next visit.
// The network is asked again only once that is FRESH old, a DID document and
// handle once a day, as the command line does; a publisher that cannot be
// reached keeps what was found before.
const browse = document.getElementById('apps-browse');
if (browse && window.fetch && window.AbortSignal && AbortSignal.timeout && window.URL) apps(browse);

function apps(root) {
  const LISTING = 'com.pipobscure.bundle.listing';
  // The sha256 of LISTING: the `subject` of every app's listing.
  const SUBJECT = 'sha256:aa2e2af5c7e057ae771b9c28543044546b9107216418fbb511d1353fd55c1169';
  const INDEX = 'https://constellation.microcosm.blue';
  const PLC = 'https://plc.directory';
  const DOH = 'https://cloudflare-dns.com/dns-query';
  const CACHE = 'bundle.apps.v1';
  const FRESH = 10 * 60 * 1000;
  const DOC_AGE = 24 * 60 * 60 * 1000;
  const PER_PAGE = 10;
  const MAX_PAGES = 50;       // of 100, from the index and from each PDS
  const CONCURRENCY = 4;

  const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
  const DID = /^did:(?:plc:[a-z2-7]{24}|web:[A-Za-z0-9.%-]+)$/;
  const HANDLE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
  const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const LIMITS = { title: [640, 64], description: [3000, 300] };

  const form = root.querySelector('form');
  const input = root.querySelector('input[type=search]');
  const status = document.getElementById('apps-status');
  const list = document.getElementById('apps-list');
  const pager = document.getElementById('apps-pager');
  const prev = document.getElementById('apps-prev');
  const next = document.getElementById('apps-next');
  const where = document.getElementById('apps-where');

  let all = [];
  let page = 0;
  let state = 'loading';    // 'loading', 'ready', or 'failed'
  let missed = 0;           // publishers the last sync could not reach, and knew nothing of

  root.hidden = false;
  form.addEventListener('submit', (event) => event.preventDefault());
  input.addEventListener('input', () => { page = 0; render(); });
  prev.addEventListener('click', () => { page--; render(); list.focus(); });
  next.addEventListener('click', () => { page++; render(); list.focus(); });

  const cached = load();
  if (cached) show(cached);
  render();
  if (!cached || Date.now() - cached.syncedAt > FRESH) {
    sync(cached || { syncedAt: 0, publishers: {} })
      .then((found) => { missed = found.missed; delete found.missed; save(found); show(found); render(); })
      .catch(() => { if (!cached) state = 'failed'; render(); });
  }

  // ----------------------------------------------------------------- showing

  function show(found) {
    all = [];
    for (const [did, publisher] of Object.entries(found.publishers)) {
      const who = publisher.handle || did;
      for (const { name, title, description } of publisher.listings) {
        all.push({
          name, title, description, who,
          by: publisher.handle ? '@' + publisher.handle : did,
          profile: 'https://bsky.app/profile/' + encodeURIComponent(who),
          link: 'nzip:' + who + '/' + name,
          sort: (title || name).toLowerCase(),
        });
      }
    }
    all.sort((a, b) => a.sort.localeCompare(b.sort, 'en') || a.who.localeCompare(b.who, 'en') || a.name.localeCompare(b.name, 'en'));
    state = 'ready';
  }

  function render() {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = words.length
      ? all.filter((app) => {
        const text = [app.name, app.title, app.description, app.who].join(' ').toLowerCase();
        return words.every((word) => text.includes(word));
      })
      : all;
    const pages = Math.max(1, Math.ceil(shown.length / PER_PAGE));
    page = Math.min(Math.max(page, 0), pages - 1);

    list.replaceChildren(...shown.slice(page * PER_PAGE, (page + 1) * PER_PAGE).map(item));

    if (state === 'loading' && !all.length) status.textContent = 'Asking the Atmosphere which apps are published…';
    else if (state === 'failed' || (missed && !all.length)) status.textContent = 'The apps could not be loaded just now; bundle search lists them too.';
    else if (!all.length) status.textContent = 'No apps are published yet.';
    else if (words.length && !shown.length) status.textContent = 'No app matches “' + input.value.trim() + '”.';
    else if (words.length) status.textContent = shown.length + ' of ' + count(all.length) + (shown.length === 1 ? ' matches.' : ' match.');
    else status.textContent = count(all.length) + ', A to Z.';
    if (missed && all.length) status.textContent += ' Some publishers could not be reached just now; their apps are missing.';

    pager.hidden = pages <= 1;
    prev.disabled = page === 0;
    next.disabled = page >= pages - 1;
    where.textContent = 'Page ' + (page + 1) + ' of ' + pages;
  }

  function count(n) {
    return n === 1 ? '1 app' : n.toLocaleString('en') + ' apps';
  }

  // Everything from a listing goes in as text, never as markup.
  function item(app) {
    const li = document.createElement('li');
    li.className = 'app';
    const head = document.createElement('div');
    head.className = 'app-head';
    const h3 = document.createElement('h3');
    const by = document.createElement('span');
    by.className = 'by';
    const profile = document.createElement('a');
    profile.href = app.profile;
    profile.target = '_blank';
    profile.rel = 'noopener noreferrer';
    profile.textContent = app.by;
    by.append(' by ', profile);
    h3.append(app.title || app.name, by);
    const link = document.createElement('a');
    link.className = 'button compact';
    link.href = app.link;
    link.textContent = 'Install';
    const sr = document.createElement('span');
    sr.className = 'sr';
    sr.textContent = ' ' + (app.title || app.name) + ' by ' + app.by;
    link.append(sr);
    head.append(h3, link);
    li.append(head);
    if (app.description) {
      const p = document.createElement('p');
      p.textContent = app.description;
      li.append(p);
    }
    const meta = document.createElement('p');
    meta.className = 'app-meta';
    const code = document.createElement('code');
    code.textContent = app.link;
    meta.append(code);
    li.append(meta);
    return li;
  }

  // ------------------------------------------------------------------- cache

  // Read back as carefully as from the network: it is only this browser's
  // copy, but it is read as data, and one from an older page may differ.
  function load() {
    try {
      const found = JSON.parse(localStorage.getItem(CACHE));
      if (!found || !Number.isFinite(found.syncedAt) || typeof found.publishers !== 'object' || !found.publishers) return null;
      const publishers = {};
      for (const [did, p] of Object.entries(found.publishers)) {
        if (!DID.test(did) || !p || typeof p.pds !== 'string' || !/^https:\/\/[^/]+$/.test(p.pds) || !Number.isFinite(p.checkedAt) || !Array.isArray(p.listings)) continue;
        const handle = typeof p.handle === 'string' && HANDLE.test(p.handle) ? p.handle : null;
        const listings = p.listings.filter((l) => l && NAME.test(l.name) && text(l.title, 'title') && text(l.description, 'description'));
        publishers[did] = { pds: p.pds, handle, checkedAt: p.checkedAt, listings };
      }
      return { syncedAt: found.syncedAt, publishers };
    } catch {
      return null;
    }
  }

  function save(found) {
    try {
      localStorage.setItem(CACHE, JSON.stringify(found));
    } catch {
      // Private browsing, or storage full: next visit asks again.
    }
  }

  // ----------------------------------------------------------------- syncing

  // A publisher that cannot be reached keeps what was found before. One
  // found for the first time and not reached is missing, so the result is not
  // kept as fresh, and the next visit asks again.
  async function sync(before) {
    const dids = await publishersOfApps();
    const publishers = {};
    let missing = 0;
    const queue = [...dids].sort();
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let did = queue.shift(); did !== undefined; did = queue.shift()) {
        try {
          publishers[did] = await refresh(did, before.publishers[did]);
        } catch {
          if (before.publishers[did]) publishers[did] = before.publishers[did];
          else missing++;
        }
      }
    }));
    return { syncedAt: missing ? before.syncedAt : Date.now(), publishers, missed: missing };
  }

  async function publishersOfApps() {
    const dids = new Set();
    let cursor = null;
    for (let n = 0; n < MAX_PAGES; n++) {
      const params = new URLSearchParams({ subject: SUBJECT, source: LISTING + ':subject', limit: '100' });
      if (cursor) params.set('cursor', cursor);
      const page = await json(INDEX + '/xrpc/blue.microcosm.links.getBacklinks?' + params);
      const records = Array.isArray(page.records) ? page.records : [];
      for (const { did, collection, rkey } of records) {
        if (collection === LISTING && DID.test(did) && NAME.test(rkey)) dids.add(did);
      }
      cursor = records.length && typeof page.cursor === 'string' ? page.cursor : null;
      if (!cursor) break;
    }
    return dids;
  }

  // One publisher: where their repository is, whether their handle checks
  // out, and what they list. An account that moved is found again through its
  // DID document.
  async function refresh(did, before) {
    let pds = before ? before.pds : null;
    let handle = before ? before.handle : null;
    let checkedAt = before ? before.checkedAt : 0;
    let fresh = false;
    const lookUp = async () => {
      const doc = await didDocument(did);
      pds = pdsOf(doc);
      fresh = true;
      return doc;
    };
    if (!pds || Date.now() - checkedAt > DOC_AGE) {
      handle = await checkHandle(await lookUp());
      checkedAt = Date.now();
    }
    let listings;
    try {
      listings = await listingsOf(pds, did);
    } catch (err) {
      if (fresh) throw err;
      const was = pds;
      await lookUp();
      if (pds === was) throw err;
      listings = await listingsOf(pds, did);
    }
    return { pds, handle, checkedAt, listings };
  }

  async function didDocument(did) {
    let url;
    if (did.startsWith('did:plc:')) {
      url = PLC + '/' + encodeURIComponent(did);
    } else {
      const host = decodeURIComponent(did.slice('did:web:'.length));
      if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) throw new Error('not a hostname did:web');
      url = 'https://' + host + '/.well-known/did.json';
    }
    const doc = await json(url);
    if (!doc || doc.id !== did) throw new Error('not the document of ' + did);
    return doc;
  }

  function named(entry, did, fragment) {
    return entry && (entry.id === '#' + fragment || entry.id === did + '#' + fragment);
  }

  function pdsOf(doc) {
    const service = (Array.isArray(doc.service) ? doc.service : []).find((entry) => named(entry, doc.id, 'atproto_pds'));
    const url = new URL(service && typeof service.serviceEndpoint === 'string' ? service.serviceEndpoint : 'about:blank');
    if (url.protocol !== 'https:') throw new Error(doc.id + ' names no https PDS');
    return url.origin;
  }

  // The handle the DID document claims, if it points back at the DID: by its
  // `_atproto` TXT record, or else its well-known file.
  async function checkHandle(doc) {
    const aka = (Array.isArray(doc.alsoKnownAs) ? doc.alsoKnownAs : []).find((entry) => typeof entry === 'string' && entry.startsWith('at://'));
    const handle = aka ? aka.slice('at://'.length).toLowerCase() : '';
    if (!HANDLE.test(handle)) return null;
    let did;
    try {
      const params = new URLSearchParams({ name: '_atproto.' + handle, type: 'TXT' });
      const answer = await json(DOH + '?' + params, 'application/dns-json');
      const found = new Set((Array.isArray(answer.Answer) ? answer.Answer : [])
        .filter((record) => record.type === 16 && typeof record.data === 'string')
        .map((record) => record.data.replace(/^"|"$/g, '').split(/"\s*"/).join(''))
        .filter((text) => text.startsWith('did=')));
      if (found.size === 1) did = [...found][0].slice('did='.length);
    } catch {
      // No answer: try the well-known file.
    }
    if (!did) {
      try {
        const response = await fetch('https://' + handle + '/.well-known/atproto-did', { redirect: 'error', signal: AbortSignal.timeout(8000) });
        if (response.ok) did = (await response.text()).trim();
      } catch {
        // Not reachable from a page, often: shown by DID then.
      }
    }
    return did === doc.id ? handle : null;
  }

  // What a publisher lists as apps, read by the rules `bundle` reads them by;
  // what does not read as an app's listing is left out.
  async function listingsOf(pds, did) {
    const found = [];
    const prefix = 'at://' + did + '/' + LISTING + '/';
    let cursor = null;
    for (let n = 0; n < MAX_PAGES; n++) {
      const params = new URLSearchParams({ repo: did, collection: LISTING, limit: '100' });
      if (cursor) params.set('cursor', cursor);
      const page = await json(pds + '/xrpc/com.atproto.repo.listRecords?' + params);
      const records = Array.isArray(page.records) ? page.records : [];
      for (const { uri, value } of records) {
        if (typeof uri !== 'string' || !uri.startsWith(prefix)) continue;
        const name = uri.slice(prefix.length);
        if (isApp(value, name)) found.push({ name, title: value.title, description: value.description });
      }
      cursor = records.length && typeof page.cursor === 'string' ? page.cursor : null;
      if (!cursor) break;
    }
    return found;
  }

  function isApp(record, name) {
    if (!record || typeof record !== 'object' || record.$type !== LISTING || record.subject !== SUBJECT) return false;
    if (!NAME.test(name)) return false;
    if ((record.url === undefined) === (record.domain === undefined)) return false;
    if (record.url !== undefined) {
      if (typeof record.url !== 'string' || record.url.length > 2048) return false;
      try {
        if (new URL(record.url).protocol !== 'https:') return false;
      } catch {
        return false;
      }
    } else if (typeof record.domain !== 'string' || !DOMAIN.test(record.domain)) {
      return false;
    }
    return text(record.title, 'title') && text(record.description, 'description') && typeof record.createdAt === 'string';
  }

  // Absent, or text within the lexicon's limits.
  function text(value, field) {
    if (value === undefined) return true;
    if (typeof value !== 'string') return false;
    const [bytes, graphemes] = LIMITS[field];
    if (new TextEncoder().encode(value).length > bytes) return false;
    let n = 0;
    if (window.Intl && Intl.Segmenter) for (const _ of new Intl.Segmenter().segment(value)) n++;
    else n = [...value].length;
    return n <= graphemes;
  }

  async function json(url, accept = 'application/json') {
    const response = await fetch(url, { headers: { accept }, redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(url + ': ' + response.status);
    return await response.json();
  }
}
