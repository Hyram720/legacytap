import { getDeployStore, getStore } from '@netlify/blobs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

const headers = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
};
const videoLimit = 3 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const json = (data, status = 200) => Response.json(data, { status, headers });
const fail = (error, status) => json({ error }, status);
const digest = (text) => createHash('sha256').update(text).digest();
const matches = (value, expected) => !!value && !!expected && timingSafeEqual(digest(value), digest(expected));
const bearer = (request) => request.headers.get('Authorization')?.match(/^Bearer (.+)$/i)?.[1];
const mediaKey = (id) => 'video/' + id;
const cardKey = (id) => 'card/' + id;
const text = (form, name, max) => String(form.get(name) ?? '').trim().slice(0, max);

function mediaType(bytes) {
  if (bytes.length < 12) return '';
  if (bytes.subarray(4, 8).toString() === 'ftyp') return 'video/mp4';
  if (bytes.readUInt32BE(0) === 0x1a45dfa3) return 'video/webm';
  return '';
}

function videoResponse(request, entry, type) {
  const range = request.headers.get('Range');
  const videoHeaders = { ...headers, 'Content-Type': type, 'Accept-Ranges': 'bytes' };
  const size = entry.byteLength;
  if (!range) return new Response(entry, { headers: { ...videoHeaders, 'Content-Length': size } });
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (match && (match[1] || match[2])) {
    const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (Number.isInteger(start) && start <= end) {
      return new Response(entry.slice(start, end + 1), {
        status: 206,
        headers: { ...videoHeaders, 'Content-Range': 'bytes ' + start + '-' + end + '/' + size, 'Content-Length': end - start + 1 },
      });
    }
  }
  return new Response(null, { status: 416, headers: { ...videoHeaders, 'Content-Range': 'bytes */' + size } });
}

async function createCard(request, store, publishKey) {
  if (!publishKey) return fail('Hosted publishing is not configured yet.', 503);
  if (!matches(bearer(request), publishKey)) return fail('Publishing access denied.', 401);
  if (Number(request.headers.get('Content-Length')) > videoLimit + 16_384) return fail('Video must be 3 MB or smaller.', 413);
  const form = await request.formData().catch(() => null);
  if (!form) return fail('Invalid upload.', 400);
  const file = form.get('video');
  const headline = text(form, 'headline', 120);
  const transcript = text(form, 'transcript', 3000);
  if (!headline || !transcript || !(file instanceof File) || !file.size) {
    return fail('Add a public headline, transcript, and video.', 400);
  }
  if (file.size > videoLimit) return fail('Video must be 3 MB or smaller.', 413);
  const bytes = Buffer.from(await file.arrayBuffer());
  const type = mediaType(bytes);
  if (!type) return fail('Use a WebM or MP4 video.', 415);
  const id = randomUUID();
  const ownerKey = randomUUID();
  await store.set(mediaKey(id), bytes, { metadata: { type } });
  try {
    await store.setJSON(cardKey(id), { headline, transcript, type, ownerHash: digest(ownerKey).toString('hex'), viewers: [], callbackAt: null, completedAt: null });
  } catch (error) {
    await store.delete(mediaKey(id)).catch(() => {});
    throw error;
  }
  return json({ id, ownerKey }, 201);
}

export function createHandler(resolveStore, publishKey) {
  return async (request, context) => {
    const url = new URL(request.url);
    if (request.method === 'POST' && request.headers.get('Origin') !== url.origin) {
      return fail('Open LegacyTap to continue.', 403);
    }
    const { id, action } = context.params ?? {};
    if (id && !uuid.test(id)) return fail('Card not found.', 404);
    try {
      const method = request.method;
      if (!id && method === 'POST') return await createCard(request, resolveStore(context), publishKey());
      if (!id) return fail('Card not found.', 404);
      const store = resolveStore(context);
      const record = await store.getWithMetadata(cardKey(id), { type: 'json', consistency: 'strong' });
      if (!record) return fail('Card not found.', 404);
      const card = record.data;
      if (!action && method === 'GET') return json({ headline: card.headline, transcript: card.transcript });
      if (action === 'video' && method === 'GET') {
        const entry = await store.get(mediaKey(id), { type: 'arrayBuffer', consistency: 'strong' });
        if (!entry) return fail('Video not found.', 404);
        return videoResponse(request, entry, card.type);
      }
      if (['activity', 'complete', 'revoke'].includes(action)) {
        const key = bearer(request);
        if (!key || !uuid.test(key) || !timingSafeEqual(digest(key), Buffer.from(card.ownerHash, 'hex'))) {
          return fail('Card owner access required.', 401);
        }
        if (action === 'activity' && method === 'GET') {
          return json({ views: card.viewers.length, callbackAt: card.callbackAt, completedAt: card.completedAt ?? null });
        }
        if (action === 'revoke' && method === 'POST') {
          await store.delete(mediaKey(id));
          await store.delete(cardKey(id));
          return json({ revoked: true });
        }
      }
      if (method !== 'POST' || !['view', 'callback', 'complete'].includes(action)) return fail('Action not found.', 404);
      const visitor = request.headers.get('X-LegacyTap-Visit');
      if (action === 'view' && !uuid.test(visitor ?? '')) return fail('Invalid visit.', 400);
      let current = record;
      for (let attempt = 0; attempt < 6; attempt++) {
        if (!current) return fail('Card not found.', 404);
        const next = current.data;
        if (action === 'callback') {
          if (next.callbackAt) return json({ recorded: true });
          next.callbackAt = new Date().toISOString();
        } else if (action === 'complete') {
          if (!next.callbackAt) return fail('There is no callback request yet.', 409);
          if (next.completedAt) return json({ recorded: true });
          next.completedAt = new Date().toISOString();
        } else {
          if (next.viewers.includes(visitor) || next.viewers.length >= 2000) return json({ recorded: true });
          next.viewers.push(visitor);
        }
        const result = await store.setJSON(cardKey(id), next, { onlyIfMatch: current.etag });
        if (result.modified) return json({ recorded: true });
        current = await store.getWithMetadata(cardKey(id), { type: 'json', consistency: 'strong' });
      }
      return fail('Please try again.', 503);
    } catch {
      return fail('LegacyTap could not complete the request. Please try again.', 503);
    }
  };
}

export default createHandler(
  (context) => context.deploy?.context === 'production' ? getStore('legacytap-hosted-v1') : getDeployStore('legacytap-preview-v1'),
  () => Netlify.env.get('LEGACYTAP_PUBLISH_KEY')
);

export const config = { path: ['/api/cards', '/api/cards/:id', '/api/cards/:id/:action'] };
