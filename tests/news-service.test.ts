import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtlasDatabase, type Snapshot } from '../server/database.ts';
import { ProjectStore } from '../server/projects.ts';
import { AssistantStore } from '../server/assistant-store.ts';
import { Retrieval } from '../server/retrieval.ts';
import { NewsService, type NewsServiceOptions } from '../server/news-service.ts';
import type { NewsSource, RawNewsItem } from '../shared/news.ts';

const now = new Date('2026-10-01T12:00:00.000Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * 86400000).toISOString();

function raw(partial: Partial<RawNewsItem> & { title: string }): RawNewsItem {
  return {
    kind: 'paper',
    authors: ['Ada Lovelace'],
    abstract: '',
    url: `https://example.org/${encodeURIComponent(partial.title)}`,
    venue: null,
    publishedAt: daysAgo(1),
    doi: null,
    arxivId: null,
    openAlexId: null,
    referencedWorks: [],
    ...partial,
  };
}

function fixture(options: NewsServiceOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-news-'));
  const db = new AtlasDatabase(join(dir, 'atlas.sqlite'));
  const snapshot: Snapshot = {
    id: 'lib',
    name: 'Library',
    prefix: '/users/0',
    serverId: null,
    collections: [],
    items: [
      {
        key: 'DOIPAPER',
        data: {
          itemType: 'journalArticle',
          title: 'Library paper with a DOI',
          DOI: 'https://doi.org/10.1000/LIB.1',
          creators: [],
          tags: [],
          collections: [],
        },
      },
      {
        key: 'ARXPAPER',
        data: {
          itemType: 'preprint',
          title: 'Library preprint',
          extra: 'arXiv: 2401.00001v2',
          creators: [],
          tags: [],
          collections: [],
        },
      },
    ],
  };
  db.applySnapshots([snapshot]);
  const projects = new ProjectStore(db.db);
  const project = projects.create({ name: 'Ocean climate', summary: 'Climate calibration' });
  const assistant = new AssistantStore(db.db);
  assistant.setProfile('I study climate model calibration and ocean turbulence.');
  const retrieval = new Retrieval(db, projects, assistant);
  const news = new NewsService(db, projects, retrieval, { now: () => now, ...options });
  return {
    db,
    projects,
    project,
    retrieval,
    news,
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Serves fixed items per source value; a missing entry throws like a failing feed.
function stubFetch(bySource: Record<string, RawNewsItem[]>, calls: string[] = []) {
  return async (source: Pick<NewsSource, 'kind' | 'value'>, ctx: { since: string | null }) => {
    calls.push(`${source.kind}:${source.value}:${ctx.since}`);
    const items = bySource[source.value];
    if (!items) throw new Error('Feed unavailable');
    return items;
  };
}

const arxivFeed = [
  raw({
    title: 'Calibrating climate models with ocean turbulence data',
    abstract: 'We calibrate climate models using ocean turbulence observations.',
    arxivId: '2409.01234v2',
    url: 'https://arxiv.org/abs/2409.01234v2',
  }),
  raw({
    title: 'A survey of medieval poetry metres',
    abstract: 'Poetry, metres and rhyme in medieval manuscripts.',
    arxivId: '2409.05555',
    url: 'https://arxiv.org/abs/2409.05555',
    publishedAt: daysAgo(1),
  }),
  raw({
    title: 'Already in the library',
    arxivId: '2401.00001',
    url: 'https://arxiv.org/abs/2401.00001',
  }),
];
const openAlexFeed = [
  raw({
    title: 'Calibrating climate models with ocean turbulence data',
    doi: '10.48550/arXiv.2409.01234',
    openAlexId: 'https://openalex.org/W100',
    venue: 'arXiv (Cornell University)',
    url: 'https://doi.org/10.48550/arxiv.2409.01234',
  }),
  raw({ title: 'Journal copy of a library paper', doi: '10.1000/lib.1', openAlexId: 'W200' }),
];

test('migration v8 creates News tables idempotently', () => {
  const f = fixture({ fetchSource: stubFetch({}) });
  try {
    assert.ok(f.db.db.prepare('SELECT 1 FROM schema_migrations WHERE version=8').get());
    const tables = (
      f.db.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'news_%'").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    for (const name of [
      'news_sources',
      'news_source_suggestions',
      'news_items',
      'news_identifiers',
      'news_item_sources',
      'news_triage',
      'news_feedback',
      'news_runs',
      'news_fts',
    ])
      assert.ok(tables.includes(name), name);
    new NewsService(f.db, f.projects, f.retrieval);
    assert.deepEqual(f.news.sources(), []);
  } finally {
    f.cleanup();
  }
});

test('sources are added once, patched, and removed without deleting found items', async () => {
  const f = fixture({ fetchSource: stubFetch({ 'stat.ML': arxivFeed }) });
  try {
    const source = f.news.addSource({ kind: 'arxiv', value: 'stat.ML' });
    assert.equal(source.enabled, true);
    assert.equal(f.news.addSource({ kind: 'arxiv', value: 'stat.ML' }).id, source.id);
    assert.equal(f.news.sources().length, 1);
    assert.throws(() => f.news.addSource({ kind: 'bogus' as any, value: 'x' }), /kind/);
    assert.throws(() => f.news.patchSource(source.id, { label: '' }), /label/);
    assert.throws(() => f.news.patchSource(source.id, { enabled: 'no' as any }), /boolean/);
    assert.throws(() => f.news.patchSource(source.id, { color: 'red' } as any), /Unknown/);
    const patched = f.news.patchSource(source.id, { label: 'Stats ML', enabled: false })!;
    assert.equal(patched.label, 'Stats ML');
    assert.equal(patched.enabled, false);
    assert.equal(f.news.patchSource('missing', { enabled: true }), null);
    f.news.patchSource(source.id, { enabled: true });
    await f.news.collect();
    assert.equal(f.news.sources()[0].itemCount, 3);
    assert.equal(f.news.removeSource(source.id), true);
    assert.equal(f.news.removeSource(source.id), false);
    const all = f.news.list({ state: 'all' });
    assert.equal(all.items.length, 3);
    assert.equal(f.news.sources().length, 0);
    assert.ok(all.items.every((item) => item.sources[0]?.id === source.id));
    // Undo re-adds the same source, keeping its id and the items it found.
    const restored = f.news.addSource({ kind: 'arxiv', value: 'stat.ML' });
    assert.equal(restored.id, source.id);
    assert.equal(restored.itemCount, 3);
    assert.equal(restored.enabled, true);
  } finally {
    f.cleanup();
  }
});

test('collection is single-flight, dedupes by identity, matches the library and records errors', async () => {
  const calls: string[] = [];
  const f = fixture({
    fetchSource: stubFetch({ 'stat.ML': arxivFeed, A5023888391: openAlexFeed }, calls),
  });
  try {
    f.news.addSource({ kind: 'arxiv', value: 'stat.ML' });
    const follow = f.news.addSource({ kind: 'openalex_author', value: 'A5023888391' });
    const broken = f.news.addSource({ kind: 'rss', value: 'https://example.org/feed.xml' });
    const disabled = f.news.addSource({ kind: 'rss', value: 'https://example.com/off.xml' });
    f.news.patchSource(disabled.id, { enabled: false });
    const first = f.news.collect();
    assert.equal(f.news.collect(), first);
    assert.equal(f.news.collectStatus().running, true);
    const status = await first;
    assert.equal(status.running, false);
    assert.equal(status.fetched, 5);
    assert.equal(status.added, 4);
    assert.deepEqual(
      status.errors.map((e) => [e.sourceId, e.message]),
      [[broken.id, 'Feed unavailable']],
    );
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.endsWith(daysAgo(7))));
    assert.equal(f.news.sources().find((s) => s.id === broken.id)!.lastError, 'Feed unavailable');
    assert.equal(
      f.news.sources().find((s) => s.id === follow.id)!.lastFetchedAt,
      now.toISOString(),
    );

    const items = f.news.list({ state: 'all' }).items;
    const merged = items.filter((item) => item.arxivId === '2409.01234');
    assert.equal(merged.length, 1, 'arXiv and OpenAlex copies are one item');
    assert.equal(merged[0].sources.length, 2);
    assert.equal(merged[0].venue, 'arXiv (Cornell University)');
    assert.equal(merged[0].features.follow, 1);
    assert.equal(items.find((i) => i.arxivId === '2401.00001')!.paperId, 'lib:ARXPAPER');
    const doiMatch = items.find((i) => i.doi === '10.1000/lib.1')!;
    assert.equal(doiMatch.paperId, 'lib:DOIPAPER');
    assert.equal(doiMatch.state, 'new');
    assert.equal(
      Number(
        f.db.db.prepare("SELECT COUNT(*) n FROM source_items WHERE id NOT LIKE 'lib:%'").get()!.n,
      ),
      0,
      'News rows stay out of source_items',
    );

    // A second collection asks only for items since the last successful fetch.
    calls.length = 0;
    const again = await f.news.collect();
    assert.equal(again.added, 0);
    assert.ok(calls.some((call) => call === `arxiv:stat.ML:${now.toISOString()}`));
    assert.equal(f.news.list({ state: 'all' }).items.length, 4);
  } finally {
    f.cleanup();
  }
});

