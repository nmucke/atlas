import type { AIRecord } from './assistant.ts';
import type { Project } from './types.ts';

function newestFirst(a: AIRecord, b: AIRecord) {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

/**
 * The newest scored review per paper, highest scores first. A rejected newest review dismisses
 * the paper instead of falling back to an older assessment.
 */
export function readingRecommendations(records: AIRecord[]): AIRecord[] {
  const seen = new Set<string>();
  const latest: AIRecord[] = [];
  for (const record of [...records].sort(newestFirst)) {
    if (record.kind !== 'review' || !record.paperId || !record.readingRecommendation) continue;
    if (seen.has(record.paperId)) continue;
    seen.add(record.paperId);
    if (record.status !== 'rejected') latest.push(record);
  }
  return latest.sort(
    (a, b) => b.readingRecommendation!.score - a.readingRecommendation!.score || newestFirst(a, b),
  );
}

export const readingScoreLabels: Record<number, string> = {
  1: 'Not recommended',
  2: 'Low priority',
  3: 'Worth considering',
  4: 'Recommended',
  5: 'Strongly recommended',
};

export type ReadingTier = 'top' | 'consider' | 'low';

export function readingTier(score: number): ReadingTier {
  if (score >= 4) return 'top';
  if (score >= 3) return 'consider';
  return 'low';
}

const strengthRank = { essential: 0, recommended: 1, optional: 2 } as const;
export function compareRecommendationStrength(a: AIRecord, b: AIRecord) {
  const rank = (value: AIRecord['level']) => (value ? strengthRank[value] : 3);
  return (
    rank(a.level) - rank(b.level) ||
    b.createdAt.localeCompare(a.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

export interface ProjectFit {
  record: AIRecord;
  project: Project | null;
  /** The paper is already in the project, whatever happened to this suggestion. */
  linked: boolean;
}

/**
 * Suggested project links per paper: the latest non-rejected suggestion for each project,
 * strongest first.
 */
export function projectFitsByPaper(
  records: AIRecord[],
  projects: Project[],
): Map<string, ProjectFit[]> {
  const latest = new Map<string, AIRecord>();
  for (const record of [...records].sort(newestFirst)) {
    if (record.kind !== 'recommendation' || !record.paperId || !record.projectId) continue;
    const key = `${record.paperId}\u0000${record.projectId}`;
    if (latest.has(key)) continue;
    latest.set(key, record);
  }
  const fits = new Map<string, ProjectFit[]>();
  for (const record of [...latest.values()].sort(compareRecommendationStrength)) {
    if (record.status === 'rejected') continue;
    const project = projects.find((item) => item.id === record.projectId) ?? null;
    const list = fits.get(record.paperId!) ?? [];
    list.push({ record, project, linked: !!project?.paperIds.includes(record.paperId!) });
    fits.set(record.paperId!, list);
  }
  return fits;
}
