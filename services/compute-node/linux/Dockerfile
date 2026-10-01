# syntax=docker/dockerfile:1
# Build from the repository root. GPU access is required only at runtime.
FROM ghcr.io/astral-sh/uv:0.12.17@sha256:10787c682e4184e4f290de1171fd4703dc63de99221f10fe1c99002ce7fa9acc AS uv
FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04@sha256:ac55d124da4882b497f732d8dfd9a702d5447a5f29d08d56da6f64f0a1eb34bc AS base
RUN sed -i 's|http://archive.ubuntu.com|https://archive.ubuntu.com|g; s|http://security.ubuntu.com|https://security.ubuntu.com|g' /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
    python3 python3-venv ca-certificates libvulkan1 libgl1 libegl1 libglib2.0-0 libgomp1 zlib1g \
    && rm -rf /var/lib/apt/lists/*
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONUTF8=1 \
    UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy

FROM base AS ncnn-wheel
RUN apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
    build-essential cmake ninja-build python3-dev python3-setuptools python3-wheel patch \
    && rm -rf /var/lib/apt/lists/*
ADD --checksum=sha256:282f0f4a1beec1f5212aa0d22c00737418645055f33c2d2082922931cdbdc537 \
    https://files.pythonhosted.org/packages/5b/77/d6acfd9b652463a2037a1113954f2cf0aa7d4c414de31b01aeb1fd9bf9e7/ncnn-1.0.20260526.tar.gz /source/ncnn.tar.gz
COPY services/compute-node/linux/ncnn/gil-release.patch /source/node-ncnn/gil-release.patch
WORKDIR /build
RUN tar -xf /source/ncnn.tar.gz --strip-components=1 \
    && patch --batch --fuzz=0 -p1 < /source/node-ncnn/gil-release.patch
ENV CMAKE_BUILD_PARALLEL_LEVEL=4 CMAKE_GENERATOR=Ninja EXTRA_CMAKE_ARGS="-DNCNN_VERSION=20260526"
RUN python3 setup.py bdist_wheel --dist-dir /wheels

FROM base AS assets
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /src/services/classic-engine
COPY services/compute-node/build-deps/ /src/services/compute-node/build-deps/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --python /usr/bin/python3 --project ../compute-node/build-deps/ocr \
    && uv sync --locked --no-dev --python /usr/bin/python3 --project ../compute-node/build-deps/lama
COPY services/compute-node/toolchain.lock.json services/compute-node/assets.json services/compute-node/build_support.py /src/services/compute-node/
COPY services/classic-engine/tools/build_ocr.py services/classic-engine/tools/build_lama.py services/classic-engine/tools/lama_model.py tools/
COPY services/classic-engine/manhua_engine/models.json services/classic-engine/manhua_engine/alphabet.txt manhua_engine/
COPY services/compute-node/linux/build_assets.py /src/services/compute-node/linux/build_assets.py
RUN --mount=type=cache,target=/cache/downloads \
    python3 ../compute-node/linux/build_assets.py --output /bundle --cache /cache/downloads

FROM base AS dependencies
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /opt/node/engine
COPY services/classic-engine/pyproject.toml services/classic-engine/uv.lock ./
ENV UV_PROJECT_ENVIRONMENT=/opt/node/venv
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-install-project --python /usr/bin/python3
COPY --from=ncnn-wheel /wheels/ /tmp/ncnn-wheels/
COPY services/compute-node/linux/ncnn/test_gil.py /tmp/test_ncnn_gil.py
RUN uv pip install --python /opt/node/venv/bin/python --no-deps --no-index /tmp/ncnn-wheels/*.whl \
    && /opt/node/venv/bin/python /tmp/test_ncnn_gil.py

FROM base AS runtime
ARG VERSION=development
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Node Comics Compute" \
    org.opencontainers.image.source="https://github.com/Wy2926/node-comics" \
    org.opencontainers.image.licenses="GPL-3.0-only" \
    org.opencontainers.image.version=$VERSION \
    org.opencontainers.image.revision=$REVISION
ENV PATH=/opt/node/venv/bin:$PATH \
    PYTHONPATH=/opt/node/engine \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics
RUN groupadd --gid 10001 node && useradd --uid 10001 --gid 10001 --no-create-home node \
    && mkdir /data && chown 10001:10001 /data && chmod 700 /data
COPY --from=dependencies /opt/node/venv /opt/node/venv
COPY --from=assets /bundle/ /opt/node/
COPY --from=ncnn-wheel /source/ /opt/node/source/ncnn/
COPY --from=ncnn-wheel /build/LICENSE.txt /opt/node/licenses/ncnn-BSD-3-Clause.txt
COPY services/classic-engine/classic_node/ /opt/node/engine/classic_node/
COPY services/classic-engine/manhua_engine/ /opt/node/engine/manhua_engine/
COPY services/classic-engine/LICENSE services/classic-engine/THIRD_PARTY.md services/classic-engine/pyproject.toml services/classic-engine/uv.lock /opt/node/engine/
# Keep build source and provenance alongside the runtime, without Torch/pnnx.
COPY services/classic-engine/tools/build_ocr.py services/classic-engine/tools/build_lama.py services/classic-engine/tools/lama_model.py /opt/node/source/classic-engine/tools/
COPY services/compute-node/build-deps/ /opt/node/source/compute-node/build-deps/
COPY services/compute-node/build_support.py services/compute-node/toolchain.lock.json services/compute-node/assets.json /opt/node/source/compute-node/
COPY services/compute-node/linux/build_assets.py services/compute-node/linux/entrypoint.py services/compute-node/linux/export_runtime.py services/compute-node/linux/healthcheck.py services/compute-node/linux/vast_bootstrap.py services/compute-node/linux/verify_assets.py services/compute-node/linux/Dockerfile services/compute-node/linux/Dockerfile.dockerignore services/compute-node/linux/compose.yaml services/compute-node/linux/node.example.json services/compute-node/linux/vast-template.json services/compute-node/linux/install_runtime.sh services/compute-node/linux/node-comics.supervisor.conf services/compute-node/linux/README.md /opt/node/source/compute-node/linux/
COPY services/compute-node/linux/ncnn/gil-release.patch /opt/node/source/compute-node/linux/ncnn/gil-release.patch
# Regression checks are build-only mounts, never files in the delivered runtime.
RUN --mount=type=bind,source=.,target=/src,ro \
    python -m unittest discover -s /src/services/compute-node/linux -p test_container.py \
    && python -m unittest discover -s /src/services/compute-node/linux -p test_vast_bootstrap.py \
    && python /opt/node/source/compute-node/linux/verify_assets.py
WORKDIR /data
USER 10001:10001
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=600s --retries=3 \
    CMD ["python", "/opt/node/source/compute-node/linux/healthcheck.py"]
ENTRYPOINT ["python", "/opt/node/source/compute-node/linux/entrypoint.py"]
CMD []
