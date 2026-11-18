// The legacy build supplies JavaScript polyfills. Check for the browser APIs
// the viewer still needs before importing pdf.js.
export function supportsPdfViewer(): boolean {
  return typeof Worker === "function"
    && typeof DOMMatrix === "function"
    && typeof Path2D === "function";
}

export const BROWSER_GUIDANCE = "Open the PDF reader in a recent desktop version of Google Chrome or Microsoft Edge.";
