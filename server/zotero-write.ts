import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { ZOTERO_BASE } from './zotero.ts';

const PDF_LIMIT = 100 * 1024 * 1024;

export function publicHttpsUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !url.hostname ||
    (url.port && url.port !== '443') ||
    isIP(url.hostname) ||
    url.hostname.toLowerCase() === 'localhost' ||
    url.hostname.toLowerCase().endsWith('.localhost')
  )
    throw new Error('PDF source must be a public HTTPS URL');
  return url;
}

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return !(
      normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb') ||
      normalized.startsWith('ff') ||
      normalized.startsWith('2001:db8:') ||
      normalized.startsWith('::ffff:')
    );
  }
  return false;
}

type PdfResponse = { status: number; location?: string; data?: Buffer };
type PdfAddress = { address: string; family: number };
export type PdfDownloadDependencies = {
  resolve: (hostname: string) => Promise<PdfAddress[]>;
  request: (url: URL, address: PdfAddress, timeout: number) => Promise<PdfResponse>;
  pause: (ms: number) => Promise<void>;
  now: () => number;
};
function requestPdf(url: URL, address: PdfAddress, timeout: number): Promise<PdfResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: 'GET',
        family: address.family,
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
        headers: {
          Accept: 'application/pdf',
          'User-Agent': 'Atlas/0.2 (research library PDF downloader)',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status !== 200) {
          resolve({ status, location: res.headers.location });
          res.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > PDF_LIMIT) {
            req.destroy(
              Object.assign(new Error('PDF exceeds the 100 MB download limit'), {
                retryable: false,
              }),
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status, data: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    const connectTimer = setTimeout(
      () => req.destroy(new Error('PDF connection timed out')),
      Math.min(12000, timeout),
    );
    req.on('socket', (socket) => socket.once('secureConnect', () => clearTimeout(connectTimer)));
    req.setTimeout(45000, () => req.destroy(new Error('PDF download stalled')));
    const totalTimer = setTimeout(
      () => req.destroy(new Error('PDF download attempt timed out')),
      timeout,
    );
    req.on('close', () => {
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
    });
    req.on('error', reject);
    req.end();
  });
}
export async function downloadPublicPdf(
  initialUrl: string,
  overrides: Partial<PdfDownloadDependencies> = {},
): Promise<Buffer> {
  const deps: PdfDownloadDependencies = {
    resolve: (hostname) => lookup(hostname, { all: true }),
    request: requestPdf,
    pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    ...overrides,
  };
  const deadline = deps.now() + 240000;
  let url = publicHttpsUrl(initialUrl);
  for (let redirect = 0; redirect <= 3; redirect++) {
    let dnsTimer: ReturnType<typeof setTimeout> | undefined;
    const addresses = await Promise.race([
      deps.resolve(url.hostname),
      new Promise<never>((_, reject) => {
        dnsTimer = setTimeout(
          () => reject(new Error('PDF hostname lookup timed out')),
          Math.max(1, Math.min(15000, deadline - deps.now())),
        );
      }),
    ]).finally(() => clearTimeout(dnsTimer));
    if (!addresses.length || addresses.some((entry) => !publicAddress(entry.address)))
      throw new Error('PDF source resolved to a non-public address');
    // IPv4 first avoids black-holed IPv6 routes; failures try another pinned address.
    const choices = addresses.sort((a, b) => a.family - b.family).slice(0, 4);
    let response: PdfResponse | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < Math.max(2, choices.length); attempt++) {
      const remaining = deadline - deps.now();
      if (remaining <= 0) break;
      try {
        response = await deps.request(
          url,
          choices[attempt % choices.length],
          Math.min(120000, remaining),
        );
      } catch (error) {
        if ((error as { retryable?: boolean }).retryable === false) throw error;
        lastError = error;
        response = undefined;
      }
      if (response && ![408, 429, 500, 502, 503, 504].includes(response.status)) break;
      if (response) lastError = new Error(`PDF source returned HTTP ${response.status}`);
      response = undefined;
      if (attempt + 1 < Math.max(2, choices.length))
        await deps.pause(Math.min(1000, Math.max(0, deadline - deps.now())));
    }
    if (!response)
      throw new Error(
        `PDF download failed after automatic retries: ${lastError instanceof Error ? lastError.message : 'overall time limit reached'}`,
      );
    if (response.status === 200 && response.data) {
      if (response.data.length > PDF_LIMIT)
        throw new Error('PDF exceeds the 100 MB download limit');
      if (!response.data.subarray(0, 1024).includes(Buffer.from('%PDF-')))
        throw new Error('The source did not return a PDF');
      return response.data;
    }
    if (response.status < 300 || response.status >= 400)
      throw new Error(`PDF source returned HTTP ${response.status}`);
    if (!response.location || redirect === 3) throw new Error('Too many PDF redirects');
    url = publicHttpsUrl(new URL(response.location, url).href);
  }
  throw new Error('Too many PDF redirects');
}

