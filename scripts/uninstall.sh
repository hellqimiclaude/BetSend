#!/usr/bin/env bash
#
# Stops BetSend and removes the systemd service.
# Your files, database and config.json are kept unless you pass --remove-data.
#
#   sudo ./scripts/uninstall.sh
#   sudo ./scripts/uninstall.sh --remove-data
#
set -euo pipefail

SERVICE_NAME="betsend"
REMOVE_DATA=0
APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --remove-data) REMOVE_DATA=1; shift ;;
    -h|--help)     sed -n '2,8p' "$0"; exit 0 ;;
    *)             printf 'unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { printf '\nThis needs to run as root. Re-run with sudo.\n\n' >&2; exit 1; }

printf '\n'

if systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE_NAME}.service"; then
  systemctl stop    "$SERVICE_NAME" 2>/dev/null || true
  systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload
  printf '\033[32m  Service removed.\033[0m\n'
else
  printf '\033[90m  No service found.\033[0m\n'
fi

if [ "$REMOVE_DATA" -eq 1 ]; then
  CONFIG_PATH="$APP_ROOT/config.json"
  if [ -f "$CONFIG_PATH" ]; then
    STORAGE_DIR="$(node -e 'process.stdout.write(String(require(process.argv[1]).storageDir||""))' "$CONFIG_PATH" 2>/dev/null || true)"
    if [ -n "$STORAGE_DIR" ] && [ -d "$STORAGE_DIR" ]; then
      rm -rf "$STORAGE_DIR"
      printf '\033[33m  Deleted %s.\033[0m\n' "$STORAGE_DIR"
    fi
  fi
else
  printf '\033[90m  Your files and database were kept. Use --remove-data to delete them too.\033[0m\n'
fi

printf '\n\033[32m  BetSend removed.\033[0m\n\n'
