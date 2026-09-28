import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  Check,
  Download,
  ExternalLink,
  FileText,
  FolderClosed,
  Github,
  LoaderCircle,
  Plus,
  Search,
  X,
} from 'lucide-react';
import type { Paper, Project, ProjectDetail, ProjectStatus, Tag } from '../shared/types';
import { AIRecordList, compareRecommendationStrength, type AIRecord } from './Assistant';
import { ProjectNotes } from './ProjectNotes';
import './projects.css';

interface Props {
  projectId: string | null;
  projects: Project[];
  papers: Paper[];
  tags: Tag[];
  loading: boolean;
  loadError: string | null;
  onRetry: () => void;
  onOpen: (id: string | null) => void;
  onProjectsChanged: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  assistantRecords: AIRecord[];
  onAssistantDecision: (id: string, approve: boolean) => Promise<void>;
}

type ProjectDraft = Pick<
  Project,
  'id' | 'name' | 'summary' | 'tags' | 'githubUrl' | 'overleafUrl' | 'status' | 'paperIds'
>;
type Tab = 'overview' | 'notes' | 'papers' | 'assistant';

function draftFrom(project: Project): ProjectDraft {
  return {
    id: project.id,
    name: project.name,
    summary: project.summary,
    tags: [...project.tags],
    githubUrl: project.githubUrl,
    overleafUrl: project.overleafUrl,
    status: project.status,
    paperIds: [...project.paperIds],
  };
}

