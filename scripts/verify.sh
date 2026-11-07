#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"
umask 077
# Contrato config.ts ↔ docker-compose.yml: falha cedo, antes de subir containers.
node scripts/check-compose-env.mjs
# Deliberately ignore .env and inherited operational configuration.
export POSTGRES_DB=whatscobranca_verify POSTGRES_USER=whatscobranca
export POSTGRES_PASSWORD=verify_password_please_change
export DATABASE_URL='postgresql://whatscobranca:verify_password_please_change@postgres:5432/whatscobranca_verify?schema=public'
export AUTOMATION_TOKEN=verify_automation_token_0123456789abcdef
export WAHA_WEBHOOK_SECRET=verify_webhook_secret_0123456789abcdef
export WAHA_API_KEY=verify-isolated-key WAHA_BASE_URL=http://waha-test:8090
export WAHA_SESSION=default OPERATOR_LID=00000000000000@lid OPERATOR_PHONE=5511999999999@c.us
export GROQ_API_KEY=verify-isolated-key GROQ_BASE_URL=http://groq-test:8091
export GROQ_STT_MODEL=whisper-large-v3 GROQ_LLM_MODEL=llama-3.3-70b-versatile
export WAHA_MEDIA_MAX_BYTES=65536
export N8N_ENCRYPTION_KEY=verify_n8n_encryption_key_0123456789
compose=(docker compose --env-file /dev/null -f docker-compose.yml -f docker-compose.verify.yml --project-name whatscobranca_verify)
# Recreate only the isolated test network/containers, keeping its volumes.
"${compose[@]}" down --remove-orphans
"${compose[@]}" up -d --wait --wait-timeout 180 postgres waha-test groq-test
"${compose[@]}" stop n8n core-api webhook-proxy n8n-init n8n-schema
# Only these fixed verification databases may be reset. No operational volume removal.
"${compose[@]}" exec -T postgres psql -U whatscobranca -d postgres -v ON_ERROR_STOP=1 \
  -c 'DROP DATABASE IF EXISTS whatscobranca_verify WITH (FORCE);' \
  -c 'CREATE DATABASE whatscobranca_verify;' \
  -c 'DROP DATABASE IF EXISTS whatscobranca_verify_test WITH (FORCE);' \
  -c 'CREATE DATABASE whatscobranca_verify_test;' \
  -c 'DROP DATABASE IF EXISTS whatscobranca_verify_restore WITH (FORCE);'
"${compose[@]}" up -d --build --force-recreate --wait --wait-timeout 240
integration_url='postgresql://whatscobranca:verify_password_please_change@postgres:5432/whatscobranca_verify_test?schema=public'
"${compose[@]}" run --rm --no-deps -e DATABASE_URL="$integration_url" core-api npx prisma migrate deploy
"${compose[@]}" run --rm --no-deps -e DATABASE_URL="$integration_url" core-api npx tsx test/integration.ts
node scripts/verify-http.mjs
printf '%s\n' 'VERIFY PASS: PostgreSQL integration, real local HTTP chain, imported active n8n webhook and schedule, Core restart recovery, proxy isolation, unique/FK enforcement and exact-value new-database restore.'
