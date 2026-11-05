/** Runs inside the existing PDF.js worker. Never decodes, renders or re-encodes image pixels. */
export async function originalPdfImage(page, {EvaluatorPreprocessor, JpegStream, JpegImage, Name, Dict, OPS}) {
  if (page.rotate || page.annotations.length || page.pageDict.has('Group')) return null;
  const resources = page.resources, colors = resources.get('ColorSpace');
  if (colors instanceof Dict && (colors.has('DefaultRGB') || colors.has('DefaultGray'))) return null;
  const stream = await page.getContentStream();
  stream.reset();
  const parser = new EvaluatorPreprocessor(stream, page.xref);
  const operation = {fn: 0, args: []}, modes = [];
  let image, textMode = 0, count = 0;
  while (true) {
    operation.args = [];
    if (!parser.read(operation)) break;
    if (++count > 10000) return null;
    const {fn, args} = operation;
    switch (fn) {
      case OPS.save: modes.push(textMode); break;
      case OPS.restore:
        if (!modes.length) return null;
        textMode = modes.pop(); break;
      case OPS.transform: break;
      case OPS.setFillRGBColor: case OPS.setFillGray: case OPS.setFillCMYKColor:
      case OPS.setStrokeRGBColor: case OPS.setStrokeGray: case OPS.setStrokeCMYKColor:
        break;
      case OPS.beginText: case OPS.endText: case OPS.setFont:
      case OPS.setCharSpacing: case OPS.setWordSpacing: case OPS.setHScale:
      case OPS.setLeading: case OPS.setTextRise: case OPS.moveText:
      case OPS.setLeadingMoveText: case OPS.setTextMatrix: case OPS.nextLine:
        break;
      case OPS.setTextRenderingMode: textMode = args[0]; break;
      case OPS.showText: case OPS.showSpacedText: case OPS.nextLineShowText: case OPS.nextLineSetSpacingShowText:
        // Searchable scans may carry invisible OCR text. Visible text or text clipping needs composition.
        if (textMode !== 3) return null;
        break;
      case OPS.paintXObject: {
        if (image || !(args[0] instanceof Name)) return null;
        const objects = resources.get('XObject');
        if (!(objects instanceof Dict)) return null;
        const candidate = objects.get(args[0].name);
        if (!(candidate instanceof JpegStream)) return null;
        const dict = candidate.dict, color = dict.get('ColorSpace'), subtype = dict.get('Subtype');
        if (!(subtype instanceof Name) || subtype.name !== 'Image') return null;
        if (!(color instanceof Name) || !['DeviceRGB', 'DeviceGray'].includes(color.name) || dict.get('BitsPerComponent') !== 8) return null;
        if (['SMask', 'Mask', 'ImageMask', 'Decode', 'DecodeParms', 'OC', 'Alternates'].some(key => dict.has(key))) return null;
        const [x0, y0, x1, y1] = page.view, expected = [x1 - x0, 0, 0, y1 - y0, x0, y0];
        if (expected.some((value, i) => !Number.isFinite(value) || Math.abs(parser.stateManager.state.ctm[i] - value) > 0.0001)) return null;
        image = candidate;
        break;
      }
      // Paths, clipping, transparency, forms, inline images and multiple images require composition.
      default: return null;
    }
  }
  if (!image || modes.length) return null;
  const bytes = image.bytes;
  let info;
  try { info = JpegImage.canUseImageDecoder(bytes); } catch { return null; }
  // PDF ignores JPEG EXIF orientation; sending it unchanged must not change page orientation.
  if (!info || info.width <= 0 || info.height <= 0 || info.width !== image.dict.get('Width') || info.height !== image.dict.get('Height')) return null;
  if (info.exifStart && !unrotatedExif(bytes.subarray(info.exifStart, info.exifEnd))) return null;
  const [x0, y0, x1, y1] = page.view;
  if (Math.abs(info.width / info.height / ((x1 - x0) / (y1 - y0)) - 1) > 0.0001) return null;
  // A view may share the whole PDF buffer; send only the JPEG bytes across the worker boundary.
  return bytes.slice();
}

/** Read the TIFF orientation tag only; keep all original metadata and image bytes intact. */
function unrotatedExif(bytes) {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), order = view.getUint16(0);
    if (order !== 0x4949 && order !== 0x4d4d) return false;
    const little = order === 0x4949;
    if (view.getUint16(2, little) !== 42) return false;
    const offset = view.getUint32(4, little), count = view.getUint16(offset, little);
    if (offset < 8 || offset + 2 + count * 12 + 4 > bytes.length) return false;
    for (let at = offset + 2; at < offset + 2 + count * 12; at += 12) {
      if (view.getUint16(at, little) === 0x112) {
        return view.getUint16(at + 2, little) === 3 && view.getUint32(at + 4, little) === 1 && view.getUint16(at + 8, little) === 1;
      }
    }
    return true;
  } catch { return false; }
}
