import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalUrl,
  decodeEntities,
  detectSources,
  fetchSource,
  normalizeArxivId,
  normalizeDoi,
  parseFeed,
  publicHttpUrl,
  stripHtml,
  validateSourceInput,
  type FetchContext,
} from '../server/news-fetchers.ts';

type Route = string | { status?: number; body?: string; headers?: Record<string, string> };

/** Mock fetch keyed by exact URL or by URL prefix ending in '*'. Records every request. */
function mockFetch(routes: Record<string, Route>) {
  const calls: { url: string; headers: Record<string, string>; redirect?: string }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      redirect: init?.redirect,
    });
    const key =
      url in routes
        ? url
        : Object.keys(routes).find((k) => k.endsWith('*') && url.startsWith(k.slice(0, -1)));
    if (!key) return new Response('not found', { status: 404 });
    const route = routes[key];
    const spec = typeof route === 'string' ? { body: route } : route;
    return new Response(spec.body ?? '', {
      status: spec.status ?? 200,
      headers: spec.headers ?? {},
    });
  }) as typeof fetch;
  return { fetcher, calls };
}

const ctx = (fetcher: typeof fetch, extra: Partial<FetchContext> = {}): FetchContext => ({
  fetcher,
  contactEmail: 'me@example.org',
  openAlexKey: null,
  since: '2026-09-20T00:00:00Z',
  ...extra,
});

const ARXIV_RSS = `<?xml version='1.0' encoding='UTF-8'?>
<rss xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" version="2.0">
  <channel>
    <title>stat.ML updates on arXiv.org</title>
    <link>http://rss.arxiv.org/rss/stat.ML</link>
    <atom:link href="http://rss.arxiv.org/rss/stat.ML" rel="self" type="application/rss+xml"/>
    <item>
      <title>Robust LassoNet: Enhancing Feature Selection in Neural Networks via Robust Loss Functions</title>
      <link>https://arxiv.org/abs/2609.38263</link>
      <description>arXiv:2609.38263v1 Announce Type: new
Abstract: Feature selection in neural networks remains a challenging problem. We use Tukey&apos;s bisquare &amp; Huber losses with $\\mathcal{O}(d)$ cost.</description>
      <guid isPermaLink="false">oai:arXiv.org:2609.38263v1</guid>
      <category>stat.ML</category>
      <category>cs.LG</category>
      <pubDate>Thu, 01 Oct 2026 00:00:00 -0400</pubDate>
      <arxiv:announce_type>new</arxiv:announce_type>
      <dc:rights>http://creativecommons.org/licenses/by-nc-nd/4.0/</dc:rights>
      <dc:creator>Daniela De Canditiis, Italia De Feis and Paola Stolfi</dc:creator>
    </item>
    <item>
      <title>Spatially Localized Dependence for RankSEG</title>
      <link>https://arxiv.org/abs/2609.38930</link>
      <description>arXiv:2609.38930v1 Announce Type: cross
Abstract: In semantic segmentation, RankSEG methods directly optimize Dice/IoU scores.</description>
      <guid isPermaLink="false">oai:arXiv.org:2609.38930v1</guid>
      <pubDate>Thu, 01 Oct 2026 00:00:00 -0400</pubDate>
      <arxiv:announce_type>cross</arxiv:announce_type>
      <arxiv:DOI>10.5281/zenodo.22775063</arxiv:DOI>
      <dc:creator>Zixun Wang</dc:creator>
    </item>
    <item>
      <title>Distribution Matching for Representation Learning</title>
      <link>https://arxiv.org/abs/2502.14424</link>
      <description>arXiv:2502.14424v5 Announce Type: replace
Abstract: Revised.</description>
      <guid isPermaLink="false">oai:arXiv.org:2502.14424v5</guid>
      <arxiv:announce_type>replace</arxiv:announce_type>
      <dc:creator>A. Person</dc:creator>
    </item>
    <item>
      <title>A replaced cross-list</title>
      <link>https://arxiv.org/abs/2401.00001</link>
      <description>arXiv:2401.00001v3 Announce Type: replace-cross
Abstract: Revised.</description>
      <guid isPermaLink="false">oai:arXiv.org:2401.00001v3</guid>
      <arxiv:announce_type>replace-cross</arxiv:announce_type>
    </item>
    <item>
      <title>Robust LassoNet (duplicate listing)</title>
      <link>https://arxiv.org/abs/2609.38263</link>
      <description>arXiv:2609.38263v1 Announce Type: cross
Abstract: Same paper listed again.</description>
      <guid isPermaLink="false">oai:arXiv.org:2609.38263v1</guid>
      <arxiv:announce_type>cross</arxiv:announce_type>
    </item>
  </channel>
</rss>`;

