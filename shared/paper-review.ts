import type { AIRecord } from './assistant.ts';

export function latestPaperReview(records: AIRecord[], paperId: string): AIRecord | null {
  return (
    records
      .filter(
        (record) =>
          record.kind === 'review' && record.paperId === paperId && record.status !== 'rejected',
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0] ?? null
  );
}
