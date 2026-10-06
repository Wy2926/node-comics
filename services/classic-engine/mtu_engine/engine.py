"""Assemble MTU stages; image algorithms and typesetting live entirely upstream."""
import asyncio
import json
import logging
import os
from pathlib import Path
from threading import Lock, current_thread, main_thread

import numpy as np

from .assets import activate

LANGUAGES = {'zh-Hans': 'CHS', 'zh-Hant': 'CHT', 'ja': 'JPN', 'ko': 'KOR', 'en': 'ENG',
             'fr': 'FRA', 'es': 'ESP', 'pt-BR': 'PTB', 'de': 'DEU', 'it': 'ITA', 'ru': 'RUS',
             'pl': 'POL', 'uk': 'UKR', 'tr': 'TRK', 'vi': 'VIN', 'id': 'IND', 'ar': 'ARA'}


def configuration(detect_size=1280, inpainting_size=512):
    from manga_translator.config import Config
    return Config.model_validate({
        'detector': {'detector': 'default', 'detection_size': detect_size},
        'ocr': {'ocr': 'paddleocr', 'prob': 0.50, 'limit_mask_dilation_to_bubble_mask': True},
        'inpainter': {'inpainter': 'lama_large', 'inpainting_size': inpainting_size,
                      'inpainting_precision': 'fp32', 'force_use_torch_inpainting': True,
                      'solid_fill_pure_bubbles': True, 'per_block_inpainting': True},
        'render': {'renderer': 'default', 'layout_mode': 'smart_scaling',
                   'balloon_fill_mask_layout': False, 'center_text_in_bubble': True,
                   'no_hyphenation': True, 'font_color': '000000:FFFFFF',
                   'stroke_width': 0.1, 'font_scale_ratio': 0.96},
        'translator': {'translator': 'none'},
    })


def serialize_region(region):
    # Preserve raw geometry. MTU's editor export intentionally unrotates lines,
    # so the compute checkpoint stores the constructor fields directly.
    return {'lines': region.lines.tolist(), 'texts': list(region.texts),
            'font_size': float(region.font_size), 'angle': float(region.angle),
            'fg_color': list(map(int, region.fg_colors)), 'bg_color': list(map(int, region.bg_colors)),
            'prob': float(region.prob), 'direction': region._direction,
            'default_stroke_width': float(region.stroke_width),
            'line_spacing': float(region.line_spacing), 'letter_spacing': float(region.letter_spacing)}


