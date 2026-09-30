import { createHash } from 'node:crypto';

// Keep verified bytes between lookup and attachment, avoiding a second slow download.
export class PdfDownloadCache {
  private entries = new Map<string, { bytes: Buffer; expires: number }>();
  private size = 0;
  constructor(privateLimit = 80 * 1024 * 1024, privateTtl = 30 * 60 * 1000) {
    this.limit = privateLimit;
    this.ttl = privateTtl;
  }
  private limit: number;
  private ttl: number;
  private remove(hash: string) {
    const entry = this.entries.get(hash);
    if (entry) this.size -= entry.bytes.length;
    this.entries.delete(hash);
  }
  put(bytes: Buffer) {
    const hash = createHash('sha256').update(bytes).digest('hex');
    this.remove(hash);
    for (const [key, value] of this.entries) if (value.expires <= Date.now()) this.remove(key);
    if (bytes.length > this.limit) return hash;
    while (this.size + bytes.length > this.limit) this.remove(this.entries.keys().next().value!);
    this.entries.set(hash, { bytes: Buffer.from(bytes), expires: Date.now() + this.ttl });
    this.size += bytes.length;
    return hash;
  }
  get(hash: string) {
    const entry = this.entries.get(hash);
    if (!entry || entry.expires <= Date.now()) {
      this.remove(hash);
      return null;
    }
    return Buffer.from(entry.bytes);
  }
  clear() {
    this.entries.clear();
    this.size = 0;
  }
}
