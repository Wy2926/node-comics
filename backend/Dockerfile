FROM node:22-bookworm-slim AS admin-build
WORKDIR /admin-ui
COPY admin-ui/package*.json ./
RUN npm ci
COPY admin-ui ./
RUN npm run build

FROM node:22-bookworm-slim AS website-build
WORKDIR /website
COPY extension-release.json /extension-release.json
COPY website/package*.json ./
RUN npm ci
COPY website ./
RUN npm run build

FROM python:3.11-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt && useradd --uid 10001 --create-home comics && mkdir -p /data/images && chown -R comics:comics /data
COPY app ./app
COPY extension-release.json ./extension-release.json
COPY --from=admin-build /app/admin_web/dist ./app/admin_web/dist
COPY --from=website-build /website/dist ./app/website_dist
COPY alembic.ini ./
COPY migrations ./migrations
USER comics
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
