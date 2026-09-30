import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractPdf } from './retrieval.ts';

const compact = (text: string) =>
  text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
export function verifyPdfIdentity(
  pages: string[],
  paper: { title: string; doi: string; author: string },
) {
  const front = pages.slice(0, 2).join('\n');
  const title = compact(paper.title);
  if (title.length < 15 || !compact(front).includes(title))
    throw new Error(
      'PDF title could not be verified against this paper in its opening pages. No attachment was created.',
    );
  const doi = paper.doi
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
  if (doi) {
    if (!front.toLowerCase().replace(/\s+/g, '').includes(doi.replace(/\s+/g, '')))
      throw new Error(
        'PDF DOI could not be verified against this paper in its opening pages. No attachment was created.',
      );
  } else if (compact(paper.author).length < 3 || !compact(front).includes(compact(paper.author))) {
    throw new Error(
      'Paper has no DOI and the PDF author could not be verified. No attachment was created.',
    );
  }
}
export async function extractCandidatePdf(pdf: Buffer) {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-verify-pdf-'));
  try {
    const path = join(directory, 'candidate.pdf');
    await writeFile(path, pdf, { mode: 0o600 });
    return await extractPdf(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
