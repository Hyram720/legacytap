const $ = (id) => document.getElementById(id);
const id = location.pathname.match(/^\/c\/([0-9a-f-]+)\/?$/)?.[1];
const api = id ? '/api/cards/' + id : null;
const status = $('status');
let viewRecorded = false;

async function request(action, options) {
  const response = await fetch(api + action, options);
  if (!response.ok) throw new Error('Request failed');
  return response.json();
}

async function recordView() {
  if (viewRecorded) return;
  viewRecorded = true;
  try {
    const key = 'legacytap-visit-' + id;
    let visit = sessionStorage.getItem(key);
    if (!visit) {
      visit = crypto.randomUUID();
      sessionStorage.setItem(key, visit);
    }
    await request('/view', { method: 'POST', headers: { 'X-LegacyTap-Visit': visit } });
  } catch {
    viewRecorded = false;
  }
}

async function load() {
  if (!api) throw new Error('Invalid link');
  const card = await request('');
  $('headline').textContent = card.headline;
  $('transcript').textContent = card.transcript;
  $('video').src = api + '/video';
  $('video').addEventListener('playing', recordView);
  $('video').addEventListener('error', () => {
    status.textContent = 'The video could not play. You can still read the transcript or request a call.';
  });
  $('callback').addEventListener('click', async () => {
    $('callback').disabled = true;
    try {
      await request('/callback', { method: 'POST' });
      status.textContent = 'Your callback request was recorded.';
    } catch {
      status.textContent = 'Your request could not be recorded. Please try again.';
      $('callback').disabled = false;
    }
  });
  $('content').hidden = false;
  status.textContent = '';
}
load().catch(() => { status.textContent = 'This video card is unavailable. Ask the sender for a fresh link.'; });
