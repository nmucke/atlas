import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AlertCircle,
  Check,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import type {
  NewsSettings,
  NewsSettingsInput,
  NewsSource,
  NewsSourceInput,
  NewsSourceKind,
  NewsSourceSuggestion,
} from '../shared/news';
import { errorMessage, request, send } from './api';
import './news.css';

export interface NewsSourcesResponse {
  sources: NewsSource[];
  suggestions: NewsSourceSuggestion[];
  settings: NewsSettings;
}

const kindOrder: NewsSourceKind[] = [
  'arxiv',
  'rss',
  'openalex_author',
  'openalex_cites',
  'openalex_query',
];
const kindTitle: Record<NewsSourceKind, string> = {
  arxiv: 'arXiv categories',
  rss: 'Feeds: blogs, journals and GitHub releases',
  openalex_author: 'Authors you follow',
  openalex_cites: 'New work citing a paper',
  openalex_query: 'Keyword searches',
};
const kindShort: Record<NewsSourceKind, string> = {
  arxiv: 'arXiv',
  rss: 'Feed',
  openalex_author: 'Author',
  openalex_cites: 'Citations',
  openalex_query: 'Keywords',
};
const examples = [
  'stat.ML',
  'https://distill.pub',
  'https://github.com/pytorch/pytorch',
  'Yann LeCun',
  'neural operators turbulence',
];

const sourceKey = (source: { kind: NewsSourceKind; value: string }) =>
  `${source.kind}\u0000${source.value}`;

