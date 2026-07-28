#!/usr/bin/env bash
#
# Installs BetSend as a systemd service on a Linux host.
# Idempotent — re-run after a `git pull` to rebuild and restart.
#
#   sudo ./scripts/install.sh
#   sudo ./scripts/install.sh --port 80 --storage /srv/betsend
#   ./scripts/install.sh --no-service        # build and configure only
#
set -euo pipefail

PORT=8080
STORAGE_DIR=""
NO_SERVICE=0
SERVICE_NAME="betsend"

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cyan()  { printf '\n\033[36m==> %s\033[0m\n' "$1"; }
ok()    { printf '\033[32m    %s\033[0m\n' "$1"; }
note()  { printf '\033[90m    %s\033[0m\n' "$1"; }
warn()  { printf '\033[33m    %s\033[0m\n' "$1"; }
die()   { printf '\n\033[31mSetup stopped: %s\033[0m\n\n' "$1" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --port)       PORT="$2"; shift 2 ;;
    --storage)    STORAGE_DIR="$2"; shift 2 ;;
    --no-service) NO_SERVICE=1; shift ;;
    -h|--help)    sed -n '2,10p' "$0"; exit 0 ;;
    *)            die "unknown option '$1'" ;;
  esac
done

[ -n "$STORAGE_DIR" ] || STORAGE_DIR="$APP_ROOT/data"

cd "$APP_ROOT"
printf '\n  \033[1mBetSend setup\033[0m\n  \033[90m%s\033[0m\n' "$APP_ROOT"

# --- 0. preconditions ------------------------------------------------------

cyan 'Checking Node.js'
command -v node >/dev/null 2>&1 || die 'Node.js is not installed. Install Node.js 20 or newer, then run this again.'

NODE_EXE="$(command -v node)"
NODE_VERSION="$("$NODE_EXE" --version)"
NODE_MAJOR="${NODE_VERSION#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js $NODE_VERSION is too old. BetSend needs 20 or newer."
ok "Node.js $NODE_VERSION at $NODE_EXE"

command -v npm >/dev/null 2>&1 || die 'npm was not found alongside Node.js.'

if [ "$NO_SERVICE" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
  die 'registering the service needs root. Re-run with sudo, or pass --no-service.'
fi

# --- 1. build --------------------------------------------------------------

cyan 'Installing dependencies (this takes a minute the first time)'
npm install
ok 'dependencies installed'

cyan 'Building the app'
npm run build
ok 'built'

# --- 2. configuration ------------------------------------------------------

cyan 'Configuration'
CONFIG_PATH="$APP_ROOT/config.json"

if [ -f "$CONFIG_PATH" ]; then
  ADMIN_TOKEN="$(node -e 'process.stdout.write(String(require(process.argv[1]).adminToken||""))' "$CONFIG_PATH")"
  PORT="$(node -e 'process.stdout.write(String(require(process.argv[1]).port||8080))' "$CONFIG_PATH")"
  STORAGE_DIR="$(node -e 'process.stdout.write(String(require(process.argv[1]).storageDir||""))' "$CONFIG_PATH")"
  ok 'kept your existing config.json'
else
  ADMIN_TOKEN="$(node -e 'process.stdout.write(require("crypto").randomBytes(18).toString("base64").replace(/[+/=]/g,"").slice(0,20))')"
  PORT="$PORT" STORAGE_DIR="$STORAGE_DIR" ADMIN_TOKEN="$ADMIN_TOKEN" node -e '
    const fs = require("fs");
    fs.writeFileSync(process.argv[1], JSON.stringify({
      port: Number(process.env.PORT),
      host: "0.0.0.0",
      storageDir: process.env.STORAGE_DIR,
      adminToken: process.env.ADMIN_TOKEN,
      retentionHours: 72,
      maxUploadSize: 0,
      deleteAfterAllDownloaded: true,
      registrationMode: "open",
    }, null, 2) + "\n");
  ' "$CONFIG_PATH"
  ok 'created config.json with a generated admin token'
fi

mkdir -p "$STORAGE_DIR" "$APP_ROOT/logs"
note "storage: $STORAGE_DIR"

# --- 3. service ------------------------------------------------------------

if [ "$NO_SERVICE" -eq 0 ]; then
  cyan 'Registering BetSend to start at boot'

  UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
  cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=BetSend office file transfer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_ROOT}
ExecStart=${NODE_EXE} ${APP_ROOT}/server/dist/index.js
Restart=always
RestartSec=5
# Uploads can be large and long-lived; do not let systemd kill them.
TimeoutStopSec=30
StandardOutput=append:${APP_ROOT}/logs/betsend.log
StandardError=append:${APP_ROOT}/logs/betsend.log

[Install]
WantedBy=multi-user.target
UNIT

  # Ports below 1024 need an explicit capability for a non-root service; this
  # unit runs as root, so nothing extra is required.
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null
  systemctl restart "$SERVICE_NAME"
  ok "systemd unit written to $UNIT_PATH"

  cyan 'Starting BetSend'
  HEALTHY=0
  for _ in $(seq 1 60); do
    sleep 1
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then HEALTHY=1; break; fi
  done

  if [ "$HEALTHY" -eq 1 ]; then
    ok 'running'
  else
    warn 'It did not answer within a minute.'
    warn "Check: journalctl -u ${SERVICE_NAME} -n 50   (or logs/betsend.log)"
  fi

  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    ufw allow "${PORT}/tcp" >/dev/null 2>&1 || true
    ok "opened ${PORT}/tcp in ufw"
  fi
fi

# --- 4. tell the human what to do next -------------------------------------

SUFFIX=":${PORT}"
[ "$PORT" = "80" ] && SUFFIX=""

ADDRESSES="$(node -e '
  const os = require("os");
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const entry of list || [])
      if (entry.family === "IPv4" && !entry.internal) out.push(entry.address);
  process.stdout.write(out.join("\n"));
')"

printf '\n  \033[90m────────────────────────────────────────────────\033[0m\n'
printf '   \033[32mBetSend is set up.\033[0m\n\n'
printf '   Send this address round the office:\n'
if [ -n "$ADDRESSES" ]; then
  while IFS= read -r address; do printf '     \033[36mhttp://%s%s\033[0m\n' "$address" "$SUFFIX"; done <<< "$ADDRESSES"
else
  printf '     \033[36mhttp://<this machine'"'"'s IP>%s\033[0m\n' "$SUFFIX"
fi
printf '\n   Admin token (for the Admin page):\n'
printf '     \033[33m%s\033[0m\n' "$ADMIN_TOKEN"
printf '     \033[90mAlso saved in config.json.\033[0m\n'
printf '\n   Next: open the address, go to Admin, paste in your staff list.\n'
printf '   \033[90mThen set "Who can pick a name" to list-only.\033[0m\n'
if [ "$NO_SERVICE" -eq 0 ]; then
  printf '\n   Useful later:\n'
  printf '     \033[90mRestart      systemctl restart %s\033[0m\n' "$SERVICE_NAME"
  printf '     \033[90mStop         systemctl stop %s\033[0m\n' "$SERVICE_NAME"
  printf '     \033[90mLogs         journalctl -u %s -f\033[0m\n' "$SERVICE_NAME"
  printf '     \033[90mRemove       sudo ./scripts/uninstall.sh\033[0m\n'
fi
printf '  \033[90m────────────────────────────────────────────────\033[0m\n\n'
