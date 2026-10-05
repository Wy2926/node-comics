# syntax=docker/dockerfile:1
# Build from the repository root. GPU access is required only at runtime.
FROM ghcr.io/astral-sh/uv:0.12.17@sha256:10787c682e4184e4f290de1171fd4703dc63de99221f10fe1c99002ce7fa9acc AS uv
FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04@sha256:ac55d124da4882b497f732d8dfd9a702d5447a5f29d08d56da6f64f0a1eb34bc AS base
RUN sed -i 's|http://archive.ubuntu.com|https://archive.ubuntu.com|g; s|http://security.ubuntu.com|https://security.ubuntu.com|g' /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
    python3 python3-venv ca-certificates libgl1 libegl1 libglib2.0-0 libgomp1 zlib1g libfontconfig1 libfreetype6 libxkbcommon0 \
    && rm -rf /var/lib/apt/lists/*
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONUTF8=1 \
    UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy QT_QPA_PLATFORM=offscreen

FROM base AS assets
WORKDIR /src/services/classic-engine
COPY services/compute-node/assets.json services/compute-node/build_support.py /src/services/compute-node/
COPY services/classic-engine/tools/prepare_mtu.py tools/prepare_mtu.py
COPY services/classic-engine/mtu_engine/ mtu_engine/
COPY services/compute-node/linux/build_assets.py /src/services/compute-node/linux/build_assets.py
RUN --mount=type=cache,target=/cache/downloads \
    python3 ../compute-node/linux/build_assets.py --output /bundle --cache /cache/downloads

FROM base AS dependencies
RUN apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends gcc python3-dev \
    && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /opt/node/engine
COPY services/classic-engine/pyproject.toml services/classic-engine/uv.lock ./
ENV UV_PROJECT_ENVIRONMENT=/opt/node/venv
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-install-project --python /usr/bin/python3

FROM base AS runtime
RUN apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends libdbus-1-3 \
    && rm -rf /var/lib/apt/lists/*
ARG VERSION=development
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Node Comics Compute" \
    org.opencontainers.image.source="https://github.com/Wy2926/node-comics" \
    org.opencontainers.image.licenses="GPL-3.0-only" \
    org.opencontainers.image.version=$VERSION \
    org.opencontainers.image.revision=$REVISION
ENV PATH=/opt/node/venv/bin:$PATH PYTHONPATH=/opt/node/engine \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility YOLO_CONFIG_DIR=/tmp/ultralytics
RUN groupadd --gid 10001 node && useradd --uid 10001 --gid 10001 --no-create-home node \
    && mkdir /data && chown 10001:10001 /data && chmod 700 /data
COPY --from=dependencies /opt/node/venv /opt/node/venv
COPY --from=assets /bundle/ /opt/node/
COPY services/classic-engine/classic_node/ /opt/node/engine/classic_node/
COPY services/classic-engine/mtu_engine/ /opt/node/engine/mtu_engine/
COPY services/classic-engine/LICENSE services/classic-engine/THIRD_PARTY.md services/classic-engine/pyproject.toml services/classic-engine/uv.lock /opt/node/engine/
COPY services/classic-engine/tools/prepare_mtu.py /opt/node/source/classic-engine/tools/
COPY services/compute-node/build_support.py services/compute-node/toolchain.lock.json services/compute-node/assets.json /opt/node/source/compute-node/
COPY services/compute-node/linux/build_assets.py services/compute-node/linux/entrypoint.py services/compute-node/linux/export_runtime.py services/compute-node/linux/healthcheck.py services/compute-node/linux/vast_bootstrap.py services/compute-node/linux/verify_assets.py services/compute-node/linux/Dockerfile services/compute-node/linux/Dockerfile.dockerignore services/compute-node/linux/compose.yaml services/compute-node/linux/node.example.json services/compute-node/linux/vast-template.json services/compute-node/linux/install_runtime.sh services/compute-node/linux/node-comics.supervisor.conf services/compute-node/linux/README.md /opt/node/source/compute-node/linux/
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