function when(value: string | null) {
  if (!value) return 'Never fetched';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `Fetched ${date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

interface Removed {
  source: NewsSource;
  index: number;
}

export function NewsSources({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = useState<NewsSourcesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState<NewsSourceSuggestion[] | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<Record<string, Removed>>({});
  const [status, setStatus] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setData(await request<NewsSourcesResponse>('/api/news/sources'));
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error, 'Could not load your sources.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy((previous) => ({ ...previous, [key]: true }));
    setErrors((previous) => {
      const copy = { ...previous };
      delete copy[key];
      return copy;
    });
    try {
      await action();
    } catch (error) {
      setErrors((previous) => ({
        ...previous,
        [key]: errorMessage(error, 'Something went wrong. Try again.'),
      }));
    } finally {
      setBusy((previous) => {
        const copy = { ...previous };
        delete copy[key];
        return copy;
      });
    }
  };

  const detect = async (value = input) => {
    const text = value.trim();
    if (!text || detecting) return;
    setInput(text);
    setDetecting(true);
    setDetectError(null);
    setDetected(null);
    try {
      const found = await send<NewsSourceSuggestion[]>('/api/news/sources/detect', 'POST', {
        input: text,
      });
      setDetected(found);
      setStatus(
        found.length
          ? `Found ${found.length} possible source${found.length === 1 ? '' : 's'}.`
          : 'Nothing recognized.',
      );
    } catch (error) {
      setDetectError(errorMessage(error, 'Could not check that input.'));
    } finally {
      setDetecting(false);
    }
  };

  const addSource = (source: NewsSourceInput, key: string) =>
    run(key, async () => {
      const created = await send<NewsSource>('/api/news/sources', 'POST', source);
      setData((previous) =>
        previous
          ? {
              ...previous,
              sources: previous.sources.some((item) => item.id === created.id)
                ? previous.sources
                : [...previous.sources, created],
            }
          : previous,
      );
      setStatus(`Added ${created.label}.`);
      onChanged();
    });

  const patchSource = (source: NewsSource, enabled: boolean) =>
    run(source.id, async () => {
      setData((previous) =>
        previous
          ? {
              ...previous,
              sources: previous.sources.map((item) =>
                item.id === source.id ? { ...item, enabled } : item,
              ),
            }
          : previous,
      );
      try {
        const next = await send<NewsSource>(
          `/api/news/sources/${encodeURIComponent(source.id)}`,
          'PATCH',
          { enabled },
        );
        setData((previous) =>
          previous
            ? {
                ...previous,
                sources: previous.sources.map((item) => (item.id === next.id ? next : item)),
              }
            : previous,
        );
        setStatus(`${next.label} ${next.enabled ? 'enabled' : 'paused'}.`);
      } catch (error) {
        setData((previous) =>
          previous
            ? {
                ...previous,
                sources: previous.sources.map((item) =>
                  item.id === source.id ? { ...item, enabled: source.enabled } : item,
                ),
              }
            : previous,
        );
        throw error;
      }
    });

  const removeSource = (source: NewsSource) =>
    run(source.id, async () => {
      await request<{ ok: true }>(`/api/news/sources/${encodeURIComponent(source.id)}`, {
        method: 'DELETE',
      });
      const index = data?.sources.findIndex((item) => item.id === source.id) ?? 0;
      setRemoved((previous) => ({ ...previous, [source.id]: { source, index } }));
      setStatus(`Removed ${source.label}. Undo is available.`);
      onChanged();
    });

  const undoRemove = (entry: Removed) =>
    run(entry.source.id, async () => {
      let restored = await send<NewsSource>('/api/news/sources', 'POST', {
        kind: entry.source.kind,
        value: entry.source.value,
        label: entry.source.label,
      });
      if (!entry.source.enabled && restored.enabled)
        restored = await send<NewsSource>(
          `/api/news/sources/${encodeURIComponent(restored.id)}`,
          'PATCH',
          { enabled: false },
        );
      setRemoved((previous) => {
        const copy = { ...previous };
        delete copy[entry.source.id];
        return copy;
      });
      setData((previous) => {
        if (!previous) return previous;
        const sources = previous.sources.map((item) =>
          item.id === entry.source.id ? restored : item,
        );
        return { ...previous, sources };
      });
      setStatus(`Restored ${restored.label}.`);
      onChanged();
    });

  const decide = (suggestion: NewsSourceSuggestion, accept: boolean) =>
    run(`suggestion:${suggestion.id}`, async () => {
      const result = await send<{ source: NewsSource | null }>(
        `/api/news/suggestions/${encodeURIComponent(suggestion.id!)}/decision`,
        'POST',
        { accept },
      );
      setData((previous) =>
        previous
          ? {
              ...previous,
              suggestions: previous.suggestions.filter((item) => item.id !== suggestion.id),
              sources:
                result.source && !previous.sources.some((item) => item.id === result.source!.id)
                  ? [...previous.sources, result.source]
                  : previous.sources,
            }
          : previous,
      );
      setStatus(accept ? `Added ${suggestion.label}.` : `Dismissed ${suggestion.label}.`);
      onChanged();
    });

  const sources = data?.sources ?? [];
  const existing = new Set(
    sources.filter((source) => !removed[source.id]).map((source) => sourceKey(source)),
  );
  const groups = kindOrder
    .map((kind) => ({ kind, items: sources.filter((source) => source.kind === kind) }))
    .filter((group) => group.items.length);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void detect();
  };

  return (
    <div className="news-page news-sources">
      <div className="page-heading">
        <div>
          <div className="eyebrow">NEWS</div>
          <h1>Sources</h1>
          <p>
            Where News looks when you press Refresh, or when your assistant runs the news scan.
            Nothing is fetched on a schedule.
          </p>
        </div>
      </div>

      <p className="news-sr-only" role="status" aria-live="polite">
        {status}
      </p>

      <section className="news-panel news-add" aria-labelledby="news-add-title">
        <h2 id="news-add-title">Add a source</h2>
        <p className="news-panel-hint">
          Paste anything: an arXiv category (<code>stat.ML</code>), a blog or journal URL, a GitHub
          repository, an OpenAlex author or work link, an author’s name, or a few keywords.
        </p>
        <form className="news-add-form" onSubmit={submit}>
          <label className="search-field">
            <Search size={15} />
            <input
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="stat.ML, https://…, github.com/owner/repo, Jane Doe, or keywords"
              aria-label="Source to add"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button
            type="submit"
            className="news-btn primary news-btn-tall"
            disabled={!input.trim() || detecting}
          >
            {detecting ? <LoaderCircle size={14} className="spin" /> : <Search size={14} />}
            Find
          </button>
        </form>
        {detectError && (
          <div className="assistant-inline-error news-inline-error" role="alert">
            <AlertCircle size={15} />
            <span>{detectError}</span>
            <button className="news-btn" onClick={() => void detect()}>
              <RotateCcw size={13} /> Retry
            </button>
          </div>
        )}
        {detected && (
          <div className="news-detected">
            {detected.length ? (
              detected.map((suggestion) => {
                const key = `detected:${sourceKey(suggestion)}`;
                const added = existing.has(sourceKey(suggestion));
                return (
                  <div className="news-source-row" key={key}>
                    <span className="news-kind">{kindShort[suggestion.kind]}</span>
                    <div className="news-source-main">
                      <strong>{suggestion.label}</strong>
                      <span className="news-source-value">{suggestion.value}</span>
                      {suggestion.reason && <span>{suggestion.reason}</span>}
                      {errors[key] && (
                        <span className="news-row-error" role="alert">
                          <AlertCircle size={13} /> {errors[key]}
                        </span>
                      )}
                    </div>
                    <button
                      className={`news-btn${added ? ' done' : ' primary'}`}
                      disabled={added || busy[key]}
                      onClick={() =>
                        void addSource(
                          {
                            kind: suggestion.kind,
                            value: suggestion.value,
                            label: suggestion.label,
                          },
                          key,
                        )
                      }
                    >
                      {busy[key] ? (
                        <LoaderCircle size={13} className="spin" />
                      ) : added ? (
                        <Check size={13} />
                      ) : (
                        <Plus size={13} />
                      )}
                      {added ? 'Added' : 'Add'}
                    </button>
                  </div>
                );
              })
            ) : (
              <p className="news-panel-hint">
                Nothing recognized in “{input.trim()}”. Try an arXiv category such as{' '}
                <code>cs.LG</code>, a site’s homepage or feed URL, or a few keywords.
              </p>
            )}
          </div>
        )}
      </section>

      {!!data?.suggestions.length && (
        <section className="news-panel" aria-labelledby="news-suggested-title">
          <h2 id="news-suggested-title">
            <Sparkles size={14} /> Suggested by your assistant
          </h2>
          {data.suggestions.map((suggestion) => {
            const key = `suggestion:${suggestion.id}`;
            return (
              <div className="news-source-row" key={suggestion.id ?? sourceKey(suggestion)}>
                <span className="news-kind">{kindShort[suggestion.kind]}</span>
                <div className="news-source-main">
                  <strong>{suggestion.label}</strong>
                  <span className="news-source-value">{suggestion.value}</span>
                  {suggestion.reason && <span>{suggestion.reason}</span>}
                  {errors[key] && (
                    <span className="news-row-error" role="alert">
                      <AlertCircle size={13} /> {errors[key]}
                    </span>
                  )}
                </div>
                <div className="news-row-actions">
                  <button
                    className="news-btn primary"
                    disabled={busy[key] || !suggestion.id}
                    onClick={() => void decide(suggestion, true)}
                  >
                    {busy[key] ? <LoaderCircle size={13} className="spin" /> : <Plus size={13} />}
                    Add
                  </button>
                  <button
                    className="news-btn"
                    disabled={busy[key] || !suggestion.id}
                    onClick={() => void decide(suggestion, false)}
                    aria-label={`Dismiss suggestion ${suggestion.label}`}
                  >
                    <X size={13} /> Dismiss
                  </button>
                </div>
              </div>
            );
          })}
        </section>
      )}

      {loadError && (
        <div className="assistant-page-error news-error" role="alert">
          <AlertCircle size={15} />
          <span>{loadError}</span>
          <button className="news-btn" onClick={() => void load()}>
            <RotateCcw size={13} /> Retry
          </button>
        </div>
      )}

      {loading && !data ? (
        <p className="news-empty" role="status">
          <LoaderCircle size={15} className="spin" /> Loading sources…
        </p>
      ) : data && !sources.length ? (
        <div className="news-empty">
          <p>
            No sources yet. Add one above, or try one of these examples (each is checked first; you
            choose what to add):
          </p>
          <div className="news-examples">
            {examples.map((example) => (
              <button
                key={example}
                className="news-btn"
                onClick={() => {
                  inputRef.current?.focus();
                  void detect(example);
                }}
              >
                {example}
              </button>
            ))}
          </div>
        </div>
      ) : (
        groups.map((group) => (
          <section className="news-panel" key={group.kind} aria-label={kindTitle[group.kind]}>
            <h2>
              {kindTitle[group.kind]} <span className="news-count">{group.items.length}</span>
            </h2>
            {group.items.map((source) => {
              const gone = removed[source.id];
              if (gone)
                return (
                  <div className="news-source-row news-source-removed" key={source.id}>
                    <span>
                      Removed <strong>{source.label}</strong>
                    </span>
                    <button
                      className="news-btn"
                      disabled={busy[source.id]}
                      onClick={() => void undoRemove(gone)}
                    >
                      {busy[source.id] ? (
                        <LoaderCircle size={13} className="spin" />
                      ) : (
                        <RotateCcw size={13} />
                      )}
                      Undo
                    </button>
                    {errors[source.id] && (
                      <span className="news-row-error" role="alert">
                        <AlertCircle size={13} /> {errors[source.id]}
                      </span>
                    )}
                  </div>
                );
              return (
                <div
                  className={`news-source-row${source.enabled ? '' : ' is-paused'}`}
                  key={source.id}
                >
                  <label className="news-switch" title={source.enabled ? 'Pause' : 'Enable'}>
                    <input
                      type="checkbox"
                      role="switch"
                      checked={source.enabled}
                      disabled={busy[source.id]}
                      onChange={(event) => void patchSource(source, event.target.checked)}
                      aria-label={`${source.enabled ? 'Pause' : 'Enable'} ${source.label}`}
                    />
                    <span aria-hidden="true" />
                  </label>
                  <div className="news-source-main">
                    <strong>{source.label}</strong>
                    <span className="news-source-value">{source.value}</span>
                    <span>
                      {when(source.lastFetchedAt)} · {source.itemCount} item
                      {source.itemCount === 1 ? '' : 's'} · {source.keptCount} kept
                      {!source.enabled && ' · paused'}
                    </span>
                    {source.lastError && (
                      <span className="news-row-error">
                        <AlertCircle size={13} /> Last fetch failed: {source.lastError}
                      </span>
                    )}
                    {errors[source.id] && (
                      <span className="news-row-error" role="alert">
                        <AlertCircle size={13} /> {errors[source.id]}
                      </span>
                    )}
                  </div>
                  <button
                    className="news-btn"
                    disabled={busy[source.id]}
                    onClick={() => void removeSource(source)}
                    aria-label={`Remove ${source.label}`}
                  >
                    {busy[source.id] ? (
                      <LoaderCircle size={13} className="spin" />
                    ) : (
                      <Trash2 size={13} />
                    )}
                    Remove
                  </button>
                </div>
              );
            })}
          </section>
        ))
      )}

      {data && (
        <NewsSettingsPanel
          settings={data.settings}
          onSaved={(settings) =>
            setData((previous) => (previous ? { ...previous, settings } : previous))
          }
        />
      )}
    </div>
  );
}

function NewsSettingsPanel({
  settings,
  onSaved,
}: {
  settings: NewsSettings;
  onSaved: (settings: NewsSettings) => void;
}) {
  const [email, setEmail] = useState(settings.contactEmail);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => setEmail(settings.contactEmail), [settings.contactEmail]);

  const save = async (input: NewsSettingsInput) => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const next = await send<NewsSettings>('/api/news/settings', 'PUT', input);
      onSaved(next);
      setKey('');
      setSaved(true);
    } catch (caught) {
      setError(errorMessage(caught, 'Could not save settings.'));
    } finally {
      setSaving(false);
    }
  };

  const dirty = email.trim() !== settings.contactEmail || !!key.trim();

  return (
    <section className="news-panel news-settings" aria-labelledby="news-settings-title">
      <h2 id="news-settings-title">
        <KeyRound size={14} /> Settings
      </h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save({
            contactEmail: email.trim(),
            ...(key.trim() ? { openAlexKey: key.trim() } : {}),
          });
        }}
      >
        <label className="news-field">
          <span>Contact email</span>
          <input
            type="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setSaved(false);
            }}
            placeholder="you@example.org"
            autoComplete="email"
          />
          <small>Sent to arXiv and OpenAlex as a polite contact address. Optional.</small>
        </label>
        <label className="news-field">
          <span>
            OpenAlex API key{' '}
            {settings.hasOpenAlexKey && (
              <em className="news-saved-key">
                <Check size={12} /> saved
              </em>
            )}
          </span>
          <input
            type="password"
            value={key}
            onChange={(event) => {
              setKey(event.target.value);
              setSaved(false);
            }}
            placeholder={settings.hasOpenAlexKey ? 'Enter a new key to replace it' : 'Paste key'}
            autoComplete="off"
          />
          <small>
            Needed for author, citation and keyword sources. Get a free key at{' '}
            <a href="https://openalex.org/settings/api" target="_blank" rel="noopener noreferrer">
              openalex.org/settings/api <ExternalLink size={11} />
            </a>
            . The key is never shown again.
          </small>
        </label>
        {error && (
          <div className="assistant-inline-error news-inline-error" role="alert">
            <AlertCircle size={15} />
            <span>{error}</span>
          </div>
        )}
        <div className="news-settings-actions">
          {settings.hasOpenAlexKey && (
            <button
              type="button"
              className="news-btn"
              disabled={saving}
              onClick={() => void save({ openAlexKey: '' })}
            >
              <X size={13} /> Clear saved key
            </button>
          )}
          <span role="status" aria-live="polite" className="news-saved-status">
            {saved && (
              <>
                <Check size={13} /> Saved
              </>
            )}
          </span>
          <button type="submit" className="news-btn primary" disabled={saving || !dirty}>
            {saving && <LoaderCircle size={13} className="spin" />} Save settings
          </button>
        </div>
      </form>
    </section>
  );
}
