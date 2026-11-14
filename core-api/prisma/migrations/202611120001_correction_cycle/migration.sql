-- Ciclo de correções de 12/11/2026.
-- Todas as alterações são aditivas. Em especial, não se inventa data financeira
-- para linhas históricas: valores conhecidos viram movimentos LEGACY_UNDATED e
-- continuam fora de relatórios por período até uma conciliação auditada.

CREATE SEQUENCE charge_external_reference_seq;
CREATE SEQUENCE invoice_external_reference_seq;

ALTER TABLE charges
  ADD COLUMN issued_at timestamptz,
  ADD COLUMN operation_id uuid,
  ADD COLUMN reconciliation_required boolean NOT NULL DEFAULT false;

CREATE INDEX charges_provider_external_idx
  ON charges(provider, provider_charge_id) WHERE provider_charge_id IS NOT NULL;

ALTER TABLE billing_events
  ADD COLUMN state text NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING','LEASED','PROCESSED','NEEDS_REVIEW')),
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN lease_until timestamptz,
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_error text;
CREATE INDEX billing_events_ready_idx
  ON billing_events(state, next_attempt_at, position)
  WHERE state IN ('PENDING','LEASED');

-- Operações que exigem I/O externo. A referência é alocada antes do efeito e
-- source_message_id torna a intenção única para uma confirmação do operador.
CREATE TABLE financial_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_message_id uuid NOT NULL UNIQUE REFERENCES messages(id),
  webhook_event_id uuid NOT NULL UNIQUE REFERENCES webhook_events(id),
  operator_id uuid NOT NULL REFERENCES operators(id),
  kind text NOT NULL CHECK (kind IN ('CHARGE_CREATE','CHARGE_CANCEL','INVOICE_REQUEST','INVOICE_CANCEL','AUDIO_PROCESS')),
  provider text,
  charge_id uuid REFERENCES charges(id),
  invoice_id uuid REFERENCES invoices(id),
  external_reference text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING','LEASED','DONE','ERROR','UNCERTAIN','NEEDS_REVIEW')),
  attempts integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  reconciliation_only boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX financial_operations_ready_idx
  ON financial_operations(state, next_attempt_at, created_at)
  WHERE state IN ('PENDING','LEASED','UNCERTAIN');

ALTER TABLE charges
  ADD CONSTRAINT charges_operation_fk FOREIGN KEY (operation_id) REFERENCES financial_operations(id);

-- Registro econômico, e não apenas o último snapshot do gateway. amount é
-- sempre positivo; direction fornece o sinal. financial_at NULL só é aceito
-- para a proveniência explícita de legado que não pode entrar em períodos.
CREATE TABLE financial_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_order_id uuid NOT NULL REFERENCES service_orders(id),
  charge_id uuid REFERENCES charges(id),
  direction text NOT NULL CHECK (direction IN ('RECEIPT','REFUND')),
  value_cents integer NOT NULL CHECK (value_cents > 0),
  financial_at timestamptz,
  origin text NOT NULL CHECK (origin IN ('OPERATOR_EXTERNAL','GATEWAY_EVENT','GATEWAY_SNAPSHOT','LEGACY_UNDATED')),
  economic_key text NOT NULL UNIQUE,
  provider text,
  provider_payment_id text,
  source_message_id uuid REFERENCES messages(id),
  billing_event_id uuid UNIQUE REFERENCES billing_events(id),
  actor_id uuid NOT NULL REFERENCES operators(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((financial_at IS NOT NULL) OR origin = 'LEGACY_UNDATED')
);
CREATE INDEX financial_ledger_order_idx ON financial_ledger(service_order_id, financial_at);
CREATE INDEX financial_ledger_charge_idx ON financial_ledger(charge_id, financial_at);

-- Mantém o valor conhecido dos recebimentos legados, mas deliberadamente sem
-- data financeira. Não usa updated_at/now como aproximação.
INSERT INTO financial_ledger(
  service_order_id, charge_id, direction, value_cents, financial_at, origin,
  economic_key, provider, provider_payment_id, actor_id, metadata
)
SELECT c.service_order_id, c.id, 'RECEIPT', c.paid_value_cents, NULL,
       'LEGACY_UNDATED', 'legacy-charge:' || c.id::text, c.provider,
       c.provider_charge_id,
       (SELECT id FROM operators WHERE label = 'operador-poc1' ORDER BY created_at LIMIT 1),
       jsonb_build_object('migration', '202611120001', 'reason', 'paid_value_cents had no verifiable financial date')
  FROM charges c
 WHERE c.paid_value_cents IS NOT NULL AND c.paid_value_cents > 0;

-- A conta técnica só aparece em auditoria de worker/webhook; não possui
-- whatsapp_identity e portanto nunca ganha autorização de conversa.
INSERT INTO operators(label) VALUES ('system-financial-worker')
ON CONFLICT (label) DO NOTHING;

ALTER TABLE stock_movements
  ADD COLUMN provenance text NOT NULL DEFAULT 'PROVEN'
    CHECK (provenance IN ('PROVEN','LEGACY_UNVERIFIED'));
-- OUT antigo pode ter sido escrito sem a baixa correspondente. Não é seguro
-- usá-lo como prova para uma devolução automática futura.
UPDATE stock_movements
   SET provenance='LEGACY_UNVERIFIED'
 WHERE movement_type='OUT';
CREATE INDEX stock_movements_order_item_idx
  ON stock_movements(service_order_id, inventory_item_id, movement_type);

ALTER TABLE report_deliveries RENAME COLUMN sent_at TO reserved_at;
ALTER TABLE report_deliveries
  ADD COLUMN outbound_message_id uuid UNIQUE REFERENCES outbound_messages(id),
  ADD COLUMN delivered_at timestamptz;
