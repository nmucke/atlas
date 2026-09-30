import { publicHttpsUrl } from './zotero-write.ts';

// OpenAlex may prefer a landing-page-only location over a repository PDF.
export function pdfLocation(work: { best_oa_location?: unknown; locations?: unknown }) {
  const locations = [
    work.best_oa_location,
    ...(Array.isArray(work.locations) ? work.locations : []),
  ];
  for (const value of locations) {
    if (!value || typeof value !== 'object') continue;
    const location = value as Record<string, unknown>;
    if (location.is_oa !== true || typeof location.pdf_url !== 'string') continue;
    try {
      const url = new URL(location.pdf_url);
      // Require encrypted downloads even when metadata contains an old HTTP link.
      if (url.protocol === 'http:') url.protocol = 'https:';
      const pdfUrl = publicHttpsUrl(url.href).href;
      let sourceUrl = pdfUrl;
      if (typeof location.landing_page_url === 'string') {
        try {
          sourceUrl = publicHttpsUrl(location.landing_page_url).href;
        } catch {
          /* Keep PDF source. */
        }
      }
      return {
        pdfUrl,
        sourceUrl,
        license: typeof location.license === 'string' ? location.license.slice(0, 100) : null,
        version: typeof location.version === 'string' ? location.version.slice(0, 100) : null,
      };
    } catch {
      /* An invalid preferred link must not mask valid repository alternatives. */
    }
  }
  return null;
}
