import { useState } from 'react';
import { AlertCircle, Check, ExternalLink, LoaderCircle, RefreshCw, Trash2, X } from 'lucide-react';
import type { ZoteroAction } from '../shared/zotero-workflow';

export interface ZoteroStatus {
  version: string | null;
  reachable: boolean;
  writesSupported: boolean; // false when this Zotero can sync but predates local writes
  authorized: boolean;
  automaticPdfWrites: boolean;
  actions: ZoteroAction[];
}

async function post(path: string, body?: unknown) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (response.ok) return;
  let message = `Request failed (${response.status})`;
  try {
    const result = (await response.json()) as { error?: string };
    if (result.error) message = result.error;
  } catch {
    /* Keep the HTTP error. */
  }
  throw new Error(message);
}

function safeUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function Preview({
  label,
  paperId,
  item,
}: {
  label: string;
  paperId: string;
  item: NonNullable<ZoteroAction['preview']>['trash'];
}) {
  return (
    <div className="zotero-preview-item">
      <span className="eyebrow">{label}</span>
      <strong>{item.title}</strong>
      <span>Zotero item: {paperId}</span>
      {item.doi && <span>DOI: {item.doi}</span>}
      <span>
        Children:{' '}
        {item.children.length
          ? item.children
              .map((child) => `${child.title || 'Untitled'} (${child.type} · ${child.key})`)
              .join(', ')
          : 'None'}
      </span>
      <span>Tags: {item.tags.join(', ') || 'None'}</span>
      <span>Collections: {item.collections.join(', ') || 'None'}</span>
      <span>Atlas summary: {item.atlasSummary || 'None'}</span>
      <span>Atlas notes: {item.atlasNotes || 'None'}</span>
      <span>Projects: {item.projects.join(', ') || 'None'}</span>
    </div>
  );
}

function statusLabel(status: ZoteroAction['status']) {
  if (status === 'write_done') return 'Zotero updated · Atlas sync pending';
  if (status === 'completed') return 'Completed';
  if (status === 'failed') return 'Failed';
  if (status === 'rejected') return 'Rejected';
  if (status === 'running') return 'Running';
  return 'Awaiting approval';
}