function projectChanged(draft: ProjectDraft, saved: Project) {
  return (
    draft.name !== saved.name ||
    draft.summary !== saved.summary ||
    draft.status !== saved.status ||
    draft.githubUrl !== saved.githubUrl ||
    draft.overleafUrl !== saved.overleafUrl ||
    JSON.stringify(draft.tags) !== JSON.stringify(saved.tags) ||
    JSON.stringify(draft.paperIds) !== JSON.stringify(saved.paperIds)
  );
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

function statusLabel(status: ProjectStatus) {
  return status === 'active' ? 'Active' : status === 'paused' ? 'Paused' : 'Completed';
}

function countLabel(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function validProjectUrl(value: string, kind: 'github' | 'overleaf') {
  if (!value.trim()) return true;
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== 'https:' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return false;
    if (kind === 'github')
      return (
        url.hostname === 'github.com' &&
        /^\/[A-Za-z0-9-]+\/(?!\.{1,2}\/?$)[A-Za-z0-9._-]+\/?$/.test(url.pathname)
      );
    return (
      url.hostname === 'www.overleaf.com' &&
      /^\/(project|read)\/[A-Za-z0-9]+\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <div className="project-error" role="alert">
      <AlertCircle size={16} />
      <span>{message}</span>
    </div>
  );
}

export function Projects({
  projectId,
  projects,
  papers,
  tags,
  loading,
  loadError,
  onRetry,
  onOpen,
  onProjectsChanged,
  onDirtyChange,
  assistantRecords,
  onAssistantDecision,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProjectDraft | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [paperQuery, setPaperQuery] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refreshDetail = useCallback(async () => {
    if (!projectId) return;
    const next = await request<ProjectDetail>(`/api/projects/${encodeURIComponent(projectId)}`);
    setDetail(next);
    setDetailError(null);
    setDraft((previous) => (previous?.id === projectId ? previous : draftFrom(next.project)));
    await onProjectsChanged();
  }, [projectId, onProjectsChanged]);

  useEffect(() => {
    if (!projectId) {
      setDetail(null);
      setDraft(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setDraft(null);
    setDetailLoading(true);
    setDetailError(null);
    setSaveError(null);
    setExportError(null);
    setTab('overview');
    void request<ProjectDetail>(`/api/projects/${encodeURIComponent(projectId)}`)
      .then((next) => {
        if (cancelled) return;
        setDetail(next);
        setDraft(draftFrom(next.project));
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setDetailError(error instanceof Error ? error.message : 'Could not load this project.');
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const currentDraft = draft?.id === projectId ? draft : null;
  const saved = detail?.project.id === projectId ? detail.project : null;
  const dirty = !!currentDraft && !!saved && projectChanged(currentDraft, saved);
  const paperIdsDirty =
    !!currentDraft &&
    !!saved &&
    JSON.stringify(currentDraft.paperIds) !== JSON.stringify(saved.paperIds);
  const projectAIRecords = assistantRecords
    .filter(
      (record) =>
        record.projectId === projectId &&
        (record.kind === 'recommendation' || record.kind === 'note' || record.kind === 'tags') &&
        record.status !== 'rejected',
    )
    .sort(compareRecommendationStrength);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const change = <K extends keyof ProjectDraft>(key: K, value: ProjectDraft[K]) => {
    setDraft((previous) => (previous ? { ...previous, [key]: value } : previous));
    setSaveError(null);
    if (key === 'paperIds') setExportError(null);
  };

  const createProject = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) {
      setCreateError('Give this project a name.');
      return;
    }
    setCreateBusy(true);
    setCreateError(null);
    try {
      const next = await request<Project>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      await onProjectsChanged();
      if (!mounted.current) return;
      setCreating(false);
      setNewName('');
      onOpen(next.id);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Could not create project.');
    } finally {
      setCreateBusy(false);
    }
  };

  const save = async () => {
    if (!currentDraft || !saved || !dirty) return;
    if (!currentDraft.name.trim()) {
      setSaveError('Project name is required.');
      setTab('overview');
      return;
    }
    if (!validProjectUrl(currentDraft.githubUrl, 'github')) {
      setSaveError('Use an HTTPS GitHub repository URL, such as github.com/owner/repo.');
      setTab('overview');
      return;
    }
    if (!validProjectUrl(currentDraft.overleafUrl, 'overleaf')) {
      setSaveError('Use an Overleaf project or read link from www.overleaf.com.');
      setTab('overview');
      return;
    }
    const submitted = {
      name: currentDraft.name.trim(),
      summary: currentDraft.summary,
      tags: currentDraft.tags,
      status: currentDraft.status,
      githubUrl: currentDraft.githubUrl.trim(),
      overleafUrl: currentDraft.overleafUrl.trim(),
      paperIds: currentDraft.paperIds,
    };
    setSaving(true);
    setSaveError(null);
    try {
      const next = await request<Project>(`/api/projects/${encodeURIComponent(saved.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(submitted),
      });
      setDetail((previous) => (previous ? { ...previous, project: next } : previous));
      setDraft((previous) => {
        if (!previous || previous.id !== next.id) return previous;
        return projectChanged(previous, { ...next, ...submitted }) ? previous : draftFrom(next);
      });
      await onProjectsChanged();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not save project.');
    } finally {
      setSaving(false);
    }
  };

  const addTag = () => {
    const name = tagInput.trim();
    if (!name || !currentDraft) return;
    if (!currentDraft.tags.some((item) => item.toLocaleLowerCase() === name.toLocaleLowerCase()))
      change('tags', [...currentDraft.tags, name]);
    setTagInput('');
  };

  const exportBibtex = async () => {
    if (!saved) return;
    if (paperIdsDirty) {
      setExportError('Save paper changes before exporting BibTeX. The export uses saved papers.');
      return;
    }
    setExporting(true);
    setExportError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(saved.id)}/bibtex`);
      if (!response.ok) {
        let message = `BibTeX export failed (${response.status}).`;
        try {
          const body = (await response.json()) as { error?: string };
          if (body.error) message = body.error;
        } catch {
          /* Keep the HTTP error. */
        }
        throw new Error(message);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const filename = `${
        saved.name
          .trim()
          .replace(/[^a-z0-9_-]+/gi, '-')
          .replace(/^-|-$/g, '') || 'project'
      }.bib`;
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'Could not export BibTeX.');
    } finally {
      setExporting(false);
    }
  };

  const filteredPapers = useMemo(() => {
    const query = paperQuery.trim().toLocaleLowerCase();
    return papers
      .filter((paper) =>
        [paper.title, ...paper.authors, paper.year, paper.publication]
          .join(' ')
          .toLocaleLowerCase()
          .includes(query),
      )
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [papers, paperQuery]);

  if (!projectId) {
    return (
      <div className="projects-page">
        <div className="page-heading projects-heading">
          <div>
            <div className="eyebrow">YOUR RESEARCH SPACE</div>
            <h1>Projects</h1>
            <p>Bring papers, notes, and research links together.</p>
          </div>
          <button className="primary-button" onClick={() => setCreating(true)}>
            <Plus size={17} /> New project
          </button>
        </div>
        {loadError && (
          <div className="projects-load-error">
            <ErrorMessage message={loadError} />
            <button className="project-text-button" onClick={onRetry}>
              Retry
            </button>
          </div>
        )}
        {creating && (
          <form className="project-create-card" onSubmit={(event) => void createProject(event)}>
            <div className="project-create-header">
              <div>
                <span className="project-kicker">NEW PROJECT</span>
                <h2>What are you working on?</h2>
              </div>
              <button
                type="button"
                className="project-icon-button"
                aria-label="Close"
                onClick={() => {
                  setCreating(false);
                  setCreateError(null);
                }}
              >
                <X size={17} />
              </button>
            </div>
            <label className="project-field">
              <span>Project name</span>
              <input
                autoFocus
                value={newName}
                onChange={(event) => {
                  setNewName(event.target.value);
                  setCreateError(null);
                }}
                placeholder="e.g. Urban heat mapping"
                maxLength={160}
              />
            </label>
            {createError && <ErrorMessage message={createError} />}
            <button className="primary-button" type="submit" disabled={createBusy}>
              {createBusy ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />}
              {createBusy ? 'Creating…' : 'Create project'}
            </button>
          </form>
        )}
        {loading && !projects.length ? (
          <div className="loading-view">
            <LoaderCircle className="spin" size={25} /> Loading projects…
          </div>
        ) : projects.length ? (
          <div className="project-card-grid">
            {projects.map((project) => (
              <button className="project-card" key={project.id} onClick={() => onOpen(project.id)}>
                <span className="project-card-top">
                  <span className="project-card-icon">
                    <FolderClosed size={21} />
                  </span>
                  <span className={`project-status project-status-${project.status}`}>
                    {statusLabel(project.status)}
                  </span>
                </span>
                <strong>{project.name}</strong>
                <span className="project-card-summary">
                  {project.summary || 'A space for this research project.'}
                </span>
                {!!project.tags.length && (
                  <span className="project-card-tags">
                    {project.tags.slice(0, 3).map((tag) => (
                      <span className="project-chip" key={tag}>
                        {tag}
                      </span>
                    ))}
                    {project.tags.length > 3 && (
                      <span className="project-chip">+{project.tags.length - 3}</span>
                    )}
                  </span>
                )}
                <span className="project-card-footer">
                  <span>
                    <BookOpen size={15} /> {countLabel(project.paperIds.length, 'paper')}
                  </span>
                  <span>
                    <FileText size={15} /> {countLabel(project.noteCount, 'note')}
                  </span>
                  <ArrowRight size={17} />
                </span>
              </button>
            ))}
          </div>
        ) : !loadError && !creating ? (
          <div className="empty-state project-empty">
            <div className="empty-icon">
              <FolderClosed size={24} />
            </div>
            <h2>Start your first project</h2>
            <p>Collect the papers, notes, and links for a research question in one place.</p>
            <button className="primary-button" onClick={() => setCreating(true)}>
              <Plus size={16} /> New project
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  if (detailLoading || (!detail && !detailError))
    return (
      <div className="loading-view">
        <LoaderCircle className="spin" size={25} /> Loading project…
      </div>
    );
  if (detailError || !saved || !currentDraft)
    return (
      <div className="projects-page">
        <ErrorMessage message={detailError || 'This project could not be opened.'} />
        <button
          className="project-text-button"
          onClick={() => {
            setDetailLoading(true);
            void refreshDetail()
              .catch((error: unknown) =>
                setDetailError(
                  error instanceof Error ? error.message : 'Could not load this project.',
                ),
              )
              .finally(() => setDetailLoading(false));
          }}
        >
          Retry
        </button>
      </div>
    );

  return (
    <div className="projects-page project-detail-page">
      <div className="project-detail-head">
        <div>
          <div className="eyebrow">PROJECT WORKSPACE</div>
          <h1>{saved.name}</h1>
          <p>
            {countLabel(saved.paperIds.length, 'paper')} · {countLabel(saved.noteCount, 'note')}
          </p>
        </div>
        <div className="project-save-controls">
          <span className={dirty ? 'project-unsaved' : 'project-saved'}>
            {dirty ? 'Unsaved changes' : 'Saved'}
          </span>
          <button
            className="primary-button"
            onClick={() => void save()}
            disabled={!dirty || saving}
          >
            {saving ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}
            {saving ? 'Saving…' : 'Save project'}
          </button>
        </div>
      </div>
      {saveError && <ErrorMessage message={saveError} />}
      <div className="project-tabs" role="tablist" aria-label="Project sections">
        {(['overview', 'notes', 'papers', 'assistant'] as Tab[]).map((item) => (
          <button
            key={item}
            role="tab"
            aria-selected={tab === item}
            className={tab === item ? 'active' : ''}
            onClick={() => setTab(item)}
          >
            {item === 'overview'
              ? 'Overview'
              : item === 'notes'
                ? `Notes (${saved.noteCount})`
                : item === 'papers'
                  ? `Papers (${currentDraft.paperIds.length})`
                  : `Assistant (${projectAIRecords.filter((record) => record.status === 'pending').length})`}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="project-overview-grid">
          <section className="project-surface project-main-fields">
            <div className="project-section-intro">
              <h2>Project details</h2>
              <p>The working context for this research.</p>
            </div>
            <label className="project-field">
              <span>Name</span>
              <input
                value={currentDraft.name}
                onChange={(event) => change('name', event.target.value)}
                maxLength={160}
              />
            </label>
            <label className="project-field">
              <span>Status</span>
              <select
                value={currentDraft.status}
                onChange={(event) => change('status', event.target.value as ProjectStatus)}
              >
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="completed">Completed</option>
              </select>
            </label>
            <label className="project-field">
              <span>Summary</span>
              <textarea
                value={currentDraft.summary}
                onChange={(event) => change('summary', event.target.value)}
                rows={6}
                placeholder="What question is this project exploring?"
              />
            </label>
          </section>
          <div className="project-side-fields">
            <section className="project-surface">
              <div className="project-section-intro">
                <h2>Atlas tags</h2>
                <p>Group this project with your research themes.</p>
              </div>
              <div className="project-tag-list">
                {currentDraft.tags.map((name) => (
                  <span className="project-chip" key={name}>
                    {name}
                    <button
                      aria-label={`Remove ${name}`}
                      onClick={() =>
                        change(
                          'tags',
                          currentDraft.tags.filter((item) => item !== name),
                        )
                      }
                    >
                      <X size={13} />
                    </button>
                  </span>
                ))}
                {!currentDraft.tags.length && <span className="project-muted">No tags yet</span>}
              </div>
              <div className="project-add-row">
                <input
                  aria-label="Add Atlas tag"
                  list="project-tag-suggestions"
                  value={tagInput}
                  onChange={(event) => setTagInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addTag();
                    }
                  }}
                  placeholder="Add a tag…"
                />
                <button
                  className="project-small-button"
                  onClick={addTag}
                  disabled={!tagInput.trim()}
                >
                  <Plus size={15} /> Add
                </button>
              </div>
              <datalist id="project-tag-suggestions">
                {tags
                  .filter((tag) => tag.origin === 'atlas')
                  .map((tag) => (
                    <option key={tag.id} value={tag.name} />
                  ))}
              </datalist>
            </section>
            <section className="project-surface">
              <div className="project-section-intro">
                <h2>Research links</h2>
                <p>Saved links to your existing work.</p>
              </div>
              <label className="project-field">
                <span>
                  <Github size={15} /> GitHub repository
                </span>
                <input
                  type="url"
                  value={currentDraft.githubUrl}
                  onChange={(event) => change('githubUrl', event.target.value)}
                  placeholder="https://github.com/owner/repo"
                />
              </label>
              {saved.githubUrl && (
                <a
                  className="project-external-link"
                  href={saved.githubUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open saved repository <ExternalLink size={14} />
                </a>
              )}
              <label className="project-field">
                <span>
                  <FileText size={15} /> Overleaf
                </span>
                <input
                  type="url"
                  value={currentDraft.overleafUrl}
                  onChange={(event) => change('overleafUrl', event.target.value)}
                  placeholder="https://www.overleaf.com/project/…"
                />
              </label>
              {saved.overleafUrl && (
                <a
                  className="project-external-link"
                  href={saved.overleafUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open saved Overleaf link <ExternalLink size={14} />
                </a>
              )}
            </section>
          </div>
        </div>
      )}

      {tab === 'notes' && (
        <div className="project-notes-area">
          <ProjectNotes
            key={projectId}
            projectId={projectId}
            notes={detail?.notes ?? []}
            onChanged={refreshDetail}
          />
        </div>
      )}

      {tab === 'assistant' && (
        <section className="project-assistant-area">
          <div className="project-section-intro">
            <h2>Assistant proposals</h2>
            <p>
              Project recommendations and note drafts from your connected AI client. Approve a note
              to add it to this project’s notebook.
            </p>
          </div>
          <AIRecordList
            records={projectAIRecords}
            empty="No project proposals yet. Ask your connected AI client to suggest papers or draft a note."
            papers={papers}
            onDecision={async (id, approve) => {
              await onAssistantDecision(id, approve);
              await refreshDetail();
            }}
          />
        </section>
      )}

      {tab === 'papers' && (
        <section className="project-surface project-papers-area">
          <div className="project-papers-header">
            <div className="project-section-intro">
              <h2>Project papers</h2>
              <p>Select papers from your Atlas library. Save changes to update this project.</p>
            </div>
            <button
              className="project-small-button"
              onClick={() => void exportBibtex()}
              disabled={exporting || (!saved.paperIds.length && !currentDraft.paperIds.length)}
            >
              {exporting ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}
              {exporting ? 'Exporting…' : 'Export BibTeX'}
            </button>
          </div>
          {exportError && <ErrorMessage message={exportError} />}
          <div className="project-linked-count">
            {countLabel(currentDraft.paperIds.length, 'paper')} in this project
          </div>
          {currentDraft.paperIds.length ? (
            <div className="project-paper-list project-linked-list">
              {currentDraft.paperIds.map((id) => {
                const paper = papers.find((item) => item.id === id);
                return (
                  <div className="project-paper-choice selected" key={id}>
                    <BookOpen size={16} />
                    <span>
                      <strong>{paper?.title || 'Paper unavailable in library'}</strong>
                      <small>
                        {paper
                          ? `${paper.authors.join(', ') || 'Unknown author'}${paper.year ? ` · ${paper.year}` : ''}`
                          : id}
                      </small>
                    </span>
                    <button
                      className="project-icon-button"
                      aria-label={`Remove ${paper?.title || 'paper'} from project`}
                      onClick={() =>
                        change(
                          'paperIds',
                          currentDraft.paperIds.filter((paperId) => paperId !== id),
                        )
                      }
                    >
                      <X size={16} />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="project-paper-empty">No papers linked yet.</div>
          )}
          <div className="project-linked-count">Add from library</div>
          <label className="project-paper-search">
            <Search size={17} />
            <input
              type="search"
              value={paperQuery}
              onChange={(event) => setPaperQuery(event.target.value)}
              placeholder="Search library papers, authors, year…"
              aria-label="Search library papers"
            />
          </label>
          {filteredPapers.some((paper) => !currentDraft.paperIds.includes(paper.id)) ? (
            <div className="project-paper-list">
              {filteredPapers
                .filter((paper) => !currentDraft.paperIds.includes(paper.id))
                .map((paper) => {
                  return (
                    <div className="project-paper-choice" key={paper.id}>
                      <BookOpen size={16} />
                      <span>
                        <strong>{paper.title || 'Untitled paper'}</strong>
                        <small>
                          {paper.authors.join(', ') || 'Unknown author'}
                          {paper.year ? ` · ${paper.year}` : ''}
                          {paper.publication ? ` · ${paper.publication}` : ''}
                        </small>
                      </span>
                      <button
                        className="project-small-button"
                        onClick={() => change('paperIds', [...currentDraft.paperIds, paper.id])}
                        aria-label={`Add ${paper.title || 'paper'} to project`}
                      >
                        <Plus size={15} /> Add
                      </button>
                    </div>
                  );
                })}
            </div>
          ) : (
            <div className="project-paper-empty">
              {papers.length
                ? 'No available papers match that search.'
                : 'Your Atlas library has no papers yet. Sync Zotero to add papers.'}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
