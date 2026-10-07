# Third-party sources

## Manga Translator UI

The image pipeline imports source from [hgmzhn/manga-translator-ui](https://github.com/hgmzhn/manga-translator-ui), pinned by commit, archive URL and SHA-256 in [upstream.lock.json](mtu_engine/upstream.lock.json). Preparation retains `manga_translator/`, the upstream `LICENSE.txt`, dependency manifests and checksums under `upstream/`. The project carries GPL-3.0 terms; original notices within source files remain intact.

One local source edit is recorded verbatim in the lockfile: `build_det_rearrange_plan` in `manga_translator/utils/generic.py` calculates the stripe count with a maximum 80% stride, ensuring at least 20% overlap rounded down to whole pixels. Preparation requires an exact single match, marks the change in source, and hashes the resulting file in the asset manifest. Native packing, inference, feathered map merging, contour extraction and model weights are unchanged. Other MTU source files remain unmodified. Existing assets must be prepared again; startup rejects the previous lock hash.

The lock also records the DBNet checkpoint from [manga-image-translator](https://github.com/zyddnys/manga-image-translator), PP-OCRv5 Korean weights/dictionary distributed by MTU, the LaMa Large checkpoint from [AnimeMangaInpainting](https://huggingface.co/dreMaz/AnimeMangaInpainting), and MangaLens weights distributed by the MTU author. PP-OCR reuses MTU's Apache-2.0 perspective crop and CTC decoder with published ONNX files pinned by SHA-256; no locally exported models or patched inference bindings are shipped.

## RapidOCR

[RapidAI/RapidOCR](https://github.com/RapidAI/RapidOCR) 3.9.2 provides the unmodified `TextRecognizer` aspect-ratio sorting, bounded batching, resize/padding and order restoration. Its wheel and SHA-256 are pinned in `uv.lock`; Apache-2.0 notices remain in the package metadata and source. The adapter supplies the existing MTU CUDA session and decoder instead of loading RapidOCR's default models or dictionary. No upstream algorithm is copied or rewritten.

## BallonsTranslator

[dmMaze/BallonsTranslator](https://github.com/dmMaze/BallonsTranslator) supplies the unmodified `group_output` paragraph grouping and reading order, operating on MTU DBNet text lines. Its commit and archive SHA-256 are pinned in the same lock. Preparation retains `ballontranslator/`, the resources required by its library imports, `BallonsTranslator-LICENSE` and its dependency manifest under `upstream/`. No CTD checkpoint is distributed or executed. The adapter does not run the BallonsTranslator GUI or translation modules. No source extraction, rewritten grouping or upstream patch is maintained.

## Paragraph sampling and language routing

[ogkalu2/comic-translate](https://github.com/ogkalu2/comic-translate) supplies the unmodified largest-line crop helper. Preparation retains its pinned `modules/`, `imkit/`, Apache-2.0 `LICENSE` and dependency manifests under `upstream/comic_translate/`. Its OSD model, GUI, account/credits, cloud OCR and OCR factory are not used.

[Yuff1010/Manga-Overlay-Translator](https://github.com/Yuff1010/Manga-Overlay-Translator) supplies the unmodified `detect_lang`, character-script categories and weights. Its complete OCR module and MIT notice are pinned by revision and SHA-256 under `upstream/mot/`. The adapter supplies existing paragraph crops and three batched PP-OCRv5 predictions instead of repeating detection; English replaces the Spanish candidate using the same Latin weights, and Chinese/Japanese share the CJK probe prediction. Empty/unsupported evidence is rejected before the upstream first-candidate default. No learned classifier, custom scoring, model training or conversion is maintained.

## Language-specific recognition

- Chinese: [Topdu/OpenOCR](https://github.com/Topdu/OpenOCR), `openocr-python==0.1.5`, native SVTRv2 server PyTorch recognition. The configuration, Apache-2.0 notice and published `openocr_svtrv2_ch.pth` are pinned in `upstream.lock.json`; package code and dictionary are pinned by wheel hashes in `uv.lock`.
- Japanese: [kha-white/manga-ocr](https://github.com/kha-white/manga-ocr), `manga-ocr==0.1.16`, and [manga-ocr-base](https://huggingface.co/kha-white/manga-ocr-base) at the locked revision. Original model, tokenizer, processor, model card and Apache-2.0 notice are retained. Native paragraph generation and postprocessing are unchanged.
- Korean / English: separate PP-OCRv5 mobile recognizers. English and the Chinese/Japanese probe use the published [ogkalu/ppocr-v5-onnx](https://huggingface.co/ogkalu/ppocr-v5-onnx) ONNX weights and dictionaries under Apache-2.0; Korean files are distributed by MTU. All files are checksum-pinned. The probe is not the Chinese/Japanese final recognizer.

Models load from prepared local paths only. OpenOCR's CPU `onnxruntime` dependency is excluded to avoid overwriting `onnxruntime-gpu`; the CUDA distribution supplies that module. The OpenOCR absolute `tools.*` imports share the namespace with the project's CLI without modifying upstream source.

PySide6-Essentials / Shiboken6 are required by upstream utility imports; their original Qt LGPL/GPL notices remain in the wheel metadata. Both are pinned to Qt 6.9.2 to match the existing PyQt6 Qt runtime. `mahotas` retains its MIT license in its distribution. Open-source license obligations remain applicable; no commercial OCR license is used.

## Runtime and data

- PyTorch and TorchVision CUDA distributions: upstream package notices and NVIDIA runtime notices are retained in wheel metadata. Qt rendering executes on the CPU.
- ONNX Runtime GPU 1.23.2 executes all three PP-OCRv5 sessions with the CUDA 12 provider; its package metadata retains Microsoft's MIT notice and bundled dependency notices.
- PyQt6 / Qt6: original package licenses remain in the distribution. DenseCRF uses the MTU author's platform wheels, with URLs and SHA-256 locked in `uv.lock`.
- PyHyphen uses bundled LibreOffice hyphenation data from the pinned Pyphen distribution. Its dictionary-specific notices are retained under `hyphenation/`; no dictionary download is performed during page processing.
- Bangers, Comic Relief Bold, Jua and Lalezar from Google Fonts; LXGW Marker Gothic from its author's repository; Noto Sans, Noto Sans CJK and the complete variable Noto Sans Arabic font for fallback: source revisions, SHA-256 and SIL Open Font License notices are listed in [assets.json](../compute-node/assets.json) and retained under `licenses/`.
- Other dependencies, including NumPy, OpenCV, Pillow, Ultralytics, timm, SciPy, NetworkX and Shapely, retain their own upstream package metadata and license files.

`mtu-assets.json` records prepared source, model, dictionary, font and notice hashes. Node startup verifies those files before importing upstream image stages. Distribution manifests include the assembled runtime and source provenance. This inventory records origins; it does not replace upstream terms.
