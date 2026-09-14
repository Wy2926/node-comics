FROM python:3.11-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OMP_NUM_THREADS=4
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends git build-essential libgl1 libglib2.0-0 libfreetype6 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/engine
COPY requirements.txt ./
RUN pip install --no-cache-dir torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir -r requirements.txt
ARG MIT_COMMIT=95227a2bb0fd306cd4f0c104d57284026f991b3a
COPY prepare.py server.py ./
COPY licenses ./licenses
RUN git clone --filter=blob:none --no-checkout https://github.com/zyddnys/manga-image-translator.git /opt/mit && git -C /opt/mit checkout ${MIT_COMMIT} && python prepare.py --source-only && rm -rf /opt/mit/.git
ENV PYTHONPATH=/opt/mit MODEL_DIR=/models ENGINE_VERSION=mit-95227a2-classic-v1
RUN useradd --uid 10001 --create-home comics && mkdir -p /models && chown comics:comics /models
USER comics
CMD ["sh", "-c", "python prepare.py && uvicorn server:app --host 0.0.0.0 --port 8000 --workers 1 --no-access-log"]
