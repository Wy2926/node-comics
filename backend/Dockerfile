FROM python:3.11-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt && useradd --uid 10001 --create-home comics && mkdir -p /data/translation/inputs /data/translation/results /data/translation/staging && chown -R comics:comics /data
COPY app ./app
COPY alembic.ini ./
COPY migrations ./migrations
ARG RELEASE_ID=development
ENV RELEASE_ID=${RELEASE_ID} SERVE_STATIC=false
USER comics
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