const BLOG_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE rss [ <!ENTITY custom "x"> ]>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title><![CDATA[Lab Blog & Notes]]></title>
  <link>https://blog.example.org/</link>
  <atom:link href="https://blog.example.org/feed" rel="self" type="application/rss+xml" />
  <!-- a comment with <item> inside should be ignored -->
  <item>
    <title>Diffusion models &#8211; a &quot;gentle&quot; intro &#x1F600;</title>
    <link>https://blog.example.org/posts/diffusion/?utm_source=rss</link>
    <atom:link href="https://blog.example.org/posts/diffusion/amp" rel="amphtml"/>
    <dc:creator><![CDATA[Ada Lovelace]]></dc:creator>
    <pubDate>Mon, 28 Sep 2026 10:00:00 GMT</pubDate>
    <guid isPermaLink="false">post-123</guid>
    <description><![CDATA[<p>Short <b>teaser</b> with <a href="https://x.org">a link</a>.</p><script>alert(1)</script>]]></description>
    <content:encoded><![CDATA[<p>Full text</p>]]></content:encoded>
  </item>
  <item>
    <title>Our paper at NeurIPS</title>
    <link>https://doi.org/10.1234/ABC.5678</link>
    <author>lab@example.org (Grace Hopper)</author>
    <pubDate>Tue, 29 Sep 2026 10:00:00 GMT</pubDate>
    <description>&lt;p&gt;Escaped &amp;amp; HTML&lt;/p&gt;</description>
  </item>
  <item>
    <title>Old post</title>
    <link>https://blog.example.org/posts/old</link>
    <pubDate>Mon, 01 Jun 2026 10:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Untitled guid link</title>
    <guid>https://blog.example.org/posts/guid-only</guid>
  </item>
  <item>
    <description>No title, skipped</description>
    <link>https://blog.example.org/posts/none</link>
  </item>
</channel>
</rss>`;

const GITHUB_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xml:lang="en-US">
  <id>tag:github.com,2008:https://github.com/nodejs/node/releases</id>
  <link type="text/html" rel="alternate" href="https://github.com/nodejs/node/releases"/>
  <link type="application/atom+xml" rel="self" href="https://github.com/nodejs/node/releases.atom"/>
  <title>Release notes from node</title>
  <entry>
    <id>tag:github.com,2008:Repository/27193779/v22.23.3</id>
    <updated>2026-09-23T18:21:37Z</updated>
    <link rel="alternate" type="text/html" href="/nodejs/node/releases/tag/v22.23.3"/>
    <title>2026-09-23, Version 22.23.3 &#39;Jod&#39; (LTS), @aduh95</title>
    <content type="html">&lt;h3&gt;Notable Changes&lt;/h3&gt;
&lt;ul&gt;
&lt;li&gt;&lt;strong&gt;crypto&lt;/strong&gt;: update root certificates to NSS 3.125 &lt;a href=&quot;https://github.com/nodejs/node/pull/64746&quot;&gt;#64746&lt;/a&gt;&lt;/li&gt;
&lt;/ul&gt;${'&lt;p&gt;more notes&lt;/p&gt;'.repeat(800)}</content>
    <author><name>aduh95</name></author>
    <media:thumbnail height="30" width="30" url="https://avatars.githubusercontent.com/u/14309773?s=60&amp;v=4"/>
  </entry>
</feed>`;

