import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  ExternalLink,
  FileText,
  LoaderCircle,
  RefreshCw,
  SearchCheck,
  Sparkles,
  X,
} from 'lucide-react';
import type { Paper, Project } from '../shared/types';
import type { AIRecord, ResearchProfile } from '../shared/assistant';
import { readableReview } from '../shared/review-text';
import { compareRecommendationStrength } from '../shared/recommendations';
import { ZoteroActions, type ZoteroStatus } from './ZoteroActions';
import 'katex/dist/katex.min.css';
import './assistant.css';

export type { AIRecord } from '../shared/assistant';
export { compareRecommendationStrength };

interface AssistantSnapshot {
  records: AIRecord[];
  profile: ResearchProfile;
  zotero: ZoteroStatus;
  index: {
    chunks: number;
    documents: number;
    pdfPages: number;
    indexedAt: string | null;
    pdfErrors: string[];
    indexing: boolean;
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.method && init.method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* Keep the HTTP error. */
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export function useAssistant() {
  const [data, setData] = useState<AssistantSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [profileDraft, setProfileDraft] = useState<string | null>(null);
  const requestNumber = useRef(0);
  const profileDirty = profileDraft !== null && profileDraft !== (data?.profile.text ?? '');

  useEffect(() => {
    if (!profileDirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [profileDirty]);

  const refresh = useCallback(async () => {
    const number = ++requestNumber.current;
    try {
      const next = await request<AssistantSnapshot>('/api/assistant');
      if (number === requestNumber.current) {
        setData(next);
        setError(null);
      }
    } catch (caught) {
      if (number === requestNumber.current)
        setError(caught instanceof Error ? caught.message : 'Could not load Assistant.');
      throw caught;
    } finally {
      if (number === requestNumber.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh().catch(() => undefined);
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 15_000);
    const onFocus = () => void refresh().catch(() => undefined);
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  const decide = useCallback(
    async (id: string, approve: boolean) => {
      await request<unknown>(`/api/assistant/records/${encodeURIComponent(id)}/decision`, {
        method: 'POST',
        body: JSON.stringify({ approve }),
      });
      try {
        await refresh();
      } catch {
        throw new Error('Decision saved, but Assistant could not refresh. Try Refresh.');
      }
    },
    [refresh],
  );

  const saveProfile = useCallback(
    async (value: string) => {
      await request<unknown>('/api/assistant/profile', {
        method: 'POST',
        body: JSON.stringify({ text: value }),
      });
      try {
        await refresh();
        setProfileDraft(null);
      } catch {
        throw new Error('Profile saved, but Assistant could not refresh. Try Refresh.');
      }
    },
    [refresh],
  );

  const rebuildIndex = useCallback(async () => {
    await request<unknown>('/api/assistant/index', { method: 'POST', body: '{}' });
    try {
      await refresh();
    } catch {
      throw new Error('Index updated, but Assistant could not refresh. Try Refresh.');
    }
  }, [refresh]);

  return {
    data,
    loading,
    error,
    refresh,
    decide,
    saveProfile,
    rebuildIndex,
    profileDraft,
    setProfileDraft,
  };
}

function kindLabel(kind: AIRecord['kind']) {
  if (kind === 'review') return 'Paper review';
  if (kind === 'tags') return 'Tag proposal';
  if (kind === 'recommendation') return 'Recommendation';
  if (kind === 'note') return 'Project note';
  return 'Profile proposal';
}

function levelLabel(level: AIRecord['level']) {
  if (level === 'essential') return 'Essential';
  if (level === 'recommended') return 'Recommended';
  if (level === 'optional') return 'Optional';
  return null;
}

function safeExternalUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function safeMarkdownUrl(value: string, key: string) {
  if (key === 'src') return '';
  return safeExternalUrl(value) ?? '';
}

function dateLabel(value: string | null) {
  if (!value) return 'Not indexed yet';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

interface RecordCardProps {
  record: AIRecord;
  papers?: Paper[];
  projects?: Project[];
  compact?: boolean;
  /** Hide Approve/Reject, e.g. where the surrounding page offers its own actions. */
  hideDecision?: boolean;
  /** Hide the reading score when the surrounding page already shows it. */
  hideVerdict?: boolean;
  onDecision: (id: string, approve: boolean) => Promise<void>;
  onOpenPaper?: (id: string) => void;
  onOpenProject?: (id: string) => void;
}

export function AIRecordCard({
  record,
  papers = [],
  projects = [],
  compact = false,
  hideDecision = false,
  hideVerdict = false,
  onDecision,
  onOpenPaper,
  onOpenProject,
}: RecordCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paper = papers.find((item) => item.id === record.paperId);
  const project = projects.find((item) => item.id === record.projectId);
  const candidateUrl = record.candidate
    ? safeExternalUrl(record.candidate.url) ||
      (record.candidate.doi ? `https://doi.org/${encodeURIComponent(record.candidate.doi)}` : null)
    : null;
  const decide = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await onDecision(record.id, approve);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not record this decision.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={`assistant-record${compact ? ' assistant-record-compact' : ''}`}>
      <div className="assistant-record-top">
        <span className="assistant-kind">
          <Sparkles size={13} /> {kindLabel(record.kind)}
        </span>
        {record.level && (
          <span className={`assistant-level assistant-level-${record.level}`}>
            {levelLabel(record.level)}
          </span>
        )}
        {record.status !== 'pending' && (
          <span className={`assistant-record-status assistant-record-${record.status}`}>
            {record.status === 'approved' ? 'Approved' : 'Rejected'}
          </span>
        )}
      </div>
      <h3>{record.title || kindLabel(record.kind)}</h3>
      {record.readingRecommendation && !hideVerdict && (
        <div className="assistant-reading-verdict">
          <strong>Reading recommendation · {record.readingRecommendation.score}/5</strong>
          <p>{record.readingRecommendation.reason}</p>
        </div>
      )}
      {(paper || project) && (
        <div className="assistant-record-context">
          {paper && (
            <button disabled={!onOpenPaper} onClick={() => onOpenPaper?.(paper.id)}>
              <BookOpen size={13} /> {paper.title || 'Untitled paper'} <ArrowRight size={13} />
            </button>
          )}
          {project && (
            <button disabled={!onOpenProject} onClick={() => onOpenProject?.(project.id)}>
              <FileText size={13} /> {project.name} <ArrowRight size={13} />
            </button>
          )}
        </div>
      )}
      {record.body &&
        (record.kind === 'review' || record.kind === 'note' ? (
          <div className="assistant-record-markdown">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[[rehypeKatex, { trust: false, throwOnError: false }]]}
              skipHtml
              urlTransform={safeMarkdownUrl}
              components={{
                img: () => (
                  <span className="assistant-blocked-image">Image omitted from AI draft.</span>
                ),
                a: ({ href, children }) =>
                  href ? (
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {children}
                    </a>
                  ) : (
                    <span>{children}</span>
                  ),
              }}
            >
              {record.kind === 'review' ? readableReview(record.body) : record.body}
            </ReactMarkdown>
          </div>
        ) : (
          <p className="assistant-record-body">{record.body}</p>
        ))}
      {!!record.tags.length && (
        <div className="assistant-proposed-tags" aria-label="Proposed Atlas tags">
          {record.tags.map((tag) => (
            <div className="assistant-proposed-tag" key={tag.name}>
              <strong># {tag.name}</strong>
              <span>{tag.description || 'No description supplied.'}</span>
            </div>
          ))}
        </div>
      )}
      {record.candidate && (
        <div className="assistant-candidate">
          <span className="assistant-candidate-label">EXTERNAL CANDIDATE · NOT IN ZOTERO</span>
          <strong>{record.candidate.title}</strong>
          <span>
            {record.candidate.authors.join(', ') || 'Unknown author'}
            {record.candidate.year ? ` · ${record.candidate.year}` : ''}
          </span>
          {record.candidate.abstract && <p>{record.candidate.abstract}</p>}
          {candidateUrl && (
            <a href={candidateUrl} target="_blank" rel="noopener noreferrer">
              Open source <ExternalLink size={13} />
            </a>
          )}
          <small>Add this paper in Zotero, then sync Atlas to include it in your library.</small>
        </div>
      )}
      {!!record.citations.length && (
        <details className="assistant-evidence">
          <summary>
            <ChevronDown size={14} /> Evidence ({record.citations.length})
          </summary>
          <div>
            {record.citations.map((citation) => (
              <blockquote key={citation.chunkId}>
                <strong>
                  {citation.title || citation.sourceId}
                  {citation.page !== null ? ` · p. ${citation.page}` : ''}
                </strong>
                <p>{citation.quote}</p>
              </blockquote>
            ))}
          </div>
        </details>
      )}
      <div className="assistant-record-footer">
        <div className="assistant-record-provenance">
          <span>
            {record.agent.name || 'Assistant'}
            {record.agent.model ? ` · ${record.agent.model}` : ''}
          </span>
          <time dateTime={record.createdAt}>Proposed {dateLabel(record.createdAt)}</time>
        </div>
        {record.status === 'pending' && !hideDecision && (
          <div className="assistant-decision-actions">
            <button disabled={busy} onClick={() => void decide(false)}>
              <X size={14} /> Reject
            </button>
            <button className="assistant-approve" disabled={busy} onClick={() => void decide(true)}>
              {busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}
              Approve
            </button>
          </div>
        )}
      </div>
      {record.status === 'pending' && record.kind === 'recommendation' && (
        <small className="assistant-status-hint">
          {record.paperId && record.projectId
            ? 'Approval links this paper to the project. Reading and archive status stay the same.'
            : 'Approval records this recommendation. Reading and archive status stay the same.'}
        </small>
      )}
      {record.status === 'pending' && record.kind === 'tags' && (
        <small className="assistant-status-hint">
          {record.paperId || record.projectId
            ? 'Approval adds these tags to the Atlas vocabulary and assigns them to the linked paper or project.'
            : 'Approval adds these tags to the Atlas vocabulary.'}
        </small>
      )}
      {record.status === 'pending' && record.kind === 'note' && (
        <small className="assistant-status-hint">
          Approval adds this draft to the project notebook as an AI note.
        </small>
      )}
      {record.status === 'pending' && record.kind === 'profile' && (
        <small className="assistant-status-hint">
          Approval replaces the current research profile with this proposal.
        </small>
      )}
      {error && (
        <div className="assistant-inline-error" role="alert">
          {error}
        </div>
      )}
    </article>
  );
}

interface RecordListProps extends Omit<RecordCardProps, 'record'> {
  records: AIRecord[];
  empty: string;
}

export function AIRecordList({ records, empty, ...props }: RecordListProps) {
  if (!records.length) return <p className="assistant-empty-records">{empty}</p>;
  return (
    <div className="assistant-record-list">
      {records.map((record) => (
        <AIRecordCard key={record.id} record={record} {...props} />
      ))}
    </div>
  );
}

interface RecommendationsProps extends Omit<RecordCardProps, 'record'> {
  records: AIRecord[];
}

export function InboxRecommendations({ records, ...props }: RecommendationsProps) {
  const [strength, setStrength] = useState<'all' | NonNullable<AIRecord['level']>>('all');
  const recommendations = records
    .filter(
      (record) =>
        record.kind === 'recommendation' && !record.projectId && record.status !== 'rejected',
    )
    .sort(compareRecommendationStrength);
  if (!recommendations.length) return null;
  const visible =
    strength === 'all'
      ? recommendations
      : recommendations.filter((record) => record.level === strength);
  return (
    <section className="assistant-inbox-recommendations" aria-label="Assistant recommendations">
      <div className="assistant-section-heading">
        <div>
          <span className="eyebrow">ASSISTANT RECOMMENDATIONS</span>
          <h2>Worth a closer look</h2>
          <p>Ranked proposals from your connected AI client. Your reading status stays yours.</p>
        </div>
        <span className="assistant-count">{recommendations.length}</span>
      </div>
      <div className="assistant-strength-filters" aria-label="Filter recommendation strength">
        {(['all', 'essential', 'recommended', 'optional'] as const).map((value) => (
          <button
            key={value}
            className={strength === value ? 'active' : ''}
            aria-pressed={strength === value}
            onClick={() => setStrength(value)}
          >
            {value === 'all' ? 'All' : levelLabel(value)}
            <span>
              {value === 'all'
                ? recommendations.length
                : recommendations.filter((record) => record.level === value).length}
            </span>
          </button>
        ))}
      </div>
      <div className="assistant-recommendation-grid">
        {visible.length ? (
          visible.map((record) => (
            <AIRecordCard key={record.id} record={record} compact {...props} />
          ))
        ) : (
          <p className="assistant-no-strength-match">No {strength} recommendations yet.</p>
        )}
      </div>
    </section>
  );
}

interface PageProps {
  data: AssistantSnapshot | null;
  loading: boolean;
  error: string | null;
  papers: Paper[];
  projects: Project[];
  profileDraft: string | null;
  onProfileDraftChange: (value: string | null) => void;
  onRefresh: () => Promise<void>;
  onZoteroChanged: () => Promise<void>;
  onDecision: (id: string, approve: boolean) => Promise<void>;
  onSaveProfile: (text: string) => Promise<void>;
  onRebuildIndex: () => Promise<void>;
  onOpenPaper: (id: string) => void;
  onOpenProject: (id: string) => void;
}

export function AssistantPage({
  data,
  loading,
  error,
  papers,
  projects,
  profileDraft,
  onProfileDraftChange,
  onRefresh,
  onZoteroChanged,
  onDecision,
  onSaveProfile,
  onRebuildIndex,
  onOpenPaper,
  onOpenProject,
}: PageProps) {
  const [profileBusy, setProfileBusy] = useState(false);
  const [indexBusy, setIndexBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const profileValue = profileDraft ?? data?.profile.text ?? '';
  const profileDirty = profileDraft !== null && profileDraft !== (data?.profile.text ?? '');
  const pending = useMemo(
    () => data?.records.filter((record) => record.status === 'pending') ?? [],
    [data?.records],
  );
  const decided = useMemo(
    () => data?.records.filter((record) => record.status !== 'pending') ?? [],
    [data?.records],
  );

  const saveProfile = async () => {
    setProfileBusy(true);
    setActionError(null);
    setActionSuccess(null);
    try {
      await onSaveProfile(profileValue);
      setActionSuccess('Profile saved.');
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Could not save profile.');
    } finally {
      setProfileBusy(false);
    }
  };

  const rebuildIndex = async () => {
    setIndexBusy(true);
    setActionError(null);
    setActionSuccess(null);
    try {
      await onRebuildIndex();
      setActionSuccess('Indexing started. Status updates here automatically.');
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Could not update index.');
    } finally {
      setIndexBusy(false);
    }
  };

  return (
    <div className="assistant-page">
      <div className="page-heading assistant-page-heading">
        <div>
          <div className="eyebrow">RESEARCH WITH CONTROL</div>
          <h1>Assistant</h1>
          <p>Set your research focus and review AI proposals before they affect your workspace.</p>
        </div>
        <button
          className="assistant-refresh"
          onClick={() => void onRefresh().catch(() => undefined)}
          disabled={loading}
        >
          <RefreshCw size={15} className={loading ? 'spin' : ''} /> Refresh
        </button>
      </div>
      {error && (
        <div className="assistant-page-error" role="alert">
          <AlertCircle size={16} /> {error}
        </div>
      )}
      {actionError && (
        <div className="assistant-page-error" role="alert">
          <AlertCircle size={16} /> {actionError}
        </div>
      )}
      {actionSuccess && (
        <div className="assistant-page-success" role="status">
          <Check size={16} /> {actionSuccess}
        </div>
      )}
      {!data ? (
        loading ? (
          <div className="loading-view">
            <LoaderCircle className="spin" size={25} /> Loading Assistant…
          </div>
        ) : (
          <div className="assistant-unavailable">
            <Sparkles size={24} />
            <h2>Assistant is unavailable</h2>
            <p>Retry to load your profile, index status, and review queue.</p>
            <button
              className="assistant-small-action"
              onClick={() => void onRefresh().catch(() => undefined)}
            >
              <RefreshCw size={15} /> Retry
            </button>
          </div>
        )
      ) : (
        <>
          <div className="assistant-top-grid">
            <section className="assistant-surface assistant-profile">
              <div className="assistant-section-heading">
                <div>
                  <span className="eyebrow">HUMAN DIRECTION</span>
                  <h2>Research profile</h2>
                  <p>Describe your interests, methods, and what makes a paper useful to you.</p>
                </div>
              </div>
              <textarea
                aria-label="Research profile"
                value={profileValue}
                disabled={profileBusy}
                onChange={(event) => {
                  onProfileDraftChange(event.target.value);
                  setActionSuccess(null);
                }}
                placeholder="I study… I prefer papers that… Current questions…"
                rows={7}
              />
              <div className="assistant-profile-footer">
                <span>
                  {profileDirty
                    ? 'Unsaved profile changes'
                    : data?.profile.updatedAt
                      ? `Saved ${dateLabel(data.profile.updatedAt)}`
                      : 'No profile saved yet'}
                </span>
                <button
                  className="primary-button"
                  disabled={!profileDirty || profileBusy}
                  onClick={() => void saveProfile()}
                >
                  {profileBusy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}
                  {profileBusy ? 'Saving…' : 'Save profile'}
                </button>
              </div>
            </section>
            <div className="assistant-side-stack">
              <section className="assistant-surface">
                <div className="assistant-section-heading">
                  <div>
                    <span className="eyebrow">RETRIEVAL</span>
                    <h2>Research index</h2>
                    <p>Metadata and PDF text available to your connected assistant.</p>
                  </div>
                </div>
                <div className="assistant-index-stats">
                  <span>
                    <strong>{data?.index.documents ?? 0}</strong> documents
                  </span>
                  <span>
                    <strong>{data?.index.chunks ?? 0}</strong> chunks
                  </span>
                  <span>
                    <strong>{data?.index.pdfPages ?? 0}</strong> PDF pages
                  </span>
                </div>
                <div className="assistant-index-footer">
                  <span>
                    {data?.index.indexing
                      ? 'Indexing library and PDFs…'
                      : dateLabel(data?.index.indexedAt ?? null)}
                  </span>
                  <button
                    className="assistant-small-action"
                    disabled={indexBusy || !!data?.index.indexing}
                    onClick={() => void rebuildIndex()}
                  >
                    {indexBusy || data?.index.indexing ? (
                      <LoaderCircle size={15} className="spin" />
                    ) : (
                      <SearchCheck size={15} />
                    )}
                    {indexBusy || data?.index.indexing ? 'Indexing…' : 'Rebuild index'}
                  </button>
                </div>
                {!!data?.index.pdfErrors.length && (
                  <details className="assistant-index-errors">
                    <summary>
                      {data.index.pdfErrors.length} PDF indexing issue
                      {data.index.pdfErrors.length === 1 ? '' : 's'}
                    </summary>
                    <ul>
                      {data.index.pdfErrors.map((item, index) => (
                        <li key={`${index}-${item}`}>{item}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </section>
              <section className="assistant-surface assistant-workflow">
                <div className="assistant-section-heading">
                  <div>
                    <span className="eyebrow">HOW IT WORKS</span>
                    <h2>Use your local AI client</h2>
                  </div>
                </div>
                <ol>
                  <li>Build the Atlas index.</li>
                  <li>
                    Connect a Claude or other MCP client using the Atlas setup guide, then ask it to
                    propose reviews, tags, or notes.
                  </li>
                  <li>Approve proposals here. Your own summaries and notes stay separate.</li>
                </ol>
              </section>
            </div>
          </div>
          {data.zotero && <ZoteroActions zotero={data.zotero} onRefresh={onZoteroChanged} />}
          <section className="assistant-queue">
            <div className="assistant-section-heading">
              <div>
                <span className="eyebrow">YOUR DECISIONS</span>
                <h2>Review queue</h2>
                <p>Nothing is applied until you approve it.</p>
              </div>
              <span className="assistant-count">{pending.length}</span>
            </div>
            <AIRecordList
              records={pending}
              empty="No proposals are waiting for review."
              papers={papers}
              projects={projects}
              onDecision={onDecision}
              onOpenPaper={onOpenPaper}
              onOpenProject={onOpenProject}
            />
          </section>
          {!!decided.length && (
            <details className="assistant-history">
              <summary>Decision history ({decided.length})</summary>
              <AIRecordList
                records={decided}
                empty=""
                papers={papers}
                projects={projects}
                onDecision={onDecision}
                onOpenPaper={onOpenPaper}
                onOpenProject={onOpenProject}
              />
            </details>
          )}
        </>
      )}
    </div>
  );
}
