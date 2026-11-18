import { BROWSER_GUIDANCE, supportsPdfViewer } from "../browserSupport.ts";
import sampleUrl from "../../../samples/papers/c2FtcGxlOnJhaW4tZ2FyZGVucw/paper.pdf?url";

const result = document.querySelector<HTMLOutputElement>("#result")!;

async function run() {
  if (!supportsPdfViewer()) {
    result.textContent = BROWSER_GUIDANCE;
    result.dataset.status = "unsupported";
    return;
  }

  const { openPdf } = await import("../index.ts");
  const canvas = document.querySelector("canvas")!;
  const text = document.querySelector<HTMLDivElement>(".textLayer")!;
  const bytes = location.search === "?bytes" ? await (await fetch(sampleUrl)).arrayBuffer() : undefined;
  const length = bytes?.byteLength;
  const loading = openPdf(bytes ? { bytes } : { url: sampleUrl });
  try {
    const doc = await loading.promise;
    const canceled = doc.renderPage(1, 0.5, canvas, text);
    canceled.cancel();
    await canceled.promise;

    const spans = await doc.renderPage(1, 1, canvas, text).promise;
    const rendered = spans.find((span) => span.textContent?.includes("Rain Gardens"));
    const item = rendered && doc.pages[0].items[spans.indexOf(rendered)];
    const range = document.createRange();
    if (rendered) range.selectNodeContents(rendered);
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    result.textContent = JSON.stringify({
      pageCount: doc.pages.length,
      canvasHasInk: pixels.some((value, index) => index % 4 === 0 && value < 128),
      textMatches: !!item && item.str === rendered.textContent,
      textHasGeometry: !!rendered && range.getBoundingClientRect().width > 0,
      bytesPreserved: bytes?.byteLength === length,
    });
  } finally {
    await loading.destroy();
  }
  result.dataset.status = "ok";
}

void run().catch((error) => {
  result.textContent = String(error);
  result.dataset.status = "error";
});