const JOURNAL_ATOM = `<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="text">Journal of Examples</title>
  <entry>
    <title type="html">&lt;i&gt;In situ&lt;/i&gt; learning</title>
    <link href="https://journal.example.com/article/10.5555/xyz-1"/>
    <id>urn:uuid:1</id>
    <published>2026-09-25T00:00:00Z</published>
    <summary type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">We <em>study</em> things.</div></summary>
    <author><name>Jane Roe</name></author><author><name>John Doe</name></author>
  </entry>
</feed>`;

const OPENALEX_WORKS = JSON.stringify({
  meta: { count: 2 },
  results: [
    {
      id: 'https://openalex.org/W7163719649',
      doi: 'https://doi.org/10.15120/GSI-2026-00822',
      display_name: 'Spin dynamics in <i>H<sub>2</sub>O</i> ice',
      publication_date: '2026-09-26',
      ids: {
        openalex: 'https://openalex.org/W7163719649',
        doi: 'https://doi.org/10.15120/gsi-2026-00822',
      },
      type: 'preprint',
      primary_location: {
        id: 'pmh:oai:arXiv.org:2606.04242',
        landing_page_url: 'https://arxiv.org/abs/2606.04242',
        pdf_url: 'https://arxiv.org/pdf/2606.04242',
        source: {
          id: 'https://openalex.org/S4306400194',
          display_name: 'arXiv (Cornell University)',
        },
      },
      locations: [{ landing_page_url: 'https://doi.org/10.15120/gsi-2026-00822', source: null }],
      authorships: [
        { author: { id: 'https://openalex.org/A1', display_name: 'Raminta Pranckutė' } },
        { author: { id: null, display_name: null }, raw_author_name: 'B. Raw' },
      ],
      abstract_inverted_index: { The: [0, 4], spin: [1], dynamics: [2], of: [3], ice: [5] },
      referenced_works: ['https://openalex.org/W1', 'https://openalex.org/W22'],
    },
    {
      id: 'https://openalex.org/W99',
      doi: null,
      title: 'A benchmark dataset',
      publication_date: '2026-09-27',
      ids: { openalex: 'https://openalex.org/W99' },
      type: 'dataset',
      primary_location: null,
      locations: [],
      authorships: [],
      abstract_inverted_index: null,
      referenced_works: [],
    },
    { id: 'https://openalex.org/W100', display_name: null },
  ],
});

test('normalizes DOIs and arXiv identifiers', () => {
  assert.equal(normalizeDoi('https://doi.org/10.1234/ABC.5678.'), '10.1234/abc.5678');
  assert.equal(normalizeDoi('doi:10.1000/xyz(1)'), '10.1000/xyz(1');
  assert.equal(normalizeDoi('https://dx.doi.org/10.1000%2Fa%20b'), null);
  assert.equal(normalizeDoi('https://dx.doi.org/10.1000%2Fab'), '10.1000/ab');
  assert.equal(normalizeDoi('not a doi'), null);
  assert.equal(normalizeArxivId('arXiv:2409.01234v2'), '2409.01234');
  assert.equal(normalizeArxivId('https://arxiv.org/abs/2409.01234v3'), '2409.01234');
  assert.equal(normalizeArxivId('https://arxiv.org/pdf/2409.01234v1.pdf'), '2409.01234');
  assert.equal(normalizeArxivId('oai:arXiv.org:2609.38263v1'), '2609.38263');
  assert.equal(normalizeArxivId('10.48550/arXiv.2409.01234'), '2409.01234');
  assert.equal(normalizeArxivId('math.GT/0309136v1'), 'math/0309136');
  assert.equal(normalizeArxivId('hep-th/9901001'), 'hep-th/9901001');
  assert.equal(normalizeArxivId('0704.0001'), '0704.0001');
  assert.equal(normalizeArxivId('2413.01234'), null);
  assert.equal(normalizeArxivId('stat.ML'), null);
});

test('canonicalizes URLs', () => {
  assert.equal(
    canonicalUrl('https://WWW.Example.org/posts/a/?utm_source=rss&id=3&utm_medium=x#top'),
    'https://example.org/posts/a?id=3',
  );
  assert.equal(canonicalUrl('https://example.org/'), 'https://example.org');
  assert.equal(canonicalUrl('http://example.org:8080/a//'), 'http://example.org:8080/a');
  assert.equal(canonicalUrl('not a url '), 'not a url');
});

