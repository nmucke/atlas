import { useMemo, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  FileText,
  FolderClosed,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import type { AIRecord } from '../shared/assistant';
import type { Paper, Project, ReadingStatus } from '../shared/types';
import {
  projectFitsByPaper,
  readingRecommendations,
  readingScoreLabels,
  readingTier,
  type ProjectFit,
  type ReadingTier,
} from '../shared/recommendations';
import { AIRecordCard } from './Assistant';
import './news.css';

interface Props {
  records: AIRecord[];
  papers: Paper[];
  projects: Project[];
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
  onDecision: (id: string, approve: boolean) => Promise<void>;
  onOpenPaper: (id: string) => void;
  onOpenProject: (id: string) => void;
  onOpenAssistant: () => void;
  onSetStatus: (paper: Paper, status: ReadingStatus) => Promise<void>;
  onReadPdf: (paper: Paper) => void;
}

interface Recommendation {
  record: AIRecord;
  paper: Paper;
  score: number;
}

const sections: { id: ReadingTier; title: string; hint: string }[] = [
  { id: 'top', title: 'TOP PICKS', hint: 'Scored 4–5 by your assistant' },
  { id: 'consider', title: 'WORTH CONSIDERING', hint: 'Scored 3' },
  { id: 'low', title: 'LOW PRIORITY', hint: 'Scored 1–2' },
];

const levelLabels = { essential: 'Essential', recommended: 'Recommended', optional: 'Optional' };

const statusLabels: Record<ReadingStatus, string> = {
  inbox: 'In inbox',
  reading: 'Reading',
  read: 'Read',
};

function authorLine(paper: Paper) {
  const names = paper.authors.filter(Boolean);
  if (!names.length) return 'Unknown author';
  if (names.length <= 2) return names.join(' · ');
  return `${names[0]} et al.`;
}

function hasPdf(paper: Paper) {
  return paper.attachments.some(
    (item) =>
      !item.hidden &&
      (item.contentType.toLowerCase().includes('pdf') ||
        item.filename.toLowerCase().endsWith('.pdf')),
  );
}

// Filters survive opening a paper and coming back; storage may be unavailable.
const filterKey = 'atlas.recommendations.filters';
function storedFilters(): { score: number; showFinished: boolean } {
  try {
    const value = JSON.parse(sessionStorage.getItem(filterKey) ?? '{}') as Record<string, unknown>;
    return {
      score: typeof value.score === 'number' && value.score in readingScoreLabels ? value.score : 0,
      showFinished: value.showFinished === true,
    };
  } catch {
    return { score: 0, showFinished: false };
  }
}

function errorText(caught: unknown, fallback: string) {
  return caught instanceof Error ? caught.message : fallback;
}

export function Recommendations({
  records,
  papers,
  projects,
  loading,
  error,
  onRefresh,
  onDecision,
  onOpenPaper,
  onOpenProject,
  onOpenAssistant,
  onSetStatus,
  onReadPdf,
}: Props) {
  const [filters, setFilters] = useState(storedFilters);
  const { score, showFinished } = filters;
  const updateFilters = (patch: Partial<typeof filters>) => {
    const next = { ...filters, ...patch };
    setFilters(next);
    try {
      sessionStorage.setItem(filterKey, JSON.stringify(next));
    } catch {
      /* Keep the filters for this visit only. */
    }
  };
  const [refreshing, setRefreshing] = useState(false);

  // Reviews of papers that left the library cannot be opened, so they are not listed.
  const all = useMemo(() => {
    const byId = new Map(papers.map((paper) => [paper.id, paper]));
    return readingRecommendations(records).flatMap((record): Recommendation[] => {
      const paper = byId.get(record.paperId!);
      return paper ? [{ record, paper, score: record.readingRecommendation!.score }] : [];
    });
  }, [records, papers]);
  const fits = useMemo(() => projectFitsByPaper(records, projects), [records, projects]);

  const finished = all.filter((item) => item.paper.archived || item.paper.status === 'read');
  const candidates = showFinished ? all : all.filter((item) => !finished.includes(item));
  const visible = score ? candidates.filter((item) => item.score === score) : candidates;
  const grouped = sections
    .map((section) => ({
      ...section,
      items: visible.filter((item) => readingTier(item.score) === section.id),
    }))
    .filter((section) => section.items.length);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } catch {
      /* The hook reports the error. */
    } finally {
      setRefreshing(false);
    }
  };
  const busy = refreshing || (loading && !records.length);

  return (
    <div className="assistant-page">
      <div className="page-heading assistant-page-heading assistant-reading-heading">
        <div>
          <div className="eyebrow">YOUR READING LIST</div>
          <h1>Recommendations</h1>
          <p>Your assistant’s latest reading score for each reviewed paper, best first.</p>
        </div>
        <button
          className="assistant-refresh"
          disabled={busy}
          aria-busy={busy}
          onClick={() => void refresh()}
        >
          <RefreshCw size={15} className={busy ? 'spin' : ''} /> Refresh
        </button>
      </div>
      {error && (
        <div className="assistant-page-error" role="alert">
          {error}
        </div>
      )}
      {loading && !records.length ? (
        <p className="assistant-empty-records" role="status">
          Loading recommendations…
        </p>
      ) : !all.length ? (
        !error && (
          <div className="assistant-reading-empty">
            <Sparkles size={20} />
            <h2>No reading recommendations yet</h2>
            <p>
              Ask your connected assistant to run <code>atlas-review-paper</code> on a paper, or{' '}
              <code>atlas-reading-recommendations</code> to score your inbox. Each review saves a
              1–5 reading score that appears here.
            </p>
            <button className="assistant-small-action" onClick={onOpenAssistant}>
              Set up the assistant <ArrowRight size={13} />
            </button>
          </div>
        )
      ) : (
        <>
          <div className="assistant-reading-controls">
            <div
              className="assistant-strength-filters"
              role="group"
              aria-label="Filter by reading score"
            >
              {[0, 5, 4, 3, 2, 1].map((value) => {
                const count = value
                  ? candidates.filter((item) => item.score === value).length
                  : candidates.length;
                const label = value ? `${value} – ${readingScoreLabels[value]}` : 'All scores';
                return (
                  <button
                    key={value}
                    className={score === value ? 'active' : ''}
                    aria-pressed={score === value}
                    aria-label={`${label}, ${count} ${count === 1 ? 'paper' : 'papers'}`}
                    title={value ? readingScoreLabels[value] : undefined}
                    onClick={() => updateFilters({ score: value })}
                  >
                    {value ? `${value}/5` : 'All'}
                    <span>{count}</span>
                  </button>
                );
              })}
            </div>
            {!!finished.length && (
              <label className="assistant-reading-toggle">
                <input
                  type="checkbox"
                  checked={showFinished}
                  onChange={(event) => updateFilters({ showFinished: event.target.checked })}
                />
                Show read and archived ({finished.length})
              </label>
            )}
          </div>
          <p className="assistant-score-guide">1 = not recommended · 5 = strongly recommended</p>
          {grouped.map((section) => (
            <section key={section.id} aria-labelledby={`reading-${section.id}`}>
              <div className="news-section-head">
                <h2 id={`reading-${section.id}`}>{section.title}</h2>
                <p>{section.hint}</p>
              </div>
              <div className="news-feed">
                {section.items.map((item) => (
                  <RecommendationCard
                    key={item.record.id}
                    item={item}
                    fits={fits.get(item.paper.id) ?? []}
                    onDecision={onDecision}
                    onOpenPaper={onOpenPaper}
                    onOpenProject={onOpenProject}
                    onSetStatus={onSetStatus}
                    onReadPdf={onReadPdf}
                  />
                ))}
              </div>
            </section>
          ))}
          {!visible.length && (
            <div className="assistant-empty-records">
              {score
                ? `No ${showFinished ? '' : 'unread '}papers scored ${score}/5.`
                : 'Every recommended paper is read or archived.'}{' '}
              {score ? (
                <button
                  className="assistant-reading-link"
                  onClick={() => updateFilters({ score: 0 })}
                >
                  Show all scores
                </button>
              ) : (
                <button
                  className="assistant-reading-link"
                  onClick={() => updateFilters({ showFinished: true })}
                >
                  Show them
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

interface CardProps {
  item: Recommendation;
  fits: ProjectFit[];
  onDecision: (id: string, approve: boolean) => Promise<void>;
  onOpenPaper: (id: string) => void;
  onOpenProject: (id: string) => void;
  onSetStatus: (paper: Paper, status: ReadingStatus) => Promise<void>;
  onReadPdf: (paper: Paper) => void;
}

function RecommendationCard({
  item: { record, paper, score },
  fits,
  onDecision,
  onOpenPaper,
  onOpenProject,
  onSetStatus,
  onReadPdf,
}: CardProps) {
  const [busy, setBusy] = useState<'reading' | 'dismiss' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const titleId = `reading-title-${record.id}`;
  const run = async (kind: 'reading' | 'dismiss', action: () => Promise<void>) => {
    setBusy(kind);
    setProblem(null);
    try {
      await action();
    } catch (caught) {
      setProblem(errorText(caught, 'Could not update this recommendation.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="news-card assistant-reading-card" aria-labelledby={titleId}>
      <div className="news-card-body">
        <div className="news-topline">
          <span className={`assistant-reading-score assistant-reading-score-${readingTier(score)}`}>
            {score}/5 · {readingScoreLabels[score] ?? 'Scored'}
          </span>
          <span className={`status-pill status-${paper.status}`}>{statusLabels[paper.status]}</span>
          {paper.archived && <span className="status-pill status-archived">Archived</span>}
          {paper.year && <span>{paper.year}</span>}
        </div>
        <h3 className="news-title assistant-reading-title">
          <button id={titleId} onClick={() => onOpenPaper(paper.id)}>
            {paper.title || record.title || 'Untitled paper'}
          </button>
        </h3>
        <div className="news-byline">
          {[authorLine(paper), paper.publication].filter(Boolean).join(' · ')}
        </div>
        <p className="news-why">
          <b>WHY READ THIS</b>
          {record.readingRecommendation!.reason}
        </p>
        <section className="assistant-project-fits" aria-label="Project fit">
          <h4>PROJECT FIT</h4>
          {fits.length ? (
            fits.map((fit) => (
              <FitRow
                key={fit.record.id}
                fit={fit}
                onDecision={onDecision}
                onOpenProject={onOpenProject}
              />
            ))
          ) : (
            <p className="assistant-reading-hint">No project suggestions saved for this paper.</p>
          )}
        </section>
        <div className="news-actions">
          <button className="news-btn primary" onClick={() => onOpenPaper(paper.id)}>
            <BookOpen size={13} /> Open paper
          </button>
          {paper.status === 'inbox' && (
            <button
              className="news-btn"
              disabled={!!busy}
              onClick={() => void run('reading', () => onSetStatus(paper, 'reading'))}
            >
              {busy === 'reading' ? (
                <LoaderCircle size={13} className="spin" />
              ) : (
                <Check size={13} />
              )}
              Mark as reading
            </button>
          )}
          {hasPdf(paper) && (
            <button className="news-btn" onClick={() => onReadPdf(paper)}>
              <FileText size={13} /> Read PDF
            </button>
          )}
          <span className="news-spacer" />
          {record.status === 'pending' && (
            <button
              className="news-btn ghost"
              disabled={!!busy}
              title="Reject this review and remove the paper from Recommendations"
              onClick={() => void run('dismiss', () => onDecision(record.id, false))}
            >
              {busy === 'dismiss' ? <LoaderCircle size={13} className="spin" /> : <X size={13} />}
              Dismiss
            </button>
          )}
        </div>
        {problem && (
          <div className="assistant-inline-error" role="alert">
            {problem}
          </div>
        )}
        <div className="assistant-record-provenance assistant-reading-provenance">
          <span>
            AI assessment · {record.agent.name || 'Assistant'}
            {record.agent.model ? ` · ${record.agent.model}` : ''}
          </span>
          <time dateTime={record.createdAt}>
            Reviewed {new Date(record.createdAt).toLocaleDateString()}
          </time>
        </div>
        <details className="assistant-evidence assistant-reading-review">
          <summary>
            <ChevronDown size={14} /> Review and evidence
          </summary>
          <AIRecordCard record={record} hideDecision hideVerdict onDecision={onDecision} />
        </details>
      </div>
    </article>
  );
}

function FitRow({
  fit: { record, project, linked },
  onDecision,
  onOpenProject,
}: {
  fit: ProjectFit;
  onDecision: (id: string, approve: boolean) => Promise<void>;
  onOpenProject: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const name = project?.name || 'Unknown project';
  const decide = async (approve: boolean) => {
    setBusy(true);
    setProblem(null);
    try {
      await onDecision(record.id, approve);
    } catch (caught) {
      setProblem(errorText(caught, 'Could not record this decision.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="assistant-fit-row">
      <div className="assistant-fit-main">
        <div className="assistant-fit-head">
          {project ? (
            <button className="news-chip-project" onClick={() => onOpenProject(project.id)}>
              <FolderClosed size={12} /> {name}
            </button>
          ) : (
            <span className="assistant-fit-unknown">{name}</span>
          )}
          {record.level && (
            <span className={`assistant-level assistant-level-${record.level}`}>
              {levelLabels[record.level]}
            </span>
          )}
        </div>
        {record.body && <p>{record.body}</p>}
        {problem && (
          <div className="assistant-inline-error" role="alert">
            {problem}
          </div>
        )}
      </div>
      <div className="assistant-fit-actions">
        {linked ? (
          <span className="assistant-fit-linked">
            <Check size={12} /> {record.status === 'approved' ? 'Linked' : 'Already in project'}
          </span>
        ) : record.status === 'approved' ? (
          <span className="assistant-fit-linked">Approved</span>
        ) : project ? (
          <>
            <button
              className="news-btn icon ghost"
              disabled={busy}
              aria-label={`Reject suggestion for ${name}`}
              title="Not a fit"
              onClick={() => void decide(false)}
            >
              <X size={13} />
            </button>
            <button
              className="news-btn"
              disabled={busy}
              aria-label={`Approve: add this paper to ${name}`}
              onClick={() => void decide(true)}
            >
              {busy ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}
              Approve
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
