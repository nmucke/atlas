import { useEffect, useState } from 'react';
import { FileText, RefreshCw, ChevronRight } from 'lucide-react';
import type { Attachment } from '../shared/types';

type Availability = { state: 'available' | 'missing' | 'empty' | 'unknown'; message: string };
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Attachment request failed');
  return data;
}
export function PaperAttachments({
  attachments,
  onRead,
  onVisibilityChange,
}: {
  attachments: Attachment[];
  onRead: (id: string) => void;
  onVisibilityChange: (id: string, hidden: boolean) => void;
}) {
  const [states, setStates] = useState<Record<string, Availability>>({});
  const [hidden, setHidden] = useState(
    () => new Set(attachments.filter((a) => a.hidden).map((a) => a.id)),
  );
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ids = attachments.map((a) => a.id).join('|');
  useEffect(() => {
    let cancelled = false;
    setStates({});
    void (async () => {
      for (const id of ids.split('|').filter(Boolean)) {
        if (cancelled) break;
        const value = await request<Availability>(
          `/api/attachments/${encodeURIComponent(id)}/availability`,
        ).catch((e) => ({ state: 'unknown' as const, message: String(e.message) }));
        if (!cancelled) setStates((previous) => ({ ...previous, [id]: value }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ids, revision]);
  const unavailable = (id: string) => ['missing', 'empty'].includes(states[id]?.state);
  const changeVisibility = async (id: string, value: boolean) => {
    setBusy(true);
    setError('');
    try {
      await request(`/api/attachments/${encodeURIComponent(id)}/visibility`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: value }),
      });
      setHidden((previous) => {
        const next = new Set(previous);
        if (value) next.add(id);
        else next.delete(id);
        return next;
      });
      onVisibilityChange(id, value);
      if (!value) setRevision((value) => value + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to change visibility');
    } finally {
      setBusy(false);
    }
  };
  const row = (item: Attachment) => {
    const state = states[item.id];
    const pdf =
      item.contentType.toLowerCase().includes('pdf') ||
      item.filename.toLowerCase().endsWith('.pdf');
    return (
      <div className="attachment-row" key={item.id}>
        <div className="attachment-icon">
          <FileText size={19} />
        </div>
        <div className="attachment-copy">
          <strong>{item.title || item.filename || 'Attachment'}</strong>
          <span title={state?.message}>
            {state?.state === 'missing'
              ? 'File not downloaded'
              : state?.state === 'empty'
                ? 'Empty local file'
                : state?.state === 'available'
                  ? pdf
                    ? 'PDF document'
                    : item.contentType || 'File'
                  : state?.message || 'Checking local file…'}
          </span>
          {state?.state === 'available' && !pdf && <span>Open this attachment in Zotero.</span>}
          {pdf && state?.state === 'available' && !hidden.has(item.id) && (
            <button onClick={() => onRead(item.id)}>Read PDF</button>
          )}
          {(hidden.has(item.id) || unavailable(item.id)) && (
            <button
              disabled={busy}
              onClick={() => void changeVisibility(item.id, !hidden.has(item.id))}
            >
              {hidden.has(item.id) ? 'Restore' : 'Hide in Atlas'}
            </button>
          )}
        </div>
      </div>
    );
  };
  const available = attachments.filter((a) => !hidden.has(a.id) && !unavailable(a.id));
  const missing = attachments.filter((a) => !hidden.has(a.id) && unavailable(a.id));
  const removed = attachments.filter((a) => hidden.has(a.id));
  return (
    <div className="inspector-section paper-attachments">
      <div className="attachment-heading">
        <div className="section-label">ATTACHMENTS</div>
        <button disabled={busy} onClick={() => setRevision((value) => value + 1)}>
          <RefreshCw size={12} /> Recheck
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {available.map(row)}
      {!!missing.length && (
        <details className="attachment-group">
          <summary>
            <ChevronRight size={13} /> Unavailable locally <span>{missing.length}</span>
          </summary>
          <p>Download in Zotero and recheck, or hide these entries. Zotero records are kept.</p>
          {missing.map(row)}
        </details>
      )}
      {!!removed.length && (
        <details className="attachment-group">
          <summary>
            <ChevronRight size={13} /> Hidden attachments <span>{removed.length}</span>
          </summary>
          {removed.map(row)}
        </details>
      )}
    </div>
  );
}