test('queue excludes library matches and orders by pre-score; state and feedback are recorded', async () => {
  const f = fixture({ fetchSource: stubFetch({ 'stat.ML': arxivFeed }) });
  try {
    f.news.addSource({ kind: 'arxiv', value: 'stat.ML' });
    await f.news.collect();
    const { runId } = f.retrieval.begin('Triage news', 'assistant', 'local-model');
    const queue = f.news.queue(runId);
    assert.equal(queue.total, 2);
    assert.equal(queue.nextOffset, null);
    assert.deepEqual(
      queue.items.map((item) => item.arxivId),
      ['2409.01234', '2409.05555'],
    );
    assert.ok(queue.items[0].features.lex > queue.items[1].features.lex);
    assert.ok(queue.items[0].preScore > queue.items[1].preScore);
    assert.equal(f.news.queue(runId, { limit: 1 }).nextOffset, 1);
    assert.throws(() => f.news.queue(runId, { limit: 31 }), /limit/);
    assert.throws(() => f.news.queue('no-run'), /Unknown run/);

    const [relevant, poetry] = queue.items;
    assert.equal(f.news.setState(relevant.id, 'saved')!.state, 'saved');
    assert.throws(() => f.news.setState(poetry.id, 'dismissed', 'boring' as any), /reason/);
    assert.throws(() => f.news.setState(poetry.id, 'saved', 'not_relevant'), /reason/);
    const dismissed = f.news.setState(poetry.id, 'dismissed', 'not_relevant')!;
    assert.equal(dismissed.dismissReason, 'not_relevant');
    assert.equal(
      f.news.list().items.some((item) => item.id === poetry.id),
      false,
    );
    assert.equal(f.news.list({ state: 'dismissed' }).items[0].id, poetry.id);
    assert.equal(f.news.setState(poetry.id, 'new')!.dismissReason, null);
    f.news.setState(poetry.id, 'dismissed', 'not_relevant');
    assert.equal(f.news.feedback(relevant.id, 'more')!.feedback, 'more');
    assert.equal(f.news.feedback(relevant.id, 'open')!.feedback, 'more');
    assert.throws(() => f.news.feedback(relevant.id, 'love' as any), /Invalid feedback/);
    assert.equal(f.news.feedback('missing', 'more'), null);
    assert.equal(f.news.setState('missing', 'saved'), null);

    const counts = f.news.list().counts;
    assert.deepEqual(counts, { new: 1, saved: 1, added: 0, dismissed: 1, untriaged: 0 });
    assert.equal(f.news.sources()[0].keptCount, 1);
    const summary = f.news.feedbackSummary(runId);
    assert.equal(summary.kept.total, 1);
    assert.deepEqual(summary.dismissed.reasons, { not_relevant: 1 });
    assert.equal(summary.more[0].id, relevant.id);
    assert.equal(summary.perSource[0].precision, 0.5);

    const added = f.news.markAdded(relevant.id, 'lib:DOIPAPER')!;
    assert.equal(added.state, 'added');
    assert.equal(added.paperId, 'lib:DOIPAPER');
    assert.throws(() => f.news.setState(relevant.id, 'new'), /already added/);
    assert.throws(() => f.news.markAdded(poetry.id, 'lib:NOPE'), /Paper not found/);
    assert.equal(f.news.linkProject(relevant.id, f.project.id)!.id, relevant.id);
    assert.ok(f.projects.detail(f.project.id)!.project.paperIds.includes('lib:DOIPAPER'));
    assert.throws(() => f.news.linkProject(poetry.id, f.project.id), /library before/);
  } finally {
    f.cleanup();
  }
});

