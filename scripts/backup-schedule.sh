#!/usr/bin/env bash
set -euo pipefail
# Chame este script de um agendador EXTERNO já autorizado (cron/systemd timer,
# CI etc.). O repositório não instala nenhum agendador no host.
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$root_dir/scripts/backup.sh"