class Renderer:
    def __init__(self, models, fonts):
        if current_thread() is not main_thread():
            raise RuntimeError('Initialize Qt on the node main thread before starting workers')
        root = Path(models).resolve().parent
        activate(models)
        os.environ['BALLOONTRANS_APP_ROOT'] = str(root / 'upstream')
        os.environ['QT_QPA_PLATFORM'] = 'offscreen'
        os.environ['QT_API'] = 'pyqt6'
        os.environ['QT_QPA_FONTDIR'] = str(root / 'fonts')
        os.environ['TQDM_DISABLE'] = '1'
        # Upstream debug/info may contain OCR or translation text. Only our
        # bounded, sanitized node diagnostics enter the operational log.
        logger = logging.getLogger('manga-translator')
        logger.handlers = [logging.NullHandler()]
        logger.propagate = False
        logger.setLevel(logging.CRITICAL + 1)
        from hyphen import dictools
        dictools.DEFAULT_DICT_PATH = str(root / 'hyphenation')
        registry = json.loads((root / 'hyphenation/dictionaries.json').read_text(encoding='utf-8'))
        dictools.LANGUAGES[:] = list(registry)
        from manga_translator.rendering import text_render
        from PyQt6.QtGui import QRawFont
        self.fonts = tuple(fonts)
        self.font_by_name = {Path(path).name: path for path in self.fonts}
        if not self.fonts:
            raise ValueError('Use the prepared bundle fonts')
        text_render.set_font(self.fonts[0])
        self.families = [text_render.register_font_file(path)[0] for path in self.fonts]
        # Register and initialize before render workers start. Qt owns fallback,
        # shaping, line breaking, size search, glyph rasterization and compositing.
        text_render.set_font(self.families[0])
        self.raw_fonts = [QRawFont(path, 24) for path in self.fonts]
        self._lock = Lock()

    def covers(self, text):
        return all(any(font.supportsCharacter(ord(char)) for font in self.raw_fonts)
                   for char in text if not char.isspace())

    def render(self, original, cleaned, regions, translations, language, bubble_mask):
        import cv2
        from manga_translator.config import Direction
        from manga_translator.rendering import (
            dispatch, resize_regions_to_font_size, calc_font_from_box, calc_box_from_font,
            _region_lines_fully_inside_mask, _apply_default_english_line_break_method, text_render)
        from manga_translator.utils import TextBlock, build_region_reference_mask, erode_bubble_mask
        from manga_translator.rendering.rich_text import legacy_line_breaks_to_document
        config = configuration()
        target = LANGUAGES[language]
        config.translator.target_lang = target
        if language in ('zh-Hans', 'zh-Hant', 'ja'):
            font = 'LXGWMarkerGothic-Regular.ttf'
        elif language == 'ko':
            font = 'Jua-Regular.ttf'
        elif language == 'ar':
            font = 'Lalezar-Regular.ttf'
        elif language in ('ru', 'uk'):
            font = 'ComicRelief-Bold.ttf'
        else:
            font = 'Bangers-Regular.ttf'
        config.render.font_family = self.font_by_name.get(font, self.fonts[0])
        if language not in ('zh-Hans', 'zh-Hant', 'ja'):
            config.render.direction = Direction.h
            # MTU explicitly supports this word-based layout switch for every
            # language. Preserve words (and Arabic joins) before size search.
            config.render.bubble_layout_english = language != 'en'
        blocks = []
        for data, text in zip(regions, translations):
            if not text.strip():
                continue
            block = TextBlock(**data)
            block.translation = text
            block.target_lang = target
            block.font_family = config.render.font_family
            block.fg_colors = [0, 0, 0]
            block.bg_colors = [255, 255, 255]
            block.default_stroke_width = 0.1
            if language not in ('zh-Hans', 'zh-Hant', 'ja'):
                block._direction = config.render.direction.value
                if len(text.split()) == 1:
                    # MTU's automatic plain-text fallback can split even a
                    # single word into characters. Its document path preserves
                    # the paragraph and still fits glyphs to the available box.
                    block.set_translation_rich(legacy_line_breaks_to_document(text))
            blocks.append(block)
        if not blocks:
            return cleaned
        # MTU's font selection is thread-local; its registry/hyphenator caches
        # are shared. Bound the whole upstream call until concurrency is proven.
        with self._lock:
            enclosed, free = [], []
            labels = None
            if bubble_mask is not None and np.any(bubble_mask):
                # Leave a small inset inside the segmentation's edge, using
                # MTU's per-component erosion rather than cropping painted text.
                bubble_mask = erode_bubble_mask(bubble_mask, 0.02)
                _, labels = cv2.connectedComponents((bubble_mask > 0).astype(np.uint8))
            for block in blocks:
                # Use MTU's own enclosure test. A text detection rectangle or a
                # partially overlapping segmentation is not a layout container.
                inside = labels is not None and _region_lines_fully_inside_mask(
                    block, build_region_reference_mask(block, bubble_mask, labels))
                (enclosed if inside else free).append(block)
            enclosed_texts = [block.translation for block in enclosed]
            if language not in ('zh-Hans', 'zh-Hant', 'ja'):
                # MTU first supplies its word breaks. A second layout
                # pass runs its Qt size search on those explicit breaks, instead
                # of preserving the source CJK font size from the first pass.
                scale = config.render.font_scale_ratio
                config.render.font_scale_ratio = 1.0
                resize_regions_to_font_size(cleaned, blocks, config, None, skip_text_replacements=True)
                config.render.font_scale_ratio = scale
            points = resize_regions_to_font_size(cleaned, free, config, None, skip_text_replacements=True)
            height, width = cleaned.shape[:2]
            for block, polygon in zip(free, points):
                if polygon is None:
                    continue
                vertices = np.asarray(polygon).reshape(-1, 2)
                left, top = vertices.min(axis=0)
                right, bottom = vertices.max(axis=0)
                if left >= 2 and top >= 2 and right <= width - 2 and bottom <= height - 2:
                    continue
                # Map the upstream rotated render rectangle to the available
                # canvas budget. MTU still measures glyphs and searches the font;
                # this adapter supplies image bounds, never new word/box rules.
                cx, cy = block.center
                extent = np.maximum([cx - left, right - cx, cy - top, bottom - cy], 1)
                budget = np.maximum([cx - 2, width - 2 - cx, cy - 2, height - 2 - cy], 1)
                ratio = min(1.0, float(np.min(budget / extent)))
                text_render.set_font(block.font_family)
                options = dict(text=block.translation, is_horizontal=block.horizontal,
                    line_spacing=block.line_spacing, config=config, target_lang=block.target_lang,
                    letter_spacing=block.letter_spacing, stroke_width=block.stroke_width)
                box_width, box_height, _, _ = calc_box_from_font(block.font_size, **options)
                block.font_size = min(block.font_size, calc_font_from_box(
                    box_width * ratio, box_height * ratio, **options))
            rendered = cleaned.copy()
            if free:
                rendered = asyncio.run(dispatch(rendered, free, config, None,
                    skip_font_scaling=True, skip_text_replacements=True))
            if enclosed:
                config.render.layout_mode = 'balloon_fill'
                # CJK keeps native column breaking; the optional inscribed-box
                # reflow adds full-mask scans without improving this constraint.
                config.render.balloon_fill_mask_layout = language not in ('zh-Hans', 'zh-Hant', 'ja')
                if config.render.balloon_fill_mask_layout:
                    # Manga2Eng initially wraps at the source CJK font size.
                    # Feed MTU's mask-fitted size back to its word layout once:
                    # otherwise the final pass only shrinks those narrow lines.
                    scale = config.render.font_scale_ratio
                    config.render.font_scale_ratio = 1.0
                    resize_regions_to_font_size(rendered, enclosed, config, original,
                        bubble_mask=bubble_mask, skip_text_replacements=True)
                    config.render.font_scale_ratio = scale
                    for block, text in zip(enclosed, enclosed_texts):
                        block.translation = text
                        text_render.set_font(block.font_family)
                        _apply_default_english_line_break_method(
                            block, round(block.font_size), None, config)
                # Keep scaling enabled: upstream fits the actual mask, retains
                # its layout anchor and handles paragraphs in a shared bubble.
                rendered = asyncio.run(dispatch(rendered, enclosed, config, original,
                    bubble_mask=bubble_mask, skip_text_replacements=True))
            return rendered


