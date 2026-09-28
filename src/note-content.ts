export function isProjectFigure(url: string, projectId: string): boolean {
  const prefix = `/api/projects/${encodeURIComponent(projectId)}/assets/`;
  return url.startsWith(prefix) && /^[a-zA-Z0-9-]+$/.test(url.slice(prefix.length));
}
export function noteUrl(url: string, projectId: string, image: boolean): string {
  if (image) return isProjectFigure(url, projectId) ? url : '';
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
  } catch {
    return url.startsWith('#') ? url : '';
  }
}
