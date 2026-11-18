import "pdfjs-dist/legacy/web/pdf_viewer.css";

import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { extractPages } from "./text.ts";
import type { PageText } from "./types.ts";

// The worker runs in its own global scope and needs the legacy polyfills too.
GlobalWorkerOptions.workerSrc = workerUrl;

type PdfSource = { url: string } | { bytes: ArrayBuffer };

export interface OpenPdfTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

export interface PdfDocument {
  pages: PageText[];
  renderPage(page: number, scale: number, canvas: HTMLCanvasElement, text: HTMLDivElement): PdfPageRender;
}

interface PdfPageRender {
  promise: Promise<HTMLElement[]>;
  cancel(): void;
}

export function openPdf(source: PdfSource): OpenPdfTask {
  // pdf.js transfers the buffer to its worker. Keep the caller's copy usable.
  const loading = getDocument("bytes" in source
    ? { data: new Uint8Array(source.bytes.slice(0)) }
    : { url: source.url });
  const promise = loading.promise.then(async (doc): Promise<PdfDocument> => ({
    pages: await extractPages(doc),
    renderPage: (page, scale, canvas, text) => renderPage(doc, page, scale, canvas, text),
  }));
  return { promise, destroy: () => loading.destroy() };
}

function renderPage(doc: PDFDocumentProxy, page: number, scale: number, canvas: HTMLCanvasElement, text: HTMLDivElement): PdfPageRender {
  let canceled = false;
  let canvasTask: RenderTask | undefined;
  let textLayer: TextLayer | undefined;

  const promise = (async () => {
    const pdfPage = await doc.getPage(page);
    if (canceled) return [];
    const viewport = pdfPage.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    canvasTask = pdfPage.render({
      canvas,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    });
    await canvasTask.promise;
    if (canceled) return [];

    text.replaceChildren();
    textLayer = new TextLayer({ textContentSource: pdfPage.streamTextContent(), container: text, viewport });
    await textLayer.render();
    return textLayer.textDivs.slice();
  })();

  return {
    promise,
    cancel() {
      canceled = true;
      canvasTask?.cancel();
      textLayer?.cancel();
    },
  };
}
