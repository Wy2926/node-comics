FROM python:3.11-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OMP_NUM_THREADS=4
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends git build-essential libgl1 libglib2.0-0 libfreetype6 libfontconfig1 libxkbcommon0 libegl1 libopengl0 libdbus-1-3 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/engine
COPY requirements.txt ./
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir torch==2.5.1 torchvision==0.20.1 --index-url ${TORCH_INDEX_URL}
RUN pip install --no-cache-dir -r requirements.txt
ARG MIT_COMMIT=95227a2bb0fd306cd4f0c104d57284026f991b3a
COPY speech_bubbles.py lettering.py typesetter.py typesetter_inputs.py typesetter_geometry.py prepare_typesetter.py render_languages.py prepare.py server.py engine_config.py cuda_runtime.py local_inpainting.py runtime.py hyphenation.py prepare_dictionaries.py hyphenation-catalog.json ./
COPY licenses ./licenses
COPY parallel_panels.py panel_geometry.py mask_geometry.py ocr_position_cache.py neural_acceleration.py ./
COPY third_party ./third_party
RUN git clone --filter=blob:none --no-checkout https://github.com/zyddnys/manga-image-translator.git /opt/mit && git -C /opt/mit checkout ${MIT_COMMIT} && python prepare.py --source-only && rm -rf /opt/mit/.git
RUN python prepare_typesetter.py --source /opt/manga-typesetter --destination /opt/typesetter && rm -rf /opt/manga-typesetter
ENV PYTHONPATH=/opt/mit MODEL_DIR=/models ENGINE_VERSION=mit-95227a2-classic-v9-qt-roi ENGINE_DEVICE=cpu TYPESETTER_ROOT=/opt/typesetter QT_QPA_PLATFORM=offscreen XDG_CACHE_HOME=/tmp/comics-fontcache
RUN useradd --uid 10001 --create-home comics && mkdir -p /models && chown comics:comics /models
USER comics
CMD ["sh", "-c", "python prepare.py && uvicorn server:app --host 0.0.0.0 --port 8000 --workers 1 --no-access-log"]