test('decodes entities and strips HTML to bounded plain text', () => {
  assert.equal(
    decodeEntities('a &amp; b &lt;c&gt; &#8211; &#x2014; &eacute; &bogus; &#0;'),
    'a & b <c> – — é &bogus; ',
  );
  assert.equal(
    stripHtml('<p>One&nbsp;<b>two</b></p><script>bad()</script><ul><li>three</li></ul>'),
    'One two\n\n• three',
  );
  assert.equal(stripHtml('&lt;p&gt;Escaped &amp;amp; HTML&lt;/p&gt;'), 'Escaped & HTML');
  const long = stripHtml('word '.repeat(3000));
  assert.ok(long.length <= 5000 && long.endsWith('…'));
});

test('public URL checks reject local and private targets', () => {
  for (const url of [
    'http://localhost/feed',
    'https://127.0.0.1/feed',
    'https://[::1]/feed',
    'https://user:pw@example.org/feed',
    'ftp://example.org/feed',
    'https://printer.local/feed',
    'https://intranet/feed',
    'https://example.org:8443/feed',
  ])
    assert.throws(() => publicHttpUrl(url), /public http/, url);
  assert.equal(publicHttpUrl('http://example.org/feed').host, 'example.org');
});

test('fetches arXiv announcements, skipping replacements and duplicates', async () => {
  const { fetcher, calls } = mockFetch({ 'https://rss.arxiv.org/rss/stat.ML+cs.LG': ARXIV_RSS });
  const items = await fetchSource({ kind: 'arxiv', value: 'stat.ML+cs.LG' }, ctx(fetcher));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['User-Agent'], 'Atlas/0.1 (+mailto:me@example.org)');
  assert.equal(calls[0].redirect, 'manual');
  assert.deepEqual(
    items.map((i) => i.arxivId),
    ['2609.38263', '2609.38930'],
  );
  const [first, second] = items;
  assert.equal(first.kind, 'paper');
  assert.equal(first.url, 'https://arxiv.org/abs/2609.38263');
  assert.deepEqual(first.authors, ['Daniela De Canditiis', 'Italia De Feis', 'Paola Stolfi']);
  assert.match(first.abstract, /^Feature selection in neural networks/);
  assert.match(
    first.abstract,
    /Tukey's bisquare & Huber losses with \$\\mathcal\{O\}\(d\)\$ cost\./,
  );
  assert.equal(first.publishedAt, '2026-10-01T04:00:00.000Z');
  assert.equal(first.venue, 'arXiv');
  assert.equal(first.doi, null);
  assert.equal(second.doi, '10.5281/zenodo.22775063');
  await assert.rejects(
    fetchSource({ kind: 'arxiv', value: 'stat.XX' }, ctx(fetcher)),
    /Unknown arXiv category/,
  );
});

test('parses RSS 2.0 with CDATA, entities, namespaces and missing fields', async () => {
  const { fetcher } = mockFetch({
    'https://blog.example.org/feed': {
      body: BLOG_RSS,
      headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
    },
  });
  const items = await fetchSource(
    { kind: 'rss', value: 'https://blog.example.org/feed' },
    ctx(fetcher),
  );
  assert.deepEqual(
    items.map((i) => i.title),
    ['Diffusion models – a "gentle" intro 😀', 'Our paper at NeurIPS', 'Untitled guid link'],
  );
  const [post, paper, undated] = items;
  assert.equal(post.kind, 'post');
  assert.equal(post.url, 'https://blog.example.org/posts/diffusion/?utm_source=rss');
  assert.deepEqual(post.authors, ['Ada Lovelace']);
  assert.equal(post.abstract, 'Short teaser with a link.');
  assert.equal(post.venue, 'Lab Blog & Notes');
  assert.equal(post.publishedAt, '2026-09-28T10:00:00.000Z');
  assert.equal(paper.kind, 'paper');
  assert.equal(paper.doi, '10.1234/abc.5678');
  assert.deepEqual(paper.authors, ['Grace Hopper']);
  assert.equal(paper.abstract, 'Escaped & HTML');
  assert.equal(undated.url, 'https://blog.example.org/posts/guid-only');
  assert.equal(undated.publishedAt, null);
  assert.equal(undated.abstract, '');
});

