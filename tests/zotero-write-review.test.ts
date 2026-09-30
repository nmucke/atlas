import test from 'node:test';
import assert from 'node:assert/strict';
import { ZoteroWriter } from '../server/zotero-write.ts';

function fixture(remember = true) {
  const calls: { url: URL; method: string; headers: Headers; body: BodyInit | null | undefined }[] =
    [];
  const state = {
    serverId: 'profile-one',
    writeStatus: 204,
    uploadUrl: 'http://localhost:23119/api/local/uploads/upload-token',
  };
  const secret = 'k'.repeat(32);
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
    };
    calls.push(call);
    if (url.pathname === '/api/')
      return new Response('', {
        headers: {
          'X-Zotero-Version': '10.0.4',
          'Zotero-Server-ID': state.serverId,
        },
      });
    if (url.pathname === '/api/local/authorize') return Response.json({ key: secret, remember });
    if (url.pathname.startsWith('/api/local/uploads/')) return new Response(null, { status: 201 });
    if (url.pathname.endsWith('/file') && !String(call.body).startsWith('upload=')) {
      return Response.json({
        url: state.uploadUrl,
        uploadKey: 'upload-token',
        contentType: 'application/pdf',
      });
    }
    return new Response(null, { status: state.writeStatus });
  }) as typeof fetch;
  return { writer: new ZoteroWriter(fetcher), calls, state, secret };
}

test('automatic PDF writes require a remembered grant and never open authorization themselves', async () => {
  const f = fixture(false);
  await assert.rejects(
    () => f.writer.write('/users/0/items', 'POST', '[]', {}, true, 'profile-one'),
    /remembered/,
  );
  assert.equal(
    f.calls.some((call) => call.url.pathname.endsWith('/authorize')),
    false,
  );
  const authorized = await f.writer.authorize();
  assert.deepEqual(authorized, { authorized: true, automaticPdfWrites: false });
  assert.equal(JSON.stringify(await f.writer.probe()).includes(f.secret), false);
  await assert.rejects(
    () => f.writer.write('/users/0/items', 'POST', '[]', {}, true, 'profile-one'),
    /remembered/,
  );
  await f.writer.write(
    '/users/0/items/ABCD2345',
    'PATCH',
    '{"deleted":1}',
    {},
    false,
    'profile-one',
  );
  assert.equal((await f.writer.probe()).authorized, false);
});

test('profile switching and revoked authorization block writes without reopening permission dialogs', async () => {
  const f = fixture();
  await f.writer.authorize();
  f.state.serverId = 'profile-two';
  await assert.rejects(
    () => f.writer.write('/users/0/items', 'POST', '[]', {}, true, 'profile-one'),
    /profile changed/,
  );
  assert.equal(
    f.calls.some((call) => call.url.pathname === '/api/users/0/items'),
    false,
  );
  assert.equal((await f.writer.probe()).authorized, false);
  await f.writer.authorize();
  f.state.writeStatus = 401;
  await assert.rejects(
    () => f.writer.write('/users/0/items', 'POST', '[]', {}, true, 'profile-two'),
    /expired/,
  );
  assert.equal((await f.writer.probe()).authorized, false);
  assert.equal(f.calls.filter((call) => call.url.pathname.endsWith('/authorize')).length, 2);
});

test('three-phase local upload keeps credentials off the upload URL request', async () => {
  const f = fixture();
  await f.writer.authorize();
  const pdf = Buffer.from('%PDF-1.7\nfixture');
  await f.writer.upload('/users/0', 'ABCD2345', pdf, 'paper.pdf', 'profile-one');
  const phases = f.calls.filter(
    (call) => call.method === 'POST' && !call.url.pathname.endsWith('/authorize'),
  );
  assert.equal(phases.length, 3);
  assert.equal(phases[0].headers.get('Zotero-API-Key'), f.secret);
  assert.equal(phases[0].headers.get('If-None-Match'), '*');
  assert.equal(phases[1].url.hostname, 'localhost');
  assert.equal(phases[1].headers.has('Zotero-API-Key'), false);
  assert.equal(phases[1].headers.has('Zotero-Server-ID'), false);
  assert.deepEqual(Buffer.from(phases[1].body as Uint8Array), pdf);
  assert.equal(phases[2].headers.get('Zotero-API-Key'), f.secret);
  assert.equal(phases[2].headers.get('If-None-Match'), '*');
  assert.equal(String(phases[2].body), 'upload=upload-token');
});

test('local upload rejects an off-host upload destination before sending PDF bytes', async () => {
  const f = fixture();
  await f.writer.authorize();
  f.state.uploadUrl = 'https://example.org/api/local/uploads/token';
  await assert.rejects(
    () =>
      f.writer.upload('/users/0', 'ABCD2345', Buffer.from('%PDF-1.7'), 'paper.pdf', 'profile-one'),
    /unsafe upload URL/,
  );
  assert.equal(
    f.calls.some((call) => call.url.hostname === 'example.org'),
    false,
  );
});
