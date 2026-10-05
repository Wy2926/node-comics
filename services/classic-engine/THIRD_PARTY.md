# Third-party sources

## Manga Translator UI

The image pipeline imports unmodified source from [hgmzhn/manga-translator-ui](https://github.com/hgmzhn/manga-translator-ui), pinned by commit, archive URL and SHA-256 in [upstream.lock.json](mtu_engine/upstream.lock.json). Preparation retains `manga_translator/`, the upstream `LICENSE.txt`, dependency manifests and checksums under `upstream/`. The project carries GPL-3.0 terms; original notices within source files remain intact.

The lock also records the DBNet checkpoint from [manga-image-translator](https://github.com/zyddnys/manga-image-translator), the official [PP-OCRv6 medium ONNX model and dictionary](https://www.modelscope.cn/models/PaddlePaddle/PP-OCRv6_medium_rec_onnx) from PaddlePaddle, the LaMa Large checkpoint from [AnimeMangaInpainting](https://huggingface.co/dreMaz/AnimeMangaInpainting), and MangaLens weights distributed by the MTU author. PP-OCR uses MTU's unmodified Apache-2.0 adapter and the official model's published files, pinned by SHA-256; no locally exported ONNX/NCNN models or patched inference bindings are shipped.

## BallonsTranslator

[dmMaze/BallonsTranslator](https://github.com/dmMaze/BallonsTranslator) supplies the unmodified CTD detector and paragraph grouping. Its commit, archive SHA-256 and the native [comictextdetector checkpoint](https://huggingface.co/dreMaz/mit_models) are pinned in the same lock. Preparation retains `ballontranslator/`, the resources required by its library imports, `BallonsTranslator-LICENSE` and its dependency manifest under `upstream/`. The adapter uses CTD geometry with MTU OCR, masking, inpainting and Qt rendering; it does not run the BallonsTranslator GUI or translation modules. No source extraction, rewritten grouping or upstream patch is maintained.

## Runtime and data

- PyTorch and TorchVision CUDA distributions: upstream package notices and NVIDIA runtime notices are retained in wheel metadata. Qt rendering executes on the CPU.
- ONNX Runtime GPU 1.23.2 executes PP-OCRv6 with the CUDA 12 provider; its package metadata retains Microsoft's MIT notice and bundled dependency notices.
- PyQt6 / Qt6: original package licenses remain in the distribution. DenseCRF uses the MTU author's platform wheels, with URLs and SHA-256 locked in `uv.lock`.
- PyHyphen uses bundled LibreOffice hyphenation data from the pinned Pyphen distribution. Its dictionary-specific notices are retained under `hyphenation/`; no dictionary download is performed during page processing.
- Bangers, Comic Relief Bold, Jua and Lalezar from Google Fonts; LXGW Marker Gothic from its author's repository; Noto Sans, Noto Sans CJK and the complete variable Noto Sans Arabic font for fallback: source revisions, SHA-256 and SIL Open Font License notices are listed in [assets.json](../compute-node/assets.json) and retained under `licenses/`.
- Other dependencies, including NumPy, OpenCV, Pillow, Ultralytics, timm, SciPy, NetworkX and Shapely, retain their own upstream package metadata and license files.

`mtu-assets.json` records prepared source, model, dictionary, font and notice hashes. Node startup verifies those files before importing upstream image stages. Distribution manifests include the assembled runtime and source provenance. This inventory records origins; it does not replace upstream terms.
