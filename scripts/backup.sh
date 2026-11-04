#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"
[[ -f .env ]] || { echo "Missing .env; run npm run bootstrap:env" >&2; exit 1; }
set -a; source .env; set +a
mkdir -p backups; chmod 700 backups
output="${1:-backups/whatscobranca-$(date +%Y%m%dT%H%M%S).dump}"
umask 077
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -Fc --schema=public "$POSTGRES_DB" > "$output"
chmod 600 "$output"
echo "Backup created: $output"
