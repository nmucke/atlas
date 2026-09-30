import { open } from 'node:fs/promises';
import type { ZoteroClient } from './zotero.ts';

export async function attachmentAvailability(
  client: Pick<ZoteroClient, 'attachmentPath'>,
  record: { prefix: string; zotero_key: string; server_id: string | null; content_type: string },
) {
  let handle;
  try {
    const path = await client.attachmentPath(record);
    handle = await open(path, 'r');
    const info = await handle.stat();
    if (!info.isFile() || !info.size)
      return {
        state: 'empty' as const,
        message: 'No usable file data at the local attachment path.',
      };
    if (record.content_type === 'application/pdf') {
      const signature = Buffer.alloc(1024);
      await handle.read(signature, 0, 1024, 0);
      if (!signature.includes(Buffer.from('%PDF-')))
        return {
          state: 'unknown' as const,
          message: 'A file exists, but it is not a valid PDF. Inspect it in Zotero.',
        };
    }
    return { state: 'available' as const, message: 'File available locally.' };
  } catch (error) {
    const e = error as { code?: string; status?: number; message?: string };
    if (e.code === 'ENOENT' || e.status === 404)
      return {
        state: 'missing' as const,
        message:
          'Not available locally. A copy may still exist in Zotero cloud storage or on another computer.',
      };
    return { state: 'unknown' as const, message: e.message || 'Unable to check this attachment.' };
  } finally {
    await handle?.close();
  }
}

export async function setAttachmentVisibility(
  library: import('./database.ts').AtlasDatabase,
  client: Pick<ZoteroClient, 'attachmentPath'>,
  attachmentId: string,
  hidden: boolean,
) {
  const record = library.attachment(attachmentId);
  if (!record) throw new Error('Attachment not found');
  if (hidden) {
    const result = await attachmentAvailability(client, record);
    if (!['missing', 'empty'].includes(result.state))
      throw new Error(
        'Only confirmed missing or empty local files can be hidden. Recheck the attachment.',
      );
  }
  library.setSetting(`hidden-attachment:${attachmentId}`, String(hidden));
  return { attachmentId, hidden, zoteroChanged: false };
}
