import { Feedback } from "./Feedback.tsx";
import { useEffect, useRef, useState } from "react";
import { HELP_URL } from "./HelpDrawer.tsx";
import type { PaperSource } from "../lib/store.ts";
import { cachedPapers, cachePapers, paperRequest, paperSource, paperUrl, sortPapers, STAGE_LABEL, type PaperRecord } from "../lib/papers.ts";

function remainingLabel(seconds: number) {
  const rounded = Math.ceil(seconds / 5) * 5;
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return minutes ? `About ${minutes}m${remainder ? ` ${remainder}s` : ""} left` : `About ${rounded}s left`;
}

export function Library({ onOpen, gated, contactEmail }: { onOpen(p: PaperSource): void; gated: boolean; contactEmail: string | null }) {
  const [papers, setPapers] = useState<PaperRecord[]>(() => gated ? [] : cachedPapers());
  const papersRef = useRef(papers);
  const submitted = useRef(new Map<string, PaperRecord>());
  const [arxiv, setArxiv] = useState("");
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [syncError, setSyncError] = useState("");
  const merge = (records: PaperRecord[], replace = false) => setPapers((current) => {
    const next = new Map((replace ? [] : current).map((p) => [p.id, p]));
    for (const p of records) {
      const prior = next.get(p.id);
      if (!prior || prior.updatedAt <= p.updatedAt) next.set(p.id, p);
    }
    const sorted = sortPapers([...next.values()]);
    papersRef.current = sorted;
    if (!gated) cachePapers(sorted);
    return sorted;
  });

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let delay = 1000;
    let initial = true;
    const sync = async () => {
      let synced = false;
      try {
        if (initial) {
          const snapshot = await paperRequest<PaperRecord[]>("/api/papers", undefined, controller.signal);
          if (controller.signal.aborted) return;
          // The backend is authoritative; preserve submissions made during the request.
          merge([...snapshot, ...submitted.current.values()], true);
          submitted.current.clear();
          initial = false;
        } else {
          for (const p of papersRef.current.filter((p) => p.status === "processing")) {
            const record = await paperRequest<PaperRecord>(paperUrl(p.id), undefined, controller.signal);
            if (controller.signal.aborted) return;
            merge([record]);
          }
        }
        setSyncError(""); setLoading(false); synced = true;
      } catch (e) {
        if (controller.signal.aborted) return;
        setLoading(false); setSyncError(`Could not refresh the library: ${(e as Error).message} Showing saved records, if available. Retrying automatically.`);
      }
      if (!controller.signal.aborted) {
        const interval = synced && papersRef.current.some((p) => p.status === "processing") ? Math.min(delay, 2500) : delay;
        timer = setTimeout(sync, interval);
        delay = Math.min(delay * 1.6, 15000);
      }
    };
    void sync();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setErr("");
    try { const record = await paperRequest<PaperRecord>("/api/papers", { arxiv }); submitted.current.set(record.id, record); merge([record]); setArxiv(""); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const retry = async (id: string) => {
    setRetrying((ids) => [...ids, id]); setErr("");
    try { const record = await paperRequest<PaperRecord>(`${paperUrl(id)}/retry`, {}); submitted.current.set(record.id, record); merge([record]); }
    catch (e) { setErr((e as Error).message); }
    finally { setRetrying((ids) => ids.filter((p) => p !== id)); }
  };
  const cards = (list: PaperRecord[]) => <div className="paper-grid">{list.map((p) => {
    const processing = p.status === "processing";
    const remaining = !syncError ? p.progress?.estimatedRemainingSeconds : null;
    const fraction = !syncError ? p.progress?.fraction : null;
    return <article key={p.id} className={`paper-card ${p.status}`} data-paper-id={p.id} aria-busy={processing || undefined}>
      <span className="paper-source">{p.arxivId ? `arXiv ${p.arxivId}` : "Example"}</span>
      {p.status === "ready"
        ? <button className="paper-title" onClick={() => onOpen(paperSource(p))}>{p.title}</button>
        : <span className="paper-title">{p.title}</span>}
      <span className="paper-authors">{p.authors}</span>
      {p.abstract && <details><summary>Abstract</summary><p>{p.abstract}</p></details>}
      {processing && <div className="paper-progress">
        <div className="paper-progress-label">
          <span role="status">{STAGE_LABEL[p.stage]}…</span>
          {remaining != null && <span>{remainingLabel(remaining)}</span>}
        </div>
        <progress aria-label={`Processing ${p.title}`} max={1} value={fraction ?? undefined} />
      </div>}
      {p.error && <div className="paper-error" role="status">
        <b>Failed · {STAGE_LABEL[p.error.stage ?? p.stage]}</b>
        <p>{p.error.message} <span className="mono">({p.error.code})</span></p>
        {p.error.retryable && <button className="small retry" disabled={retrying.includes(p.id)} onClick={() => retry(p.id)}>{retrying.includes(p.id) ? "Retrying…" : "Retry"}</button>}
      </div>}
    </article>;
  })}</div>;
  const sorted = sortPapers(papers);
  return <div className="library">
    <header>
      <h1>
        <img className="library-icon" src={`${import.meta.env.BASE_URL}app-icon.png`} width={40} height={40} alt="" />
        <span>PDF/MIRA graph viewer</span>
        <a className="help-link" href={HELP_URL} target="_blank" rel="noopener" aria-label="Help: how it works" title="How it works">
          <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></svg>
        </a>
      </h1>
      <p className="lede">Read a paper beside a generated map of its argument: its questions, claims, evidence and studies. The app generates <a href="https://mira.science/" target="_blank" rel="noopener">MIRA</a> maps from arXiv papers, following the MIRA <a href="https://github.com/MIRA-science/schema" target="_blank" rel="noopener">spec</a> and using the MIRA <a href="https://github.com/MIRA-science/MIRA-extraction" target="_blank" rel="noopener">converter</a> project.</p>
    </header>
    <section><h2>Add an arXiv paper</h2>
    <p className="small licensing-link"><a href={HELP_URL + "#licensing"} target="_blank" rel="noopener">arXiv licensing and paper processing</a></p>
    <form className="open-form" onSubmit={submit}>
      <label className="file" htmlFor="arxiv">arXiv URL or ID</label><input id="arxiv" value={arxiv} onChange={(e) => setArxiv(e.target.value)} placeholder="https://arxiv.org/abs/2501.11120v1" required />
      <button className="primary" disabled={busy || !arxiv.trim()}>{busy ? "Adding…" : "Add paper"}</button>
    </form></section>
    {err && <p className="bad-text" role="alert">{err}</p>}
    {syncError && <p className="bad-text" role="alert">{syncError}</p>}
    <section aria-label="Papers"><h2>Papers</h2>
      {loading && <p role="status">Loading papers…</p>}
      {!loading && !papers.length && !syncError && <p>No papers yet. Add an arXiv paper to begin.</p>}
      {cards(sorted.filter((p) => p.status !== "error"))}</section>
    {sorted.some((p) => p.status === "error") && <section aria-label="Papers with errors"><h2>Papers with errors</h2>{cards(sorted.filter((p) => p.status === "error"))}</section>}
    <Feedback email={contactEmail} />
  </div>;
}
