#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"
umask 077
env_file="${WHATSCOBRANCA_ENV_FILE:-.env}"
[[ -f "$env_file" ]] || { echo "Missing environment file" >&2; exit 2; }
env_value() { node "$root_dir/scripts/read-compose-env.mjs" "$env_file" "$1"; }
postgres_db="$(env_value POSTGRES_DB)" || { echo "Missing POSTGRES_DB" >&2; exit 2; }
postgres_user="$(env_value POSTGRES_USER)" || { echo "Missing POSTGRES_USER" >&2; exit 2; }
backup_dir="${BACKUP_DIR:-$root_dir/backups}"
retention_days="${BACKUP_RETENTION_DAYS:-14}"
[[ "$retention_days" =~ ^[1-9][0-9]{0,3}$ ]] || { echo "BACKUP_RETENTION_DAYS must be a positive integer" >&2; exit 2; }
[[ ! -L "$backup_dir" ]] || { echo "Refusing symlinked BACKUP_DIR" >&2; exit 2; }
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
[[ -d "$backup_dir" && ! -L "$backup_dir" ]] || { echo "Invalid BACKUP_DIR" >&2; exit 2; }
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
output="$backup_dir/whatscobranca-$stamp.dump"
temporary="$backup_dir/.whatscobranca-$stamp.dump.tmp"
[[ ! -e "$output" && ! -e "$temporary" ]] || { echo "Backup destination already exists" >&2; exit 2; }
cleanup() { [[ -e "$temporary" ]] && rm -f -- "$temporary"; }
trap cleanup EXIT
compose=(docker compose --env-file "$env_file")
"${compose[@]}" exec -T postgres pg_dump -U "$postgres_user" -Fc --schema=public "$postgres_db" > "$temporary"
[[ -s "$temporary" ]] || { echo "pg_dump produced an empty archive" >&2; exit 1; }
chmod 600 "$temporary"
mv -- "$temporary" "$output"
trap - EXIT

# Retenção: só arquivos regulares produzidos por este mecanismo, nunca links
# nem nomes arbitrários. O backup recém-promovido e o último válido anterior
# ficam preservados mesmo quando a política está vencida.
mapfile -t own_backups < <(find -P "$backup_dir" -maxdepth 1 -type f -name 'whatscobranca-????????T??????Z.dump' -printf '%f\n' | sort)
if (( ${#own_backups[@]} > 1 )); then
  newest="${own_backups[${#own_backups[@]}-1]}"
  for name in "${own_backups[@]}"; do
    [[ "$name" == "$newest" ]] && continue
    candidate="$backup_dir/$name"
    if [[ ! -L "$candidate" ]] && find -P "$candidate" -maxdepth 0 -type f -mtime "+$retention_days" -print -quit | grep -q .; then
      rm -f -- "$candidate"
    fi
  done
fi
printf 'Backup created: %s\n' "$output"