test('triage is validated and sets the final score', async () => {
  const f = fixture({ fetchSource: stubFetch({ 'stat.ML': arxivFeed }) });
  try {
    f.news.addSource({ kind: 'arxiv', value: 'stat.ML' });
    await f.news.collect();
    const { runId } = f.retrieval.begin('Triage news', 'assistant', 'local-model');
    const [relevant, poetry] = f.news.queue(runId).items;
    const ok = { itemId: poetry.id, score: 5, why: 'Matches your ocean project.' };
    assert.throws(() => f.news.submitTriage('no-run', [ok]), /Unknown run/);
    assert.throws(() => f.news.submitTriage(runId, []), /1–50/);
    assert.throws(() => f.news.submitTriage(runId, [{ ...ok, score: 6 }]), /score/);
    assert.throws(() => f.news.submitTriage(runId, [{ ...ok, score: 2.5 }]), /score/);
    assert.throws(() => f.news.submitTriage(runId, [{ ...ok, why: ' ' }]), /why/);
    assert.throws(() => f.news.submitTriage(runId, [{ ...ok, why: 'x'.repeat(1001) }]), /why/);
    assert.throws(() => f.news.submitTriage(runId, [{ ...ok, itemId: 'nope' }]), /Unknown News/);
    assert.throws(() => f.news.submitTriage(runId, [ok, ok]), /Duplicate/);
    assert.throws(
      () => f.news.submitTriage(runId, [{ ...ok, projectIds: ['missing'] }]),
      /Unknown projectId/,
    );
    assert.throws(
      () => f.news.submitTriage(runId, [{ ...ok, citationIds: ['not-retrieved'] }]),
      /not retrieved/,
    );
    assert.equal(f.news.item(poetry.id)!.triage, null, 'failed submissions store nothing');

    const evidence = f.retrieval.retrieve(runId, { query: 'climate calibration', limit: 1 })
      .evidence[0];
    const result = f.news.submitTriage(runId, [
      { ...ok, projectIds: [f.project.id], citationIds: [evidence.chunkId] },
      { itemId: relevant.id, score: 1, why: 'Weak match.' },
    ]);
    assert.equal(result.saved, 2);
    const triaged = f.news.item(poetry.id)!;
    assert.equal(triaged.triage!.score, 5);
    assert.deepEqual(triaged.triage!.projectIds, [f.project.id]);
    assert.deepEqual(triaged.triage!.agent, { name: 'assistant', model: 'local-model' });
    assert.equal(triaged.triage!.citations[0].chunkId, evidence.chunkId);
    assert.equal(triaged.score, Math.round((0.6 + 0.4 * triaged.preScore) * 1000) / 1000);
    const low = f.news.item(relevant.id)!;
    assert.equal(low.score, Math.round(0.4 * low.preScore * 1000) / 1000);
    const listed = f.news.list({ state: 'new' }).items.map((item) => item.id);
    assert.equal(listed[0], poetry.id, 'a high triage score outranks a high pre-score');
    assert.ok(listed.indexOf(poetry.id) < listed.indexOf(relevant.id));
    assert.equal(f.news.queue(runId).total, 0);
    assert.equal(f.news.list().counts.untriaged, 0);
    assert.equal(f.news.list().lastTriageAt, now.toISOString());

    // Re-triage keeps history; the latest judgement wins.
    f.news.submitTriage(runId, [{ ...ok, score: 2 }]);
    assert.equal(f.news.item(poetry.id)!.triage!.score, 2);
    assert.equal(
      Number(
        f.db.db.prepare('SELECT COUNT(*) n FROM news_triage WHERE item_id=?').get(poetry.id)!.n,
      ),
      2,
    );
  } finally {
    f.cleanup();
  }
});