class Engine:
    def __init__(self, models, font, gpu=0, threads=2, detect_size=1280, inpainting_size=512, keep_lang=None):
        import cv2
        import torch
        if not torch.cuda.is_available() or not 0 <= gpu < torch.cuda.device_count():
            raise RuntimeError('An NVIDIA CUDA GPU is required; there is no CPU/DirectML fallback')
        self.models = Path(models)
        self.gpu = gpu
        self.keep_lang = keep_lang
        self.renderer = Renderer(models, font)
        self.config = configuration(detect_size, inpainting_size)
        # Upstream model wrappers own mutable state. Serialize each instance,
        # while allowing other models and CPU mask work to make progress.
        self._detector_lock = Lock()
        self._ocr_lock = Lock()
        self._inpaint_lock = Lock()
        self._bubble_lock = Lock()
        torch.set_num_threads(threads)
        torch.backends.cuda.matmul.allow_tf32 = False
        torch.backends.cudnn.allow_tf32 = False
        from manga_translator.utils import ModelWrapper, MangaLensBubbleDetector
        ModelWrapper._MODEL_DIR = str(self.models)
        from manga_translator.detection.default import DefaultDetector
        from ballontranslator.utils.logger import logger as ballons_logger
        ballons_logger.handlers = [logging.NullHandler()]
        ballons_logger.propagate = False
        ballons_logger.setLevel(logging.CRITICAL + 1)
        from manga_translator.ocr.model_paddleocr import ModelPaddleOCR
        from manga_translator.inpainting.inpainting_lama_mpe import LamaLargeInpainter
        # Select only the upstream CUDA checkpoint; do not fetch an unused CPU
        # ONNX model just to satisfy the upstream multi-backend download map.
        class CudaLama(LamaLargeInpainter):
            _MODEL_MAPPING = {'model': LamaLargeInpainter._MODEL_MAPPING['model']}
        class CudaPaddle(ModelPaddleOCR):
            # Lettering has fixed black/white colors; no extra 48px color model.
            _COMMON_MODEL_MAPPING_KEYS = ()
        with torch.cuda.device(gpu):
            self.detector = DefaultDetector()
            self.ocr = CudaPaddle()
            self.inpainter = CudaLama()
            for model in (self.detector, self.ocr, self.inpainter):
                # Keep upstream model diagnostics out of operational logs.
                model.logger.handlers = [logging.NullHandler()]
                model.logger.propagate = False
                model.logger.setLevel(logging.CRITICAL + 1)
                if not model.is_downloaded():
                    raise ValueError('Missing prepared model; runtime downloads are disabled')
                asyncio.run(model.load('cuda'))
            # The OCR loader exposes no session options. Recreate its session
            # once at startup with the native factory: bind the selected GPU,
            # bound CPU helpers, and avoid spinning against the Qt render pool.
            from manga_translator.utils.onnx_runtime import create_inference_session, import_onnxruntime
            options = self.ocr.session.get_session_options()
            options.intra_op_num_threads = threads
            options.inter_op_num_threads = 1
            options.add_session_config_entry('session.intra_op.allow_spinning', '0')
            options.add_session_config_entry('session.inter_op.allow_spinning', '0')
            self.ocr.session = None
            self.ocr.session, _ = create_inference_session(import_onnxruntime(),
                self.ocr._get_file_path(self.ocr._MODELS[self.ocr.model_type]['onnx']),
                device='cuda', sess_options=options, cuda_options={'device_id': gpu},
                fallback_to_cpu=False, logger=self.ocr.logger)
            if self.ocr.session.get_providers()[0] != 'CUDAExecutionProvider':
                raise RuntimeError('PP-OCRv6 requires ONNX Runtime CUDAExecutionProvider')
            self.ocr.session.disable_fallback()
            self.bubbles = MangaLensBubbleDetector(
                model_path=self.models / 'detection/mangalens.pt', device=f'cuda:{gpu}',
                imgsz=768, conf=0.25, iou=0.7, auto_download=False, auto_load=True)
        # Upstream imports can disable OpenCV threading. Apply the node's CPU
        # budget after loading them, including DBNet and mask bilateral filters.
        cv2.setNumThreads(threads)

    def warmup(self):
        import torch
        from manga_translator.utils import Quadrilateral
        rgb = np.full((512, 512, 3), 255, dtype=np.uint8)
        mask = np.zeros((512, 512), dtype=np.uint8)
        mask[230:260, 230:260] = 255
        async def run():
            c = self.config
            await self.detector.detect(rgb, c.detector.detection_size, c.detector.text_threshold,
                                       c.detector.box_threshold, c.detector.unclip_ratio)
            await self.ocr.recognize(rgb, [Quadrilateral(np.array([[20, 20], [240, 20], [240, 68], [20, 68]]), '', 1)], c.ocr)
            await self.inpainter.inpaint(rgb, mask, c.inpainter, c.inpainter.inpainting_size)
        with self._detector_lock, self._ocr_lock, self._inpaint_lock, self._bubble_lock, torch.cuda.device(self.gpu):
            asyncio.run(run())
            self.bubbles.detect(rgb, device=f'cuda:{self.gpu}')

    def analyze(self, rgb):
        import torch
        from manga_translator.mask_refinement import dispatch as refine
        from ballontranslator.utils.textblock import group_output
        from manga_translator.utils import (
            TextBlock, Quadrilateral, build_bubble_mask_from_mangalens_result, is_valuable_text)
        async def run():
            c = self.config
            with self._detector_lock:
                lines, raw, _ = await self.detector.detect(rgb, c.detector.detection_size,
                    c.detector.text_threshold, c.detector.box_threshold, c.detector.unclip_ratio)
            # Retain the approved upstream paragraph grouping and reading
            # order, using DBNet lines without loading or running a CTD model.
            blocks = group_output([], [line.pts for line in lines], rgb.shape[1], rgb.shape[0])
            groups = [[Quadrilateral(np.asarray(line), '', 1) for line in block.lines] for block in blocks]
            # Keep ORT's convolution input shape stable: alternating a full
            # batch and a remainder rebuilds cuDNN plans on the deployed stack.
            # MTU still owns cropping, resizing, decoding and confidence checks.
            for group in groups:
                for line in group:
                    with self._ocr_lock:
                        await self.ocr.recognize(rgb, [line], c.ocr)
            regions = [TextBlock(lines=block.lines, texts=[line.text for line in group],
                                 font_size=block.font_size, angle=block.angle,
                                 direction='v' if block.src_is_vertical else 'h')
                       for block, group in zip(blocks, groups)]
            regions = [region for region in regions
                       if len(region.text.strip()) >= c.ocr.min_text_length and is_valuable_text(region.text)
                       and (self.keep_lang is None or region.source_lang == self.keep_lang)]
            if not regions:
                return [], None, None, None
            with self._bubble_lock:
                detected_bubbles = self.bubbles.detect(rgb, device=f'cuda:{self.gpu}')
            bubbles = build_bubble_mask_from_mangalens_result(detected_bubbles, rgb.shape[:2])
            mask = await refine(regions, rgb, raw, dilation_offset=c.mask_dilation_offset,
                                kernel_size=c.kernel_size, limit_mask_dilation_to_bubble_mask=True,
                                bubble_mask=bubbles)
            return regions, mask, raw, bubbles
        with torch.cuda.device(self.gpu):
            return asyncio.run(run())

    def inpaint(self, rgb, mask, raw_mask, bubble_mask, regions):
        import cv2
        import torch
        from manga_translator.utils import TextBlock, erode_bubble_mask
        from manga_translator.inpainting.ballon_fill import (
            MODEL_BUBBLE_SHRINK_RATIO, inpaint_regions_per_block, solid_fill_pure_bubbles)
        # These are MTU's documented stage inputs, including its 2px raw-mask
        # dilation for background sampling; no local repair/layout algorithm.
        blocks = [TextBlock(**data) for data in regions]
        tight = cv2.resize(raw_mask, rgb.shape[1::-1], interpolation=cv2.INTER_LINEAR)
        tight = cv2.dilate(np.where(tight >= 127, 255, 0).astype(np.uint8), None, iterations=2)
        filled, remaining, _ = solid_fill_pure_bubbles(rgb, mask, blocks, tight,
            erode_bubble_mask(bubble_mask, MODEL_BUBBLE_SHRINK_RATIO), self.config.ocr.model_bubble_overlap_threshold)
        async def inpaint(crop, local_mask):
            with self._inpaint_lock:
                return await self.inpainter.inpaint(crop, local_mask, self.config.inpainter,
                                                    self.config.inpainter.inpainting_size)
        with torch.cuda.device(self.gpu):
            result, _ = asyncio.run(inpaint_regions_per_block(filled, remaining.copy(), inpaint))
        return result

    def close(self):
        import torch
        with self._detector_lock, self._ocr_lock, self._inpaint_lock, self._bubble_lock, torch.cuda.device(self.gpu):
            for model in (self.detector, self.ocr, self.inpainter):
                asyncio.run(model.unload())
            self.bubbles.model = None
