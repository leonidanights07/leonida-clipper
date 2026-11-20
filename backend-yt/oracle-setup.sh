#!/usr/bin/env bash
# Leonida Clipper — yt-dlp YouTube backend, Oracle Always Free VM setup
#
# Run ONCE on a fresh Oracle Cloud Always Free VM (Ubuntu 24.04, ARM):
#   1. Create the VM first (see DEPLOY-ALT-HOSTS.md): shape
#      VM.Standard.A1.Flex, 2 OCPU / 12 GB RAM, Ubuntu 24.04, in your
#      HOME region. A card is required at Oracle signup (identity check
#      only — Always Free resources are not billed; a temporary hold
#      may appear and is reversed).
#   2. Copy this whole repo (or at least backend-yt/) to the VM, then:
#        chmod +x backend-yt/oracle-setup.sh
#        sudo bash backend-yt/oracle-setup.sh
#   3. The script installs Docker, builds the backend-yt image, and runs
#      it as a systemd service on port 9000, restarting on boot.
#
# WHAT THIS DOES NOT DO (read before you start):
# - HTTPS: the Clipper page is served over https, so a browser will
#   REFUSE to call an http:// backend (mixed content). This script
#   leaves the service on plain http://<vm-ip>:9000 on purpose — so you
#   can FIRST test whether yt-dlp works from Oracle's IP with curl
#   (see the test at the end). Only if that test passes is it worth
#   setting up TLS. The two free TLS options are:
#     (a) Cloudflare Tunnel (free, no domain needed): install cloudflared,
#         `cloudflared tunnel --url http://localhost:9000` gives you an
#         https://<name>.trycloudflare.com URL (ephemeral) or, with a
#         free Cloudflare account, a stable subdomain.
#     (b) Your own domain (~$10/year) + Caddy: Caddy gets a free
#         Let's Encrypt certificate automatically for the domain.
# - Firewall: you must ALSO open port 9000 in the OCI console
#   (VCN -> Security Lists -> Ingress Rule: 0.0.0.0/0, TCP, port 9000),
#   or the VM will not answer from the internet at all.
# - IP risk: Oracle Cloud IPs are datacenter IPs too. YouTube may block
#   them just like Render's. The curl test below is the only way to know.
#
# Idle-reclaim warning: Oracle reclaims Always Free VMs it considers idle
# (low CPU + low network over 7 days). Keep the service in use, or
# upgrade to Pay As You Go (Always Free resources stay $0, reclaim no
# longer applies, but the upgrade places a ~US$100 temporary card hold).

set -euo pipefail

# --- 1. Docker -----------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker..."
  apt-get update
  apt-get install -y docker.io curl ca-certificates
  systemctl enable --now docker
fi

# --- 2. Build + run the backend ------------------------------------------
# This script expects to be run from the repo root, or with backend-yt/
# next to it. Adjust REPO_DIR if you copied the files elsewhere.
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR/backend-yt"

echo "Building leonida-yt image (ffmpeg + yt-dlp, a few minutes)..."
docker build -t leonida-yt .

# Public URL of this VM — set API_URL to the final https URL once TLS is
# set up; for the first http test, use the VM's public IP.
PUBLIC_IP="$(curl -s -m 10 ifconfig.me || echo localhost)"
API_URL="${API_URL:-http://${PUBLIC_IP}:9000}"

docker rm -f leonida-yt 2>/dev/null || true
docker run -d --name leonida-yt --restart unless-stopped \
  -p 9000:9000 \
  -e "PORT=9000" \
  -e "API_URL=${API_URL}" \
  -e "CORS_URL=https://leonidanights07.github.io" \
  leonida-yt

# --- 3. Systemd unit so it survives a reboot ----------------------------
cat > /etc/systemd/system/leonida-yt.service <<EOF
[Unit]
Description=Leonida Clipper yt-dlp backend
After=docker.service
Requires=docker.service

[Service]
Restart=always
ExecStart=/usr/bin/docker start -a leonida-yt
ExecStop=/usr/bin/docker stop leonida-yt

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable leonida-yt.service

echo
echo "Done. Waiting 5s, then testing:"
sleep 5
echo "--- GET / ---"
curl -s "http://localhost:9000/" || echo "FAILED: service did not answer on :9000"
echo
echo "--- POST / (Rick Astley test — this is the test that decides it) ---"
curl -s -m 120 -X POST "http://localhost:9000/" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}' || echo "FAILED"
echo
echo "If the POST above returned a tunnel URL, yt-dlp WORKS from Oracle's"
echo "IP — set up TLS (Cloudflare Tunnel or a domain + Caddy) and point"
echo "the Clipper page at the https URL. If it returned"
echo "error.api.fetch.fail, Oracle's IP is blocked too — stop here."
echo "Remember to open port 9000 in the OCI console security list."