test('parses Atom feeds: GitHub releases and journal entries', async () => {
  const { fetcher } = mockFetch({
    'https://github.com/nodejs/node/releases.atom': GITHUB_ATOM,
    'https://journal.example.com/feed.atom': JOURNAL_ATOM,
  });
  const [release] = await fetchSource(
    { kind: 'rss', value: 'https://github.com/nodejs/node/releases.atom' },
    ctx(fetcher),
  );
  assert.equal(release.kind, 'release');
  assert.equal(release.title, "2026-09-23, Version 22.23.3 'Jod' (LTS), @aduh95");
  assert.equal(release.url, 'https://github.com/nodejs/node/releases/tag/v22.23.3');
  assert.deepEqual(release.authors, ['aduh95']);
  assert.match(
    release.abstract,
    /^Notable Changes\n\n• crypto: update root certificates to NSS 3\.125 #64746\n\nmore notes/,
  );
  assert.ok(release.abstract.length <= 5000);
  assert.equal(release.publishedAt, '2026-09-23T18:21:37.000Z');

  const [article] = await fetchSource(
    { kind: 'rss', value: 'https://journal.example.com/feed.atom' },
    ctx(fetcher),
  );
  assert.equal(article.title, 'In situ learning');
  assert.equal(article.kind, 'paper');
  assert.equal(article.doi, '10.5555/xyz-1');
  assert.equal(article.abstract, 'We study things.');
  assert.deepEqual(article.authors, ['Jane Roe', 'John Doe']);
  assert.equal(article.venue, 'Journal of Examples');
});

test('parses RSS 1.0 (RDF) feeds', () => {
  const feed = parseFeed(
    `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/">
      <channel rdf:about="https://j.example.com"><title>J</title><items><rdf:Seq><rdf:li rdf:resource="https://j.example.com/a"/></rdf:Seq></items></channel>
      <item rdf:about="https://j.example.com/a"><title>Article A</title><link>https://j.example.com/a</link>
        <dc:date>2026-09-30</dc:date><prism:doi>10.9999/a.1</prism:doi><prism:publicationName>Journal J</prism:publicationName></item>
    </rdf:RDF>`,
    'https://j.example.com/rss',
  );
  assert.equal(feed.entries.length, 1);
  assert.equal(feed.entries[0].doi, '10.9999/a.1');
  assert.equal(feed.entries[0].venue, 'Journal J');
  assert.equal(feed.entries[0].publishedAt, '2026-09-30T00:00:00.000Z');
  assert.throws(() => parseFeed('<html><body>hi</body></html>', 'https://x.org'), /Not an RSS/);
});

test('follows public redirects, rejects private ones, and caps feed size', async () => {
  const { fetcher, calls } = mockFetch({
    'https://old.example.org/feed': {
      status: 301,
      headers: { location: 'https://new.example.org/feed' },
    },
    'https://new.example.org/feed': JOURNAL_ATOM,
    'https://evil.example.org/feed': {
      status: 302,
      headers: { location: 'http://127.0.0.1/admin' },
    },
    'https://big.example.org/feed': { body: '<rss>' + 'x'.repeat(5 * 1024 * 1024 + 10) },
    'https://html.example.org/feed': '<html><body>Not a feed</body></html>',
  });
  const items = await fetchSource(
    { kind: 'rss', value: 'https://old.example.org/feed' },
    ctx(fetcher),
  );
  assert.equal(items.length, 1);
  assert.deepEqual(
    calls.map((c) => c.url),
    ['https://old.example.org/feed', 'https://new.example.org/feed'],
  );
  await assert.rejects(
    fetchSource({ kind: 'rss', value: 'https://evil.example.org/feed' }, ctx(fetcher)),
    /public http/,
  );
  await assert.rejects(
    fetchSource({ kind: 'rss', value: 'https://big.example.org/feed' }, ctx(fetcher)),
    /too large/,
  );
  await assert.rejects(
    fetchSource({ kind: 'rss', value: 'https://html.example.org/feed' }, ctx(fetcher)),
    /did not return an RSS or Atom feed/,
  );
  await assert.rejects(
    fetchSource({ kind: 'rss', value: 'https://missing.example.org/feed' }, ctx(fetcher)),
    /HTTP 404/,
  );
});

