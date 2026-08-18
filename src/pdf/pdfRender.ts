import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type PdfDoc = pdfjs.PDFDocumentProxy;

export async function openPdf(bytes: Uint8Array): Promise<PdfDoc> {
  // getDocument transfers the buffer to the worker; hand it a copy so the
  // caller's bytes stay usable (e.g. for hashing).
  return pdfjs.getDocument({ data: bytes.slice() }).promise;
}

/**
 * Render one page to a PNG data URL, scaled so the long edge is `maxEdge`
 * pixels (2576 is the largest size current Claude models accept natively).
 */
export async function renderPage(doc: PdfDoc, pageNum: number, maxEdge: number): Promise<string> {
  const page = await doc.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(4, maxEdge / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d", { alpha: false })!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toDataURL("image/png");
}
