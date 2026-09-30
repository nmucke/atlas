import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { AIRecord } from '../shared/assistant';
import type { Paper, Project } from '../shared/types';
import { readingRecommendations } from '../shared/recommendations';
import { AIRecordCard } from './Assistant';

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
}: Props) {
  const [score, setScore] = useState(0);
  const recommendations = readingRecommendations(records);
  const visible = recommendations.filter(
    (record) => !score || record.readingRecommendation!.score === score,
  );
  return (
    <div className="assistant-page">
      <div className="page-heading assistant-page-heading">
        <div>
          <div className="eyebrow">YOUR READING LIST</div>
          <h1>Recommendations</h1>
          <p>The latest reading assessment for each reviewed paper, highest scores first.</p>
        </div>
        <button
          className="assistant-refresh"
          disabled={loading}
          onClick={() => void onRefresh().catch(() => undefined)}
        >
          <RefreshCw size={15} className={loading ? 'spin' : ''} /> Refresh
        </button>
      </div>
      <p className="assistant-score-guide">
        1 · Not recommended · 2 · Low priority · 3 · Worth considering · 4 · Recommended · 5 ·
        Strongly recommended
      </p>
      <div className="assistant-strength-filters" aria-label="Filter reading score">
        {[0, 5, 4, 3, 2, 1].map((value) => (
          <button
            key={value}
            className={score === value ? 'active' : ''}
            aria-pressed={score === value}
            onClick={() => setScore(value)}
          >
            {value ? `${value}/5` : 'All scores'}
          </button>
        ))}
      </div>
      {error && (
        <div className="assistant-page-error" role="alert">
          {error}
        </div>
      )}
      {loading && !records.length ? (
        <p role="status">Loading recommendations…</p>
      ) : (
        <div className="assistant-record-list">
          {visible.map((record) => (
            <div key={record.id} className="assistant-reading-card">
              <h2>
                <button onClick={() => onOpenPaper(record.paperId!)}>
                  {papers.find((paper) => paper.id === record.paperId)?.title || record.title}
                </button>
              </h2>
              <strong className="assistant-reading-score">
                {record.readingRecommendation!.score}/5
              </strong>
              <p>{record.readingRecommendation!.reason}</p>
              <small>
                AI assessment · {record.agent.name} · {record.agent.model} ·{' '}
                {new Date(record.createdAt).toLocaleDateString()}
              </small>
              <section className="assistant-project-fits" aria-label="Suggested projects">
                <h3>Project fit</h3>
                {records
                  .filter(
                    (item) =>
                      item.kind === 'recommendation' &&
                      item.paperId === record.paperId &&
                      item.projectId &&
                      item.status !== 'rejected',
                  )
                  .map((item) => (
                    <AIRecordCard
                      key={item.id}
                      record={item}
                      projects={projects}
                      compact
                      onDecision={onDecision}
                      onOpenProject={onOpenProject}
                    />
                  ))}
                {!records.some(
                  (item) =>
                    item.kind === 'recommendation' &&
                    item.paperId === record.paperId &&
                    item.projectId &&
                    item.status !== 'rejected',
                ) && <p>No project suggestions saved for this paper.</p>}
              </section>
              <details>
                <summary>Review and evidence</summary>
                <AIRecordCard
                  record={record}
                  papers={papers}
                  onDecision={onDecision}
                  onOpenPaper={onOpenPaper}
                />
              </details>
            </div>
          ))}
          {!visible.length && !error && (
            <p className="assistant-empty-records">
              {recommendations.length
                ? 'No papers with this score yet.'
                : 'No reading recommendations yet. Ask the paper reviewer to review a paper and save its reading score.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
