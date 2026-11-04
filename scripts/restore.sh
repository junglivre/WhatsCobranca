#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"
backup_file="${1:?Usage: npm run restore -- backups/file.dump NEW_database}"
target_db="${2:?Usage: npm run restore -- backups/file.dump NEW_database}"
env_file="${WHATSCOBRANCA_ENV_FILE:-.env}"
[[ -f "$env_file" ]] || { echo "Missing environment file" >&2; exit 1; }
set -a; source "$env_file"; set +a
# Validate after loading the actual operational database name.
[[ "$target_db" =~ ^[a-zA-Z_][a-zA-Z0-9_]{0,62}$ ]] || { echo "Unsafe target database name" >&2; exit 2; }
[[ "$target_db" != "${POSTGRES_DB:?Missing POSTGRES_DB}" && "$target_db" != postgres && "$target_db" != template0 && "$target_db" != template1 ]] || { echo "Refusing operational/system database target" >&2; exit 2; }
[[ -f "$backup_file" ]] || { echo "Backup not found" >&2; exit 2; }
compose=(docker compose --env-file "$env_file")
exists="$("${compose[@]}" exec -T postgres psql -U "${POSTGRES_USER:?Missing POSTGRES_USER}" -d postgres -At -v ON_ERROR_STOP=1 -c "SELECT datname FROM pg_database WHERE datname = '$target_db';")"
[[ -z "$exists" ]] || { echo "Refusing existing target database; choose a NEW name" >&2; exit 2; }
# CREATE DATABASE itself refuses concurrent creation. Never drop a database.
"${compose[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$target_db\";"
# The archive creates public itself. Only remove the empty default schema
# in the database that this invocation just created, never in an existing DB.
"${compose[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d "$target_db" -v ON_ERROR_STOP=1 -c "DROP SCHEMA public;"
"${compose[@]}" exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$target_db" --exit-on-error --no-owner --no-privileges < "$backup_file"
echo "Restored into NEW database: $target_db"