test('fetches OpenAlex works for authors, citations and queries', async () => {
  const { fetcher, calls } = mockFetch({ 'https://api.openalex.org/works?*': OPENALEX_WORKS });
  const items = await fetchSource(
    { kind: 'openalex_author', value: 'https://openalex.org/A5023888391' },
    ctx(fetcher, { openAlexKey: 'secret' }),
  );
  const url = new URL(calls[0].url);
  assert.equal(
    url.searchParams.get('filter'),
    `authorships.author.id:A5023888391,from_publication_date:2026-09-20,to_publication_date:${new Date().toISOString().slice(0, 10)}`,
  );
  assert.equal(url.searchParams.get('sort'), 'publication_date:desc');
  assert.equal(url.searchParams.get('per-page'), '50');
  assert.equal(url.searchParams.get('api_key'), 'secret');
  assert.equal(url.searchParams.get('mailto'), 'me@example.org');
  assert.equal(items.length, 2);
  const [paper, dataset] = items;
  assert.equal(paper.title, 'Spin dynamics in H2O ice');
  assert.equal(paper.abstract, 'The spin dynamics of The ice');
  assert.equal(paper.doi, '10.15120/gsi-2026-00822');
  assert.equal(paper.arxivId, '2606.04242');
  assert.equal(paper.openAlexId, 'W7163719649');
  assert.deepEqual(paper.referencedWorks, ['W1', 'W22']);
  assert.deepEqual(paper.authors, ['Raminta Pranckutė', 'B. Raw']);
  assert.equal(paper.venue, 'arXiv (Cornell University)');
  assert.equal(paper.url, 'https://arxiv.org/abs/2606.04242');
  assert.equal(paper.publishedAt, '2026-09-26T00:00:00.000Z');
  assert.equal(dataset.kind, 'dataset');
  assert.equal(dataset.url, 'https://openalex.org/W99');

  await fetchSource(
    { kind: 'openalex_cites', value: 'W2741809807' },
    ctx(fetcher, { contactEmail: '' }),
  );
  const cites = new URL(calls[1].url);
  assert.match(cites.searchParams.get('filter')!, /^cites:W2741809807,from_publication_date:/);
  assert.equal(cites.searchParams.get('mailto'), null);
  assert.equal(cites.searchParams.get('api_key'), null);
  assert.equal(calls[1].headers['User-Agent'], 'Atlas/0.1');

  await fetchSource(
    { kind: 'openalex_query', value: 'neural operators, PDEs: fast|cheap' },
    ctx(fetcher, { since: null }),
  );
  const query = new URL(calls[2].url).searchParams.get('filter')!;
  assert.match(
    query,
    /^title_and_abstract\.search:neural operators PDEs fast cheap,from_publication_date:\d{4}-\d{2}-\d{2},to_publication_date:\d{4}-\d{2}-\d{2}$/,
  );
  const windowStart = new Date(query.split('from_publication_date:')[1].split(',')[0]).getTime();
  assert.ok(Math.abs(Date.now() - 7 * 86400000 - windowStart) < 2 * 86400000);
});

test('explains OpenAlex key requirements and errors', async () => {
  const { fetcher } = mockFetch({
    'https://api.openalex.org/works?*': {
      status: 429,
      body: JSON.stringify({ error: 'Rate limited', message: 'Too many requests' }),
    },
  });
  await assert.rejects(fetchSource({ kind: 'openalex_query', value: 'x' }, ctx(fetcher)), {
    message: 'OpenAlex needs a free API key — add it in News → Sources → Settings',
  });
  await assert.rejects(
    fetchSource({ kind: 'openalex_query', value: 'x' }, ctx(fetcher, { openAlexKey: 'k' })),
    /OpenAlex returned HTTP 429: Too many requests/,
  );
  await assert.rejects(
    fetchSource({ kind: 'openalex_author', value: 'bob' }, ctx(fetcher)),
    /author ID/,
  );
});