test('assistant source suggestions are validated, deduplicated, accepted or declined', () => {
  const f = fixture({ fetchSource: stubFetch({}) });
  try {
    const { runId } = f.retrieval.begin('Suggest sources', 'assistant', 'local-model');
    f.news.addSource({ kind: 'arxiv', value: 'stat.ML' });
    assert.throws(() => f.news.proposeSources('no-run', []), /Unknown run/);
    assert.throws(
      () => f.news.proposeSources(runId, [{ kind: 'openalex_query', value: 'x', reason: '' }]),
      /reason/,
    );
    const proposed = f.news.proposeSources(runId, [
      { kind: 'arxiv', value: 'stat.ML', reason: 'Already followed' },
      { kind: 'openalex_query', value: 'ocean turbulence', reason: 'Core topic' },
      { kind: 'openalex_query', value: 'climate calibration', reason: 'Project topic' },
    ]);
    assert.equal(proposed.length, 2);
    assert.ok(proposed.every((s) => s.origin === 'assistant' && s.id));
    const again = f.news.proposeSources(runId, [
      { kind: 'openalex_query', value: 'ocean turbulence', reason: 'Still core' },
    ]);
    assert.equal(again[0].id, proposed[0].id);
    assert.equal(f.news.suggestions().length, 2);

    const source = f.news.decideSuggestion(proposed[0].id!, true)!;
    assert.equal(source.kind, 'openalex_query');
    assert.equal(source.value, proposed[0].value);
    assert.equal(f.news.decideSuggestion(proposed[0].id!, true)!.id, source.id);
    assert.throws(() => f.news.decideSuggestion(proposed[0].id!, false), /already decided/);
    assert.equal(f.news.decideSuggestion(proposed[1].id!, false), null);
    assert.throws(() => f.news.decideSuggestion('missing', true), /not found/);
    assert.deepEqual(f.news.suggestions(), []);
    assert.deepEqual(
      f.news.proposeSources(runId, [
        { kind: 'openalex_query', value: 'climate calibration', reason: 'Asking again' },
      ]),
      [],
      'declined suggestions are not proposed again',
    );
  } finally {
    f.cleanup();
  }
});

