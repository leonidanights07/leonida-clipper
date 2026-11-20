# Leonida Clipper — Cobalt backend image for Render
#
# Just the official Cobalt API image, with one change: Cobalt listens on
# API_PORT (default 9000), but Render injects its own PORT (default 10000)
# and only routes traffic to that port. So the start command maps
# Render's PORT onto API_PORT at container start time.
#
# Build: Render builds this from render.yaml at the repo root
# (runtime: docker, dockerfilePath: ./backend/Dockerfile).
# Local test (needs Docker, which is NOT available in this VM):
#   docker build -t leonida-cobalt ./backend
#   docker run --rm -p 9000:9000 -e API_URL=http://localhost:9000/ \
#     -e CORS_WILDCARD=1 leonida-cobalt
#   curl http://localhost:9000/   # should return cobalt version JSON
#
# No API key, no Turnstile, no cookies file on purpose — see render.yaml
# and README.md for why, and what to do if the URL gets abused.

FROM ghcr.io/imputnet/cobalt:latest

# The base image already runs as the `node` user, WORKDIR /app,
# EXPOSE 9000, and its default command is `node src/cobalt`.
# We only override the command so Render's $PORT becomes Cobalt's port.
# ${PORT:-9000} keeps 9000 as the fallback for local `docker run`.
CMD ["sh", "-c", "API_PORT=${PORT:-9000} exec node src/cobalt"]
