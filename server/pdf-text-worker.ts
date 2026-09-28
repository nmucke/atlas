import { parentPort, workerData } from 'node:worker_threads';
import { readFile, stat } from 'node:fs/promises';
// Parser warnings must never corrupt MCP stdio frames.
console.log = console.warn = (...args: unknown[]) => console.error(...args);
try {
  const info = await stat(workerData.filename);
  if (!info.isFile() || info.size > 40 * 1024 * 1024)
    throw new Error('PDF exceeds the 40 MiB indexing limit');
  const bytes = await readFile(workerData.filename);
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-')))
    throw new Error('Invalid PDF signature');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const pdf = await task.promise;
  if (pdf.numPages > 400) {
    await task.destroy();
    throw new Error('PDF exceeds the 400-page indexing limit');
  }
  const pages: string[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
      .join('');
    if (text.length > 60000) throw new Error(`Page ${n} exceeds the text extraction limit`);
    pages.push(text);
    page.cleanup();
  }
  await task.destroy();
  parentPort!.postMessage({ pages });
} catch (error) {
  parentPort!.postMessage({
    error: error instanceof Error ? error.message : 'PDF extraction failed',
  });
}