test('settings keep the OpenAlex key server-side', () => {
  const f = fixture({ fetchSource: stubFetch({}) });
  try {
    assert.deepEqual(f.news.settings(), { contactEmail: '', hasOpenAlexKey: false });
    assert.deepEqual(
      f.news.setSettings({ contactEmail: 'me@example.org', openAlexKey: 'abc123' }),
      {
        contactEmail: 'me@example.org',
        hasOpenAlexKey: true,
      },
    );
    assert.throws(() => f.news.setSettings({ contactEmail: 'not an email' }), /email/);
    assert.equal(f.news.setSettings({ openAlexKey: '' }).hasOpenAlexKey, false);
  } finally {
    f.cleanup();
  }
});

const arxivRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
  <channel>
    <title>stat.ML updates on arXiv.org</title>
    <link>http://rss.arxiv.org/rss/stat.ML</link>
    <item>
      <title>Calibrating climate models with ocean turbulence data</title>
      <link>https://arxiv.org/abs/2409.01234</link>
      <description>arXiv:2409.01234v1 Announce Type: new
Abstract: We calibrate climate models using ocean turbulence observations.</description>
      <guid isPermaLink="false">oai:arXiv.org:2409.01234v1</guid>
      <category>stat.ML</category>
      <pubDate>Tue, 01 Oct 2026 00:00:00 -0400</pubDate>
      <arxiv:announce_type>new</arxiv:announce_type>
      <dc:rights>http://creativecommons.org/licenses/by/4.0/</dc:rights>
      <dc:creator>Ada Lovelace, Alan Turing</dc:creator>
    </item>
    <item>
      <title>A revised older paper</title>
      <link>https://arxiv.org/abs/2301.00002</link>
      <description>arXiv:2301.00002v3 Announce Type: replace
