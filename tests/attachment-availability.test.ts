import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachmentAvailability } from '../server/attachment-availability.ts';
const record = {
  prefix: '/users/0',
  zotero_key: 'ABC12345',
  server_id: null,
  content_type: 'application/pdf',
};
test('attachment checks distinguish valid files, empty files, absent files and invalid PDFs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-attachments-'));
  const file = join(dir, 'file');
  const client = { attachmentPath: async () => file };
  try {
    assert.equal((await attachmentAvailability(client, record)).state, 'missing');
    await writeFile(file, '');
    assert.equal((await attachmentAvailability(client, record)).state, 'empty');
    await writeFile(file, '<html>Snapshot</html>');
    assert.equal((await attachmentAvailability(client, record)).state, 'unknown');
    assert.equal(
      (await attachmentAvailability(client, { ...record, content_type: 'text/html' })).state,
      'available',
    );
    await writeFile(file, '%PDF-1.7\nDocument');
    assert.equal((await attachmentAvailability(client, record)).state, 'available');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('offline and permission failures are not mistaken for missing files', async () => {
  for (const error of [
    new Error('Zotero offline'),
    Object.assign(new Error('Forbidden'), { status: 403 }),
    Object.assign(new Error('Permission denied'), { code: 'EACCES' }),
  ]) {
    assert.equal(
      (
        await attachmentAvailability(
          {
            attachmentPath: async () => {
              throw error;
            },
          },
          record,
        )
      ).state,
      'unknown',
    );
  }
  assert.equal(
    (
      await attachmentAvailability(
        {
          attachmentPath: async () => {
            throw Object.assign(new Error('Missing'), { status: 404 });
          },
        },
        record,
      )
    ).state,
    'missing',
  );
});

test('cleanup rechecks files, refuses available or uncertain files, and restores without Zotero', async () => {
  const { setAttachmentVisibility } = await import('../server/attachment-availability.ts');
  const settings = new Map<string, string>();
  const library = {
    attachment: (id: string) => (id === 'attachment' ? record : undefined),
    setSetting: (key: string, value: string) => settings.set(key, value),
  } as unknown as import('../server/database.ts').AtlasDatabase;
  const missing = {
    attachmentPath: async () => {
      throw Object.assign(new Error('Missing'), { status: 404 });
    },
  };
  assert.equal((await setAttachmentVisibility(library, missing, 'attachment', true)).hidden, true);
  assert.equal(settings.get('hidden-attachment:attachment'), 'true');
  const offline = {
    attachmentPath: async () => {
      throw new Error('Offline');
    },
  };
  await assert.rejects(
    setAttachmentVisibility(library, offline, 'attachment', true),
    /Only confirmed/,
  );
  await setAttachmentVisibility(library, offline, 'attachment', false);
  assert.equal(settings.get('hidden-attachment:attachment'), 'false');
  await assert.rejects(setAttachmentVisibility(library, missing, 'unknown', true), /not found/);
  const dir = await mkdtemp(join(tmpdir(), 'atlas-hide-'));
  try {
    const file = join(dir, 'paper.pdf');
    await writeFile(file, '%PDF-1.7\nData');
    await assert.rejects(
      setAttachmentVisibility(library, { attachmentPath: async () => file }, 'attachment', true),
      /Only confirmed/,
    );
    assert.equal(settings.get('hidden-attachment:attachment'), 'false');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
