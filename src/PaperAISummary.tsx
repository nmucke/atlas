import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import type { AIRecord } from '../shared/assistant';
import { latestPaperReview } from '../shared/paper-review';
import { readableReview } from '../shared/review-text';

function safeMarkdownUrl(value: string, key: string) {
  if (key === 'src') return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

export function PaperAISummary({ records, paperId }: { records: AIRecord[]; paperId: string }) {
  const review = latestPaperReview(records, paperId);

  return (
    <div className="inspector-section ai-summary-section">
      <div className="section-label">
        <span>AI SUMMARY</span>
        <span className="private-label">AI GENERATED · READ ONLY</span>
      </div>
      {review ? (
        <>
          <div className="assistant-record-markdown ai-summary-body">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[[rehypeKatex, { trust: false, throwOnError: false }]]}
              skipHtml
              urlTransform={safeMarkdownUrl}
              components={{
                img: () => (
                  <span className="assistant-blocked-image">Image omitted from AI summary.</span>
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
              {readableReview(review.body)}
            </ReactMarkdown>
          </div>
          <small className="ai-summary-source">
            {review.agent.name || 'Assistant'} ·{' '}
            {review.status === 'approved' ? 'Approved review' : 'Proposed review'}
          </small>
        </>
      ) : (
        <p className="ai-summary-empty">No AI summary yet.</p>
      )}
    </div>
  );
}