Abstract: Revision.</description>
      <guid isPermaLink="false">oai:arXiv.org:2301.00002v3</guid>
      <pubDate>Tue, 01 Oct 2026 00:00:00 -0400</pubDate>
      <arxiv:announce_type>replace</arxiv:announce_type>
      <dc:creator>Someone Else</dc:creator>
    </item>
  </channel>
</rss>`;
const openAlexJson = {
  meta: { count: 1 },
  results: [
    {
      id: 'https://openalex.org/W4400000001',
      doi: 'https://doi.org/10.48550/arxiv.2409.01234',
      title: 'Calibrating climate models with ocean turbulence data',
      display_name: 'Calibrating climate models with ocean turbulence data',
      publication_date: '2026-09-30',
      created_date: '2026-09-30',
      ids: {
        openalex: 'https://openalex.org/W4400000001',
        doi: 'https://doi.org/10.48550/arxiv.2409.01234',
      },
      primary_location: {
        landing_page_url: 'https://arxiv.org/abs/2409.01234',
        source: { display_name: 'arXiv (Cornell University)' },
      },
      locations: [{ landing_page_url: 'https://arxiv.org/abs/2409.01234' }],
      authorships: [
        { author: { id: 'https://openalex.org/A5023888391', display_name: 'Ada Lovelace' } },
      ],
      abstract_inverted_index: { We: [0], calibrate: [1], models: [2] },
      referenced_works: ['https://openalex.org/W1'],
      type: 'preprint',
    },
  ],
};

test('collection through the real fetchers dedupes an arXiv RSS item with its OpenAlex record', async () => {
  const requested: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    requested.push(url);
    if (url.startsWith('https://rss.arxiv.org/'))
      return new Response(arxivRss, { headers: { 'content-type': 'application/rss+xml' } });
    if (url.startsWith('https://api.openalex.org/'))
      return new Response(JSON.stringify(openAlexJson), {
        headers: { 'content-type': 'application/json' },
      });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  const f = fixture({ fetcher });
  try {
    f.news.setSettings({ openAlexKey: 'test-key' });
    f.news.addSource({ kind: 'arxiv', value: 'stat.ML' });
    f.news.addSource({ kind: 'openalex_author', value: 'A5023888391' });
    const status = await f.news.collect();
    assert.deepEqual(status.errors, []);
    assert.ok(requested.some((url) => url.startsWith('https://rss.arxiv.org/rss/stat.ML')));
    assert.ok(requested.some((url) => url.includes('api_key=test-key')));
    const items = f.news.list({ state: 'all' }).items;
    assert.equal(items.length, 1, 'replacements are skipped and copies merged');
    assert.equal(items[0].arxivId, '2409.01234');
    assert.equal(items[0].sources.length, 2);
    assert.ok(items[0].authors.includes('Ada Lovelace'));
  } finally {
    f.cleanup();
  }
});
