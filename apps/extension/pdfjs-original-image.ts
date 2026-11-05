import {createHash} from 'node:crypto';

/** A small, version-checked worker command reuses PDF.js range reads and parsing. */
export function pdfOriginalImageWorker(code: string): string {
  const anchor = '    handler.on("GetPage", async function ({';
  if (createHash('sha256').update(code).digest('hex') !== 'df3bf6bf6b8b8dac8a4042d8c4ecf1cf21e1d197e0fe231c192122409eba656b' || code.indexOf(anchor) < 0) {
    throw Error('PDF.js worker command changed; review pdfjs-original-image.ts before upgrading.');
  }
  return 'import {originalPdfImage} from "./original-image.mjs";\n' + code.replace(anchor, `    handler.on("NodeComicsOriginalImage", async function ({pageIndex}) {
      ensureNotTerminated();
      const page = await pdfManager.getPage(pageIndex);
      return pdfManager.ensure({read: () => originalPdfImage(page, {EvaluatorPreprocessor, JpegStream, JpegImage, Name, Dict, OPS})}, "read");
    });
` + anchor);
}
