import type { AIRecord } from './assistant.ts';

export function readingRecommendations(records: AIRecord[]): AIRecord[] {
  const latest = new Map<string, AIRecord>();
  for (const record of [...records].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  )) {
    if (
      record.kind !== 'review' ||
      !record.paperId ||
      !record.readingRecommendation ||
      record.status === 'rejected'
    )
      continue;
    if (!latest.has(record.paperId)) latest.set(record.paperId, record);
  }
  return [...latest.values()].sort(
    (a, b) =>
      b.readingRecommendation!.score - a.readingRecommendation!.score ||
      b.createdAt.localeCompare(a.createdAt),
  );
}
