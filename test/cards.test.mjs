import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createHandler } from '../netlify/functions/cards.mjs';

function memoryStore() {
  const entries = new Map();
  return {
    async set(key, data) { entries.set(key, { data: structuredClone(data), etag: randomUUID() }); },
    async setJSON(key, data, options) {
      if (options?.onlyIfMatch && entries.get(key)?.etag !== options.onlyIfMatch) return { modified: false };
      await this.set(key, data);
      return { modified: true };
    },
    async getWithMetadata(key) { return structuredClone(entries.get(key) ?? null); },
    async get(key) {
      const data = entries.get(key)?.data;
      return data instanceof Uint8Array ? data.slice().buffer : data;
    },
    async delete(key) { entries.delete(key); },
  };
}

const publishSecret = 'synthetic publishing passphrase';
function request(handler, { id, action, key, visit, method = 'GET', body, origin = 'https://demo.example', range } = {}) {
  const headers = {};
  if (method === 'POST') headers.Origin = origin;
  if (key) headers.Authorization = 'Bearer ' + key;
  if (visit) headers['X-LegacyTap-Visit'] = visit;
  if (range) headers.Range = range;
  return handler(new Request('https://demo.example/api/cards' + (id ? '/' + id : '') + (action ? '/' + action : ''), { method, headers, body }), { params: { id, action } });
}

function upload(bytes = Uint8Array.from([0, 0, 0, 16, 102, 116, 121, 112, 0, 0, 0, 0])) {
  const body = new FormData();
  body.set('headline', 'A sample follow-up');
  body.set('transcript', 'Thanks for your time.');
  body.set('video', new File([bytes], 'sample.mp4'));
  return body;
}

test('hosted card works for a recipient and private callback actions require ownership', async () => {
  const store = memoryStore();
  const handler = createHandler(() => store, () => publishSecret);
  const publish = await request(handler, { method: 'POST', key: publishSecret, body: upload() });
  assert.equal(publish.status, 201);
  const { id, ownerKey } = await publish.json();
  const recipient = await request(handler, { id });
  assert.equal(recipient.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.deepEqual(await recipient.json(), { headline: 'A sample follow-up', transcript: 'Thanks for your time.' });
  const video = await request(handler, { id, action: 'video', range: 'bytes=0-3' });
  assert.equal(video.status, 206);
  assert.equal(video.headers.get('content-type'), 'video/mp4');
  assert.equal((await video.arrayBuffer()).byteLength, 4);
  assert.equal((await request(handler, { id, action: 'video', range: 'bytes=30-31' })).status, 416);
  assert.equal((await request(handler, { id, action: 'activity' })).status, 401);
  const visit = randomUUID();
  const playback = { id, action: 'view', method: 'POST', visit };
  const callback = { id, action: 'callback', method: 'POST' };
  const events = await Promise.all([request(handler, playback), request(handler, playback), request(handler, callback), request(handler, callback)]);
  assert.ok(events.every(response => response.ok));
  const activityParams = { id, action: 'activity', key: ownerKey };
  const pending = await (await request(handler, activityParams)).json();
  assert.equal(pending.views, 1);
  assert.ok(pending.callbackAt);
  assert.equal(pending.completedAt, null);
  const complete = { id, action: 'complete', method: 'POST' };
  assert.equal((await request(handler, complete)).status, 401);
  assert.equal((await request(handler, { ...complete, key: ownerKey })).status, 200);
  const done = await (await request(handler, activityParams)).json();
  assert.ok(done.completedAt);
  assert.equal((await request(handler, { id, action: 'revoke', method: 'POST', key: ownerKey })).status, 200);
  assert.equal((await request(handler, { id })).status, 404);
  assert.equal((await request(handler, { id, action: 'video' })).status, 404);
});

test('publishing rejects missing configuration, unauthorized uploads, and invalid video', async () => {
  const store = memoryStore();
  const handler = createHandler(() => store, () => publishSecret);
  const params = { method: 'POST', body: upload() };
  assert.equal((await request(handler, params)).status, 401);
  assert.equal((await request(handler, { ...params, key: publishSecret, origin: 'https://other.example' })).status, 403);
  const disabled = createHandler(() => store, () => '');
  assert.equal((await request(disabled, { ...params, key: publishSecret })).status, 503);
  assert.equal((await request(handler, { ...params, key: publishSecret, body: upload(new Uint8Array(20)) })).status, 415);
  assert.equal((await request(handler, { ...params, key: publishSecret, body: upload(new Uint8Array(3 * 1024 * 1024 + 1)) })).status, 413);
});
