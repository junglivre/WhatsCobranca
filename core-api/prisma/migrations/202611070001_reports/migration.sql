-- Fase 8: entregas de relatórios agendados (dedup por período).
-- kind: 'DAILY_CLOSE' | 'WEEKLY'; period_key: 'YYYY-MM-DD' (diário) ou
-- 'W:<segunda-feira ISO>' (semanal). O INSERT ... ON CONFLICT DO NOTHING no
-- runner decide "enviar ou já enviado" de forma atômica entre ticks.
CREATE TABLE report_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  period_key text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, period_key)
);