test('validates and normalizes source input', () => {
  assert.deepEqual(validateSourceInput({ kind: 'arxiv', value: ' stat.ml + CS.LG stat.ML' }), {
    kind: 'arxiv',
    value: 'stat.ML+cs.LG',
    label: 'arXiv stat.ML + cs.LG',
  });
  assert.equal(
    validateSourceInput({ kind: 'arxiv', value: 'https://arxiv.org/list/physics.flu-dyn/new' })
      .value,
    'physics.flu-dyn',
  );
  assert.throws(() => validateSourceInput({ kind: 'arxiv', value: 'stat.XX' }), /Unknown arXiv/);
  assert.deepEqual(
    validateSourceInput({ kind: 'rss', value: 'blog.example.org/feed#x', label: '  My   blog ' }),
    {
      kind: 'rss',
      value: 'https://blog.example.org/feed',
      label: 'My blog',
    },
  );
  assert.throws(
    () => validateSourceInput({ kind: 'rss', value: 'http://localhost:3000/feed' }),
    /public/,
  );
  assert.deepEqual(
    validateSourceInput({
      kind: 'openalex_author',
      value: 'https://openalex.org/authors/a5023888391',
    }),
    {
      kind: 'openalex_author',
      value: 'A5023888391',
      label: 'Author A5023888391',
    },
  );
  assert.equal(
    validateSourceInput({ kind: 'openalex_cites', value: 'https://openalex.org/W2741809807' })
      .value,
    'W2741809807',
  );
  assert.throws(
    () => validateSourceInput({ kind: 'openalex_cites', value: 'A5023888391' }),
    /work ID/,
  );
  assert.deepEqual(
    validateSourceInput({ kind: 'openalex_query', value: '  neural   operators ' }),
    {
      kind: 'openalex_query',
      value: 'neural operators',
      label: 'neural operators',
    },
  );
  assert.throws(() => validateSourceInput({ kind: 'openalex_query', value: '   ' }), /required/);
  assert.throws(
    () => validateSourceInput({ kind: 'bogus' as never, value: 'x' }),
    /Unknown source kind/,
  );
});

test('detects arXiv categories, listing URLs and GitHub repositories without fetching', async () => {
  const { fetcher, calls } = mockFetch({});
  const c = ctx(fetcher);
  const [arxiv] = await detectSources('stat.ml', c);
  assert.deepEqual(arxiv, {
    id: null,
    kind: 'arxiv',
    value: 'stat.ML',
    label: 'arXiv stat.ML',
    reason: 'New arXiv announcements in stat.ML (Machine Learning)',
    origin: 'detected',
    createdAt: null,
  });
  assert.equal(
    (await detectSources('stat.ML+physics.flu-dyn', c))[0].value,
    'stat.ML+physics.flu-dyn',
  );
  const archive = await detectSources('math', c);
  assert.deepEqual(
    archive.map((s) => s.kind),
    ['arxiv', 'openalex_query'],
  );
  assert.equal((await detectSources('https://arxiv.org/list/cs.LG/recent', c))[0].value, 'cs.LG');
  const [repo] = await detectSources('https://github.com/pytorch/pytorch/tree/main', c);
  assert.equal(repo.kind, 'rss');
  assert.equal(repo.value, 'https://github.com/pytorch/pytorch/releases.atom');
  assert.equal(repo.label, 'pytorch/pytorch releases');
  assert.equal(calls.length, 0);
  await assert.rejects(detectSources('http://192.168.1.1/feed', c), /public http/);
  await assert.rejects(detectSources('   ', c), /Enter/);
});

