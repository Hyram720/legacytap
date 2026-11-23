const hostedKey = 'legacytap-hosted-cards-v1';
const hostedLimit = 3 * 1024 * 1024;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[ch]);

function hostedCards() {
  try {
    const cards = JSON.parse(localStorage.getItem(hostedKey));
    return Array.isArray(cards) ? cards : [];
  } catch { return []; }
}

async function hostedRequest(path, { method = 'GET', key, body } = {}) {
  const response = await fetch('/api/cards' + path, {
    method, body, headers: key ? { Authorization: 'Bearer ' + key } : {}
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) {
    const error = new Error(result?.error || 'Hosted publishing is unavailable in this environment.');
    error.status = response.status;
    throw error;
  }
  return result;
}

const hostedUrl = card => new URL('/c/' + card.id, location.origin).href;
const revokeHosted = card => hostedRequest('/' + card.id + '/revoke', { method: 'POST', key: card.ownerKey });

function openHostedCard(localId) {
  const card = S.cards.find(item => item.id === localId);
  if (!card) return;
  if (!card.hasVideo) {
    toast('Record or upload a video before sharing.');
    return;
  }
  const existing = hostedCards().find(item => item.localId === localId);
  const modal = document.getElementById('modal');
  modal.innerHTML = `<div class="mh"><h3>${existing ? 'Share video card' : 'Publish video card'}</h3><button type="button" class="x" aria-label="Close" onclick="closeM()">✕</button></div>
    <div class="mb">
      <p class="muted">Use one card per recipient so you know who to call. Anyone with the link can watch. Keep names, personal information, and policy details out of the video and text.</p>
      <div id="hosted-publish"></div>
      <p id="hosted-publish-status" role="status" aria-live="polite"></p>
    </div>`;
  const area = document.getElementById('hosted-publish');
  const status = document.getElementById('hosted-publish-status');
  if (existing) {
    area.innerHTML = '<label class="fl" for="hosted-link">Recipient link</label><input class="in" id="hosted-link" readonly><div class="hosted-actions"><button type="button" class="btn primary" id="hosted-copy">Copy link</button><a class="btn" id="hosted-open" target="_blank" rel="noopener noreferrer">Open recipient page</a><button type="button" class="btn ghost" id="hosted-revoke">Revoke link</button></div>';
    const link = hostedUrl(existing);
    const linkField = document.getElementById('hosted-link');
    linkField.value = link;
    document.getElementById('hosted-open').href = link;
    document.getElementById('hosted-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(link); status.textContent = 'Link copied.'; }
      catch { linkField.select(); status.textContent = 'Copy the selected link.'; }
    };
    document.getElementById('hosted-revoke').onclick = async () => {
      if (!confirm('Revoke this link and remove its hosted video and activity?')) return;
      try {
        await revokeHosted(existing);
        localStorage.setItem(hostedKey, JSON.stringify(hostedCards().filter(item => item.id !== existing.id)));
        openHostedCard(localId);
      } catch (error) { status.textContent = error.message; }
    };
  } else {
    area.innerHTML = '<form id="hosted-form"><label class="fl" for="hosted-headline">Public headline</label><input class="in" id="hosted-headline" required maxlength="120"><label class="fl" for="hosted-transcript">Video transcript</label><textarea class="in" id="hosted-transcript" required maxlength="3000"></textarea><label class="fl" for="hosted-password">Publishing passphrase</label><input class="in" id="hosted-password" type="password" autocomplete="off" required><div class="hosted-actions"><button type="submit" class="btn primary">Publish and get link</button></div></form>';
    document.getElementById('hosted-headline').value = card.hook || 'Your video follow-up';
    const form = document.getElementById('hosted-form');
    form.onsubmit = async event => {
      event.preventDefault();
      const button = form.querySelector('button');
      button.disabled = true;
      status.textContent = 'Publishing video…';
      try {
        const video = await VDB.get(localId);
        if (!video || video.size > hostedLimit) throw new Error('Choose an MP4 or WebM clip of 3 MB or less.');
        const body = new FormData();
        body.set('headline', document.getElementById('hosted-headline').value);
        body.set('transcript', document.getElementById('hosted-transcript').value);
        body.set('video', video, video.type.includes('mp4') ? 'video.mp4' : 'video.webm');
        const password = document.getElementById('hosted-password');
        const key = password.value;
        password.value = '';
        const published = await hostedRequest('', { method: 'POST', body, key });
        try {
          localStorage.setItem(hostedKey, JSON.stringify([...hostedCards(), { ...published, localId, label: card.title }]));
        } catch {
          await revokeHosted(published);
          throw new Error('This browser could not save card access. Free browser storage and try again.');
        }
        render();
        if (form.isConnected) openHostedCard(localId);
      } catch (error) { status.textContent = error.message; }
      finally { button.disabled = false; }
    };
  }
  openM();
}

function hostedDashboard() {
  return `<section class="card hosted-queue" aria-labelledby="hosted-title">
    <div class="hosted-actions hosted-heading"><h3 id="hosted-title">Callback queue</h3><button type="button" class="btn sm" onclick="loadHostedQueue()">Refresh</button></div>
    <p class="muted fz13">Track video starts and callback requests from published links on this browser.</p>
    <p id="hosted-queue-status" role="status"></p><ul id="hosted-queue-list"></ul>
  </section>`;
}

async function loadHostedQueue() {
  const list = document.getElementById('hosted-queue-list');
  const status = document.getElementById('hosted-queue-status');
  if (!list || !status) return;
  const cards = hostedCards();
  if (!cards.length) {
    status.textContent = 'Publish your first video card to start tracking activity.';
    return;
  }
  status.textContent = 'Checking for callbacks…';
  const activity = await Promise.allSettled(cards.map(card =>
    hostedRequest('/' + card.id + '/activity', { key: card.ownerKey }).then(data => ({ ...card, ...data }))
  ));
  if (!list.isConnected) return;
  list.replaceChildren();
  const available = activity.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  const pending = item => item.callbackAt && !item.completedAt;
  available.sort((a, b) => Number(!!pending(b)) - Number(!!pending(a)) || String(b.callbackAt || '').localeCompare(String(a.callbackAt || '')));
  const unavailable = activity.length - available.length;
  status.textContent = unavailable ? unavailable + ' card(s) could not be loaded.' : '';
  for (const card of available) {
    const row = document.createElement('li');
    const label = document.createElement('strong');
    label.textContent = card.label;
    const detail = document.createElement('span');
    detail.textContent = pending(card) ? 'Call requested · ' + new Date(card.callbackAt).toLocaleString() : card.completedAt ? 'Callback marked complete' : 'No callback requested';
    row.append(label, document.createTextNode(' · ' + card.views + (card.views === 1 ? ' video start · ' : ' video starts · ')), detail);
    if (pending(card)) {
      const done = document.createElement('button');
      done.className = 'btn sm';
      done.textContent = 'Mark complete';
      done.onclick = async () => {
        done.disabled = true;
        try {
          await hostedRequest('/' + card.id + '/complete', { method: 'POST', key: card.ownerKey });
          await loadHostedQueue();
        } catch (error) { status.textContent = error.message; done.disabled = false; }
      };
      row.append(done);
    }
    list.append(row);
  }
}
