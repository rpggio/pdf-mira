import "pdfjs-dist/web/pdf_viewer.css";

import { Component, useEffect, useState, type ReactNode } from "react";
import { Library } from "./components/Library.tsx";
import { Reader } from "./components/Reader.tsx";
import type { PaperSource } from "./lib/store.ts";

class Boundary extends Component<{ children: ReactNode; onReset(): void }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="center-msg">
        <p>Something went wrong: {this.state.error.message}</p>
        <button onClick={() => (this.setState({ error: null }), this.props.onReset())}>Back to library</button>
      </div>
    );
  }
}

export function App({ gated, contactEmail }: { gated: boolean; contactEmail: string | null }) {
  const [paper, setPaper] = useState<PaperSource | null>(null);
  useEffect(() => {
    document.title = paper ? `${paper.title} — PDF/MIRA graph viewer` : "PDF/MIRA graph viewer";
  }, [paper]);
  return (
    <Boundary onReset={() => setPaper(null)}>
      {paper ? <Reader key={paper.id} paper={paper} onBack={() => setPaper(null)} /> : <Library gated={gated} contactEmail={contactEmail} onOpen={setPaper} />}
    </Boundary>
  );
}
