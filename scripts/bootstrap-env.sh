#!/usr/bin/env bash
set -euo pipefail
umask 077
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$root_dir/.env"
if [[ -e "$env_file" ]]; then
  echo ".env already exists; preserving it."
  exit 0
fi
secret() { node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"; }
db_password="$(secret)"; automation="$(secret)"; webhook="$(secret)"; n8n_key="$(secret)"
cat > "$env_file" <<EOF
POSTGRES_DB=whatscobranca
POSTGRES_USER=whatscobranca
POSTGRES_PASSWORD=$db_password
DATABASE_URL=postgresql://whatscobranca:$db_password@postgres:5432/whatscobranca?schema=public
AUTOMATION_TOKEN=$automation
WAHA_WEBHOOK_SECRET=$webhook
# Fill these four from your own WAHA instance/session before starting the
# operational stack. OPERATOR_LID/OPERATOR_PHONE must be the LITERAL
# identifiers your session sends as payload.from -- see README.md.
WAHA_API_KEY=SET_YOUR_WAHA_API_KEY
WAHA_BASE_URL=SET_YOUR_WAHA_BASE_URL
WAHA_SESSION=SET_YOUR_WAHA_SESSION
OPERATOR_LID=SET_YOUR_OPERATOR_LID
OPERATOR_PHONE=SET_YOUR_OPERATOR_PHONE
N8N_ENCRYPTION_KEY=$n8n_key
# Audio (Fase 4): fill GROQ_API_KEY to enable voice notes; empty = audio disabled.
GROQ_API_KEY=
GROQ_BASE_URL=https://api.groq.com/openai/v1
GROQ_STT_MODEL=whisper-large-v3
GROQ_LLM_MODEL=llama-3.3-70b-versatile
WAHA_MEDIA_MAX_BYTES=16777216
EOF
chmod 600 "$env_file"
echo "Created .env with mode 600. Fill WAHA_API_KEY/WAHA_BASE_URL/WAHA_SESSION/OPERATOR_LID/OPERATOR_PHONE before starting the operational stack."