export class ZoteroWriter {
  private fetcher: typeof fetch;
  private key: string | null = null;
  private remembered = false;
  private serverId: string | null = null;
  constructor(fetcher: typeof fetch = fetch) {
    this.fetcher = fetcher;
  }

  async probe() {
    const response = await this.fetcher(`${ZOTERO_BASE}/`, {
      headers: { 'Zotero-API-Version': '3', 'Zotero-Allowed-Request': 'true' },
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Zotero local API returned HTTP ${response.status}`);
    await response.body?.cancel();
    const version = response.headers.get('X-Zotero-Version') ?? '';
    const id = response.headers.get('Zotero-Server-ID');
    if (Number(version.split('.')[0]) < 10 || !id)
      throw new Error('Zotero 10 or newer with local writes is required');
    if (this.serverId && this.serverId !== id) {
      this.key = null;
      this.remembered = false;
    }
    this.serverId = id;
    return {
      version,
      serverId: id,
      authorized: !!this.key,
      automaticPdfWrites: !!this.key && this.remembered,
    };
  }

  async authorize() {
    const { serverId } = await this.probe();
    const response = await this.fetcher(`${ZOTERO_BASE}/local/authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Zotero-API-Version': '3',
        'Zotero-Allowed-Request': 'true',
        'Zotero-Server-ID': serverId,
      },
      body: JSON.stringify({ appName: 'Atlas' }),
      signal: AbortSignal.timeout(60000),
      redirect: 'error',
    });
    if (!response.ok)
      throw new Error(
        response.status === 403
          ? 'Zotero write permission was denied'
          : `Zotero authorization failed (${response.status})`,
      );
    const data = (await response.json()) as { key?: unknown; remember?: unknown };
    if (typeof data.key !== 'string' || !/^[A-Za-z0-9]{32}$/.test(data.key))
      throw new Error('Zotero returned an invalid authorization');
    this.key = data.key;
    this.remembered = data.remember === true;
    return { authorized: true, automaticPdfWrites: this.remembered };
  }

  async read(path: string, expectedServerId?: string) {
    const { serverId } = await this.probe();
    if (expectedServerId && expectedServerId !== serverId)
      throw new Error('Zotero profile changed; sync and review this action again');
    const response = await this.fetcher(`${ZOTERO_BASE}${path}`, {
      headers: {
        'Zotero-API-Version': '3',
        'Zotero-Allowed-Request': 'true',
        'Zotero-Server-ID': serverId,
      },
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Zotero read failed (${response.status})`);
    return response;
  }
  async readOptional(path: string, expectedServerId?: string) {
    try {
      return await this.read(path, expectedServerId);
    } catch (error) {
      if (error instanceof Error && error.message === 'Zotero read failed (404)') return null;
      throw error;
    }
  }

  async write(
    path: string,
    method: 'POST' | 'PATCH',
    body: BodyInit,
    headers: Record<string, string> = {},
    automatic = false,
    expectedServerId?: string,
  ) {
    const { serverId } = await this.probe();
    if (expectedServerId && serverId !== expectedServerId)
      throw new Error('Zotero profile changed; sync and review this action again');
    if (!this.key || (automatic && !this.remembered))
      throw new Error('Enable remembered Zotero writes in Atlas before adding PDFs');
    const response = await this.fetcher(`${ZOTERO_BASE}${path}`, {
      method,
      headers: {
        'Zotero-API-Version': '3',
        'Zotero-Allowed-Request': 'true',
        'Zotero-Server-ID': serverId,
        'Zotero-API-Key': this.key,
        ...headers,
      },
      body,
      signal: AbortSignal.timeout(60000),
      redirect: 'error',
    });
    if (!this.remembered || response.status === 401) this.key = null;
    if (!response.ok) {
      let detail = '';
      if ([412, 428].includes(response.status)) {
        const reader = response.body?.getReader();
        try {
          const first = await reader?.read();
          const message = first?.value
            ? Buffer.from(first.value).subarray(0, 2048).toString('utf8')
            : '';
          if (message.includes('Write token already used'))
            detail = ': request token was already consumed; retry the action';
          else if (message.includes('If-None-Match'))
            detail = ': the attachment already has file data';
          else if (message.includes('Server-ID'))
            detail = ': Zotero profile changed; sync before retrying';
          else if (/version|Version|If-Match/.test(message))
            detail = ': Zotero rejected the item or file version precondition';
        } finally {
          await reader?.cancel();
        }
      }
      throw new Error(
        response.status === 401
          ? 'Zotero write permission expired; authorize again in Atlas'
          : `Zotero write failed (${response.status})${detail}`,
      );
    }
    return response;
  }

  async upload(
    prefix: string,
    key: string,
    pdf: Buffer,
    filename: string,
    expectedServerId: string,
  ) {
    const md5 = createHash('md5').update(pdf).digest('hex');
    const path = `${prefix}/items/${key}/file`;
    const form = new URLSearchParams({
      md5,
      filename,
      filesize: String(pdf.length),
      mtime: String(Date.now()),
    });
    const start = await this.write(
      path,
      'POST',
      form,
      {
        'Content-Type': 'application/x-www-form-urlencoded',
        'If-None-Match': '*',
      },
      true,
      expectedServerId,
    );
    const data = (await start.json()) as {
      exists?: number;
      url?: string;
      uploadKey?: string;
      contentType?: string;
    };
    if (data.exists === 1) return;
    if (typeof data.url !== 'string' || typeof data.uploadKey !== 'string')
      throw new Error('Zotero returned an invalid upload authorization');
    const uploadUrl = new URL(data.url);
    if (
      uploadUrl.protocol !== 'http:' ||
      !['localhost', '127.0.0.1'].includes(uploadUrl.hostname) ||
      uploadUrl.port !== '23119' ||
      !uploadUrl.pathname.startsWith('/api/local/uploads/')
    )
      throw new Error('Zotero returned an unsafe upload URL');
    const sent = await this.fetcher(uploadUrl, {
      method: 'POST',
      body: new Uint8Array(pdf),
      headers: {
        'Content-Type': data.contentType || 'application/octet-stream',
        'Zotero-Allowed-Request': 'true',
      },
      signal: AbortSignal.timeout(60000),
      redirect: 'error',
    });
    if (sent.status !== 201) throw new Error(`Zotero PDF upload failed (${sent.status})`);
    await this.write(
      path,
      'POST',
      new URLSearchParams({ upload: data.uploadKey }),
      {
        'Content-Type': 'application/x-www-form-urlencoded',
        'If-None-Match': '*',
      },
      true,
      expectedServerId,
    );
  }
}
