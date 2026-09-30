import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  LoaderCircle,
  MessageSquareQuote,
  Plus,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Annotation, Attachment, Paper } from '../shared/types';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type Props = { paper: Paper; attachment: Attachment; onClose: () => void };
const colors = ['#d3dcb9', '#f1dfb4', '#d8d5e7', '#eaccc3'];

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
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
      /* Keep status message. */
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export default function PdfReader({ paper, attachment, onClose }: Props) {
  const [document, setDocument] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(1.15);
  const [pdfLoading, setPdfLoading] = useState(true);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [annotationError, setAnnotationError] = useState<string | null>(null);
  const [annotationLoading, setAnnotationLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [quote, setQuote] = useState('');
  const [color, setColor] = useState(colors[0]);
  const [notesOpen, setNotesOpen] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const fileUrl = `/api/attachments/${encodeURIComponent(attachment.id)}/file?paperId=${encodeURIComponent(paper.id)}`;

  useEffect(() => {
    const priorFocus =
      globalThis.document.activeElement instanceof HTMLElement
        ? globalThis.document.activeElement
        : null;
    closeRef.current?.focus();
    return () => priorFocus?.focus();
  }, []);

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    let task: pdfjs.PDFDocumentLoadingTask | null = null;
    setPdfLoading(true);
    setPdfError(null);
    setDocument(null);
    setPageNumber(1);
    void (async () => {
      try {
        const response = await fetch(fileUrl, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) {
          let message = `Unable to open this PDF (${response.status}).`;
          try {
            const body = (await response.json()) as { error?: string };
            if (body.error) message = body.error;
          } catch {
            /* Keep the HTTP status. */
          }
          throw new Error(message);
        }
        const data = await response.arrayBuffer();
        if (disposed) return;
        task = pdfjs.getDocument({ data: new Uint8Array(data) });
        const next = await task.promise;
        if (disposed) return;
        setDocument(next);
      } catch (error) {
        if (disposed || (error instanceof Error && error.name === 'AbortError')) return;
        setPdfError(error instanceof Error ? error.message : 'Unable to open this PDF.');
      } finally {
        if (!disposed) setPdfLoading(false);
      }
    })();
    return () => {
      disposed = true;
      controller.abort();
      void task?.destroy();
    };
  }, [fileUrl]);

  useEffect(() => {
    if (!document || !canvasRef.current) return;
    let disposed = false;
    let renderTask: ReturnType<pdfjs.PDFPageProxy['render']> | null = null;
    setPageError(null);
    document
      .getPage(pageNumber)
      .then((page) => {
        if (disposed || !canvasRef.current) return;
        const canvas = canvasRef.current;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas is unavailable.');
        const density = Math.min(window.devicePixelRatio || 1, 2);
        const view = page.getViewport({ scale: zoom });
        canvas.width = Math.floor(view.width * density);
        canvas.height = Math.floor(view.height * density);
        canvas.style.width = `${Math.floor(view.width)}px`;
        canvas.style.height = `${Math.floor(view.height)}px`;
        renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport: page.getViewport({ scale: zoom * density }),
        });
        return renderTask.promise;
      })
      .catch((error) => {
        if (disposed || error?.name === 'RenderingCancelledException') return;
        setPageError(error instanceof Error ? error.message : 'Could not render this page.');
      });
    return () => {
      disposed = true;
      renderTask?.cancel();
    };
  }, [document, pageNumber, zoom]);

  useEffect(() => {
    let disposed = false;
    setAnnotationLoading(true);
    setAnnotationError(null);
    jsonRequest<Annotation[]>(`/api/papers/${encodeURIComponent(paper.id)}/annotations`)
      .then((items) => {
        if (!disposed) setAnnotations(items.filter((item) => item.attachmentId === attachment.id));
      })
      .catch((error) => {
        if (!disposed)
          setAnnotationError(error instanceof Error ? error.message : 'Could not load page notes.');
      })
      .finally(() => {
        if (!disposed) setAnnotationLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [paper.id, attachment.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      const target = event.target as HTMLElement;
      if (target.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === 'ArrowLeft') setPageNumber((current) => Math.max(1, current - 1));
      if (event.key === 'ArrowRight')
        setPageNumber((current) => Math.min(document?.numPages ?? current, current + 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [document?.numPages, onClose]);

  const addNote = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!note.trim() || saving || pdfLoading || pdfError) return;
    setSaving(true);
    setAnnotationError(null);
    try {
      const item = await jsonRequest<Annotation>(
        `/api/papers/${encodeURIComponent(paper.id)}/annotations`,
        {
          method: 'POST',
          body: JSON.stringify({
            attachmentId: attachment.id,
            page: pageNumber,
            text: note.trim(),
            quote: quote.trim(),
            color,
          }),
        },
      );
      setAnnotations((previous) => [...previous, item]);
      setNote('');
      setQuote('');
    } catch (error) {
      setAnnotationError(error instanceof Error ? error.message : 'Could not save this page note.');
    } finally {
      setSaving(false);
    }
  };

  const deleteNote = async (id: string) => {
    setDeleting(id);
    setAnnotationError(null);
    try {
      await jsonRequest<{ ok: true }>(`/api/annotations/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      setAnnotations((previous) => previous.filter((item) => item.id !== id));
    } catch (error) {
      setAnnotationError(
        error instanceof Error ? error.message : 'Could not delete this page note.',
      );
    } finally {
      setDeleting(null);
    }
  };

  const pageNotes = annotations.filter((item) => item.page === pageNumber);
  const goToPage = (value: number) =>
    setPageNumber(Math.max(1, Math.min(document?.numPages ?? 1, value)));

  return (
    <div
      className="reader-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`PDF reader: ${paper.title}`}
    >
      <div className="reader-topbar">
        <div className="reader-ident">
          <button
            ref={closeRef}
            className="reader-back"
            onClick={onClose}
            aria-label="Close PDF reader"
          >
            <ArrowLeft size={19} />
          </button>
          <div className="reader-file-icon">
            <FileText size={19} />
          </div>
          <div className="reader-title">
            <strong>{paper.title || 'Untitled paper'}</strong>
            <span>{attachment.title || attachment.filename || 'PDF document'}</span>
          </div>
        </div>
        <div className="reader-top-actions">
          <a
            className="reader-icon"
            href={fileUrl}
            download={attachment.filename || undefined}
            aria-label="Download PDF"
            title="Download PDF"
          >
            <Download size={18} />
          </a>
          <button
            className={`reader-notes-toggle${notesOpen ? ' active' : ''}`}
            onClick={() => setNotesOpen((value) => !value)}
            aria-pressed={notesOpen}
          >
            <MessageSquareQuote size={17} />
            <span>Page notes</span>
            <span className="reader-note-count">{annotations.length}</span>
          </button>
          <button className="reader-icon reader-close" onClick={onClose} aria-label="Close reader">
            <X size={19} />
          </button>
        </div>
      </div>
      <div className="reader-body">
        <div className="reader-document-area">
          <div className="reader-controls">
            <div className="page-controls">
              <button
                onClick={() => goToPage(pageNumber - 1)}
                disabled={!document || pageNumber <= 1}
                aria-label="Previous page"
              >
                <ChevronLeft size={18} />
              </button>
              <span>
                <strong>{pageNumber}</strong> / {document?.numPages ?? '—'}
              </span>
              <button
                onClick={() => goToPage(pageNumber + 1)}
                disabled={!document || pageNumber >= document.numPages}
                aria-label="Next page"
              >
                <ChevronRight size={18} />
              </button>
            </div>
            <div className="zoom-controls">
              <button
                onClick={() =>
                  setZoom((value) => Math.max(0.55, Math.round((value - 0.15) * 100) / 100))
                }
                disabled={zoom <= 0.55}
                aria-label="Zoom out"
              >
                <ZoomOut size={17} />
              </button>
              <span>{Math.round(zoom * 100)}%</span>
              <button
                onClick={() =>
                  setZoom((value) => Math.min(2.5, Math.round((value + 0.15) * 100) / 100))
                }
                disabled={zoom >= 2.5}
                aria-label="Zoom in"
              >
                <ZoomIn size={17} />
              </button>
            </div>
          </div>
          <div className="pdf-scroll">
            {pdfLoading ? (
              <div className="reader-state">
                <LoaderCircle size={28} className="spin" />
                <h2>Opening PDF…</h2>
                <p>Preparing your document.</p>
              </div>
            ) : pdfError ? (
              <div className="reader-state reader-error">
                <AlertCircle size={30} />
                <h2>PDF unavailable</h2>
                <p>{pdfError}</p>
                <p>The attachment may have moved or may no longer be available in Zotero.</p>
                <a href={fileUrl} target="_blank" rel="noreferrer">
                  Try opening the file directly
                </a>
              </div>
            ) : (
              <div className="pdf-page-wrap">
                {pageError && (
                  <div className="pdf-page-error" role="alert">
                    <AlertCircle size={16} />
                    {pageError}
                  </div>
                )}
                <canvas
                  ref={canvasRef}
                  aria-label={`Page ${pageNumber} of ${document?.numPages ?? 0}`}
                />
              </div>
            )}
          </div>
        </div>
        {notesOpen && (
          <aside className="reader-annotations" aria-label="Page notes">
            <div className="annotations-head">
              <div>
                <span className="section-label">READING NOTES</span>
                <h2>Page {pageNumber}</h2>
              </div>
              <button
                className="reader-icon notes-close"
                onClick={() => setNotesOpen(false)}
                aria-label="Close page notes"
              >
                <X size={18} />
              </button>
            </div>
            <div className="annotations-scroll">
              <p className="annotation-help">
                Keep a thought or typed quote attached to this page. These notes do not mark or
                highlight the PDF itself.
              </p>
              {annotationError && (
                <div className="annotation-error" role="alert">
                  <AlertCircle size={15} />
                  {annotationError}
                </div>
              )}
              <div className="annotation-list">
                {annotationLoading ? (
                  <div className="annotation-empty">
                    <LoaderCircle size={18} className="spin" /> Loading notes…
                  </div>
                ) : pageNotes.length ? (
                  pageNotes.map((item) => (
                    <div
                      className="annotation-card"
                      key={item.id}
                      style={{ borderLeftColor: item.color || colors[0] }}
                    >
                      <div className="annotation-card-top">
                        <span>PAGE {item.page}</span>
                        <button
                          onClick={() => void deleteNote(item.id)}
                          disabled={deleting === item.id}
                          aria-label="Delete page note"
                          title="Delete note"
                        >
                          {deleting === item.id ? (
                            <LoaderCircle size={15} className="spin" />
                          ) : (
                            <Trash2 size={15} />
                          )}
                        </button>
                      </div>
                      {item.quote && <blockquote>“{item.quote}”</blockquote>}
                      <p>{item.text}</p>
                    </div>
                  ))
                ) : (
                  <div className="annotation-empty">
                    <MessageSquareQuote size={21} />
                    <span>No notes on this page yet.</span>
                  </div>
                )}
              </div>
              <form className="annotation-form" onSubmit={(event) => void addNote(event)}>
                <div className="section-label">ADD A PAGE NOTE</div>
                <label>
                  Quote <span>optional, type or paste text</span>
                  <textarea
                    rows={3}
                    value={quote}
                    onChange={(event) => setQuote(event.target.value)}
                    placeholder="A passage you want to remember…"
                    disabled={pdfLoading || !!pdfError}
                  />
                </label>
                <label>
                  Your note
                  <textarea
                    rows={4}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="What does this bring to mind?"
                    required
                    disabled={pdfLoading || !!pdfError}
                  />
                </label>
                <div className="annotation-form-bottom">
                  <div className="color-swatches" aria-label="Note color">
                    {colors.map((item) => (
                      <button
                        type="button"
                        key={item}
                        className={color === item ? 'selected' : ''}
                        style={{ backgroundColor: item }}
                        onClick={() => setColor(item)}
                        aria-label={`Select ${item} note color`}
                        aria-pressed={color === item}
                        disabled={pdfLoading || !!pdfError}
                      />
                    ))}
                  </div>
                  <button
                    className="add-note-button"
                    type="submit"
                    disabled={!note.trim() || saving || pdfLoading || !!pdfError}
                  >
                    {saving ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}
                    {saving ? 'Saving…' : 'Add note'}
                  </button>
                </div>
              </form>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