export function ZoteroActions({
  zotero,
  onRefresh,
}: {
  zotero: ZoteroStatus;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (key: string, path: string, body?: unknown) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await post(path, body);
      try {
        await onRefresh();
      } catch {
        setNotice('Action saved, but status could not refresh. Use Refresh to check it.');
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not complete Zotero action.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="assistant-surface zotero-actions" aria-label="Zotero actions">
      <div className="assistant-section-heading">
        <div>
          <span className="eyebrow">LOCAL LIBRARY</span>
          <h2>Zotero actions</h2>
          <p>Review duplicate cleanup and track PDF additions to your Zotero library.</p>
        </div>
        <span className="assistant-count">
          {zotero.actions.filter((action) => action.status === 'pending').length}
        </span>
      </div>
      <div className="zotero-connection">
        <span>
          {zotero.reachable
            ? `Zotero connected${zotero.version ? ` · ${zotero.version}` : ''}`
            : 'Zotero is unavailable'}
        </span>
        {zotero.writesSupported && (
          <span>{zotero.authorized ? 'Local writes enabled' : 'Local writes disabled'}</span>
        )}
        {zotero.writesSupported && zotero.authorized && (
          <span>
            {zotero.automaticPdfWrites
              ? 'Automatic PDF additions enabled'
              : 'Automatic PDF additions disabled'}
          </span>
        )}
      </div>
      {zotero.reachable && !zotero.writesSupported ? (
        <div className="zotero-auth">
          <p>
            Update Zotero to use write actions (Add to Zotero, attach PDF, trash duplicates).
            Library sync and PDF reading still work with this version.
          </p>
        </div>
      ) : (
        !zotero.automaticPdfWrites && (
          <div className="zotero-auth">
            <p>
              {zotero.authorized
                ? 'To allow agent PDF additions, update your Zotero permission.'
                : 'Enable local Zotero writes to add PDFs and carry out duplicate decisions.'}{' '}
              Choose <strong>Always Allow</strong> in the authorization prompt for automatic PDF
              additions.
            </p>
            <button
              className="assistant-small-action"
              disabled={busy !== null || !zotero.reachable}
              onClick={() => void run('authorize', '/api/zotero/authorize')}
            >
              {busy === 'authorize' ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Check size={15} />
              )}
              {zotero.authorized ? 'Enable automatic PDF additions' : 'Enable Zotero writes'}
            </button>
          </div>
        )
      )}
      {error && (
        <div className="assistant-inline-error" role="alert">
          <AlertCircle size={15} /> {error}
        </div>
      )}
      {notice && (
        <div className="assistant-page-success" role="status">
          {notice}
        </div>
      )}
      {zotero.actions.length ? (
        <div className="zotero-action-list">
          {zotero.actions.map((action) => {
            const source = safeUrl(action.sourceUrl);
            const pdf = safeUrl(action.pdfUrl);
            const pendingTrash = action.kind === 'trash' && action.status === 'pending';
            const retryable = action.status === 'failed' || action.status === 'write_done';
            return (
              <article className="zotero-action-card" key={action.id}>
                <div className="zotero-action-heading">
                  <div>
                    <span className="eyebrow">
                      {action.kind === 'trash' ? 'DUPLICATE REVIEW' : 'PDF ADDITION'}
                    </span>
                    <h3>{action.title}</h3>
                  </div>
                  <span className={`zotero-action-status zotero-status-${action.status}`}>
                    {statusLabel(action.status)}
                  </span>
                </div>
                {action.reason && <p>{action.reason}</p>}
                {action.kind === 'pdf' && (
                  <div className="zotero-action-details">
                    <span>
                      Requested by {action.agent.name || 'Assistant'}
                      {action.agent.model ? ` · ${action.agent.model}` : ''}
                    </span>
                    <span>
                      PDF source:{' '}
                      {source ? (
                        <a href={source} target="_blank" rel="noopener noreferrer">
                          Open source <ExternalLink size={12} />
                        </a>
                      ) : (
                        action.sourceUrl || 'Not supplied'
                      )}
                    </span>
                    <span>
                      PDF:{' '}
                      {pdf ? (
                        <a href={pdf} target="_blank" rel="noopener noreferrer">
                          Open PDF <ExternalLink size={12} />
                        </a>
                      ) : (
                        action.pdfUrl || 'Not supplied'
                      )}
                    </span>
                    <span>License: {action.license || 'Not specified'}</span>
                  </div>
                )}
                {action.kind === 'trash' && action.preview && (
                  <div className="zotero-preview-grid">
                    <Preview
                      label="TRASH IN ZOTERO"
                      paperId={action.paperId}
                      item={action.preview.trash}
                    />
                    <Preview
                      label="KEEP"
                      paperId={action.keepPaperId || 'Unknown'}
                      item={action.preview.keep}
                    />
                  </div>
                )}
                {action.error && (
                  <div className="assistant-inline-error" role="alert">
                    <AlertCircle size={15} /> {action.error}
                  </div>
                )}
                <div className="zotero-action-footer">
                  <span>
                    {action.agent.name || 'Assistant'} ·{' '}
                    {new Date(action.createdAt).toLocaleString()}
                  </span>
                  <div className="zotero-action-buttons">
                    {pendingTrash && (
                      <>
                        <button
                          disabled={busy !== null}
                          onClick={() =>
                            void run(
                              action.id,
                              `/api/zotero/actions/${encodeURIComponent(action.id)}/decision`,
                              { approve: false },
                            )
                          }
                        >
                          <X size={14} /> Keep both
                        </button>
                        <button
                          className="zotero-trash-button"
                          disabled={busy !== null || !zotero.authorized || !action.preview}
                          onClick={() =>
                            void run(
                              action.id,
                              `/api/zotero/actions/${encodeURIComponent(action.id)}/decision`,
                              { approve: true },
                            )
                          }
                        >
                          {busy === action.id ? (
                            <LoaderCircle size={14} className="spin" />
                          ) : (
                            <Trash2 size={14} />
                          )}{' '}
                          Trash duplicate
                        </button>
                      </>
                    )}
                    {retryable && (
                      <button
                        disabled={
                          busy !== null || (action.status === 'failed' && !zotero.authorized)
                        }
                        onClick={() =>
                          void run(
                            action.id,
                            `/api/zotero/actions/${encodeURIComponent(action.id)}/retry`,
                          )
                        }
                      >
                        {busy === action.id ? (
                          <LoaderCircle size={14} className="spin" />
                        ) : (
                          <RefreshCw size={14} />
                        )}{' '}
                        {action.status === 'write_done' ? 'Retry Atlas sync' : 'Retry'}
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="assistant-empty-records">No Zotero actions yet.</p>
      )}
    </section>
  );
}
