# Leonida Clipper — yt-dlp YouTube backend (Dockerfile for Render)
# Python 3.12 slim + ffmpeg + Node (yt-dlp's JS runtime for challenges)
# + yt-dlp from pip. No other dependencies: server.py is stdlib-only.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg curl ca-certificates nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir yt-dlp

WORKDIR /app
COPY server.py ./server.py

# Render sets $PORT; the server reads it. API_URL / CORS_URL come from
# Render env vars (see render.yaml / backend-yt/DEPLOY-YT.md).
CMD ["python3", "server.py"]