test('detects OpenAlex IDs and DOIs with labels, tolerating lookup failures', async () => {
  const { fetcher } = mockFetch({
    'https://api.openalex.org/authors/A5023888391?*': JSON.stringify({
      id: 'https://openalex.org/A5023888391',
      display_name: 'Jason R Priem',
    }),
    'https://api.openalex.org/works/W2741809807?*': JSON.stringify({
      id: 'https://openalex.org/W2741809807',
      display_name: 'The state of OA',
    }),
    'https://api.openalex.org/works/doi:10.1038/nature12373?*': JSON.stringify({
      id: 'https://openalex.org/W2000000001',
      display_name: 'Nanometre-scale thermometry',
    }),
  });
  const c = ctx(fetcher);
  const [author] = await detectSources('https://openalex.org/A5023888391', c);
  assert.equal(author.kind, 'openalex_author');
  assert.equal(author.label, 'Jason R Priem');
  const [work] = await detectSources('W2741809807', c);
  assert.equal(work.kind, 'openalex_cites');
  assert.equal(work.label, 'Citing: The state of OA');
  const [unknown] = await detectSources('A123456789', c);
  assert.equal(unknown.label, 'Author A123456789');
  const [doi] = await detectSources('https://doi.org/10.1038/nature12373', c);
  assert.equal(doi.kind, 'openalex_cites');
  assert.equal(doi.value, 'W2000000001');
});

test('detects feeds directly or through HTML autodiscovery', async () => {
  const { fetcher } = mockFetch({
    'https://blog.example.org/feed': BLOG_RSS,
    'https://blog.example.org/': `<!doctype html><html><head><title>Lab &amp; Co</title>
      <link rel="stylesheet" href="/s.css">
      <link rel="alternate" type="application/rss+xml" title="Lab posts" href="/feed">
      <link rel="alternate" type="application/atom+xml" href="https://blog.example.org/atom.xml">
      <link rel="alternate" type="application/rss+xml" href="http://localhost/feed">
      </head><body></body></html>`,
    'https://nofeed.example.org/': '<html><head><title>Nothing</title></head></html>',
    'https://plain.example.org/': '<html><head><title>Plain</title></head></html>',
    'https://plain.example.org/rss.xml': JOURNAL_ATOM,
  });
  const c = ctx(fetcher);
  const [direct] = await detectSources('https://blog.example.org/feed', c);
  assert.equal(direct.label, 'Lab Blog & Notes');
  assert.match(direct.reason, /RSS feed with 5 recent entries/);
  const found = await detectSources('blog.example.org', c);
  assert.deepEqual(
    found.map((s) => [s.value, s.label]),
    [
      ['https://blog.example.org/feed', 'Lab posts'],
      ['https://blog.example.org/atom.xml', 'Lab & Co'],
    ],
  );
  const [probed] = await detectSources('https://plain.example.org/', c);
  assert.equal(probed.value, 'https://plain.example.org/rss.xml');
  await assert.rejects(detectSources('https://nofeed.example.org/', c), /No RSS or Atom feed/);
});

test('detects keywords and person names', async () => {
  const { fetcher, calls } = mockFetch({
    'https://api.openalex.org/authors?*': JSON.stringify({
      results: [
        {
          id: 'https://openalex.org/A5001226970',
          display_name: 'Yann LeCun',
          works_count: 477,
          last_known_institutions: [{ display_name: 'Courant Institute of Mathematical Sciences' }],
        },
        {
          id: 'https://openalex.org/A5111982145',
          display_name: 'Yann A. Le Cun',
          works_count: 48,
          last_known_institutions: null,
          affiliations: [{ institution: { display_name: 'NEC (Japan)' } }],
        },
      ],
    }),
  });
  const c = ctx(fetcher);
  const keywords = await detectSources('physics-informed neural networks', c);
  assert.deepEqual(
    keywords.map((s) => [s.kind, s.value]),
    [['openalex_query', 'physics-informed neural networks']],
  );
  assert.equal(calls.length, 0);
  const people = await detectSources('Yann LeCun', c);
  assert.deepEqual(
    people.map((s) => [s.kind, s.value, s.reason]),
    [
      ['openalex_query', 'Yann LeCun', 'New works mentioning “Yann LeCun”'],
      ['openalex_author', 'A5001226970', 'Courant Institute of Mathematical Sciences · 477 works'],
      ['openalex_author', 'A5111982145', 'NEC (Japan) · 48 works'],
    ],
  );
  assert.equal(new URL(calls[0].url).searchParams.get('search'), 'Yann LeCun');
});
