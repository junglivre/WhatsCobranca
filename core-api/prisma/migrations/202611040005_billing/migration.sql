-- Fase 6: financeiro plugável. O banco NUNCA guarda estado cru de provedor:
-- status/métodos são os enums internos do domínio; o adapter traduz.
-- charges.provider + customer_provider_refs.provider são a chave do adapter
-- ('asaas', 'manual', ...), permitindo múltiplos provedores coexistindo.

-- Referência externa do cliente POR provedor (um cliente pode existir em
-- vários provedores de cobrança ao mesmo tempo).
CREATE TABLE customer_provider_refs (
  customer_id uuid NOT NULL REFERENCES customers(id),
  provider text NOT NULL,
  external_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, provider),
  UNIQUE (provider, external_id)
);

-- Intenção de cobrança persistida ANTES da chamada ao provedor (DRAFT).
-- external_reference = 'OS-<numero>-C<seq>' permite reconciliar timeout:
-- consultar o provedor pela referência antes de qualquer nova tentativa.
CREATE TABLE charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_order_id uuid NOT NULL REFERENCES service_orders(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  provider text NOT NULL,
  provider_charge_id text,
  method text NOT NULL CHECK (method IN ('PIX','BOLETO','CASH','EXTERNAL_PIX')),
  value_cents integer NOT NULL CHECK (value_cents > 0),
  due_date date,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING','OVERDUE','CONFIRMED','RECEIVED','PARTIALLY_PAID','CANCELED','REFUNDED','ERROR')),
  external_reference text NOT NULL,
  pix_copy_paste text,
  pix_qr_url text,
  paid_value_cents integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_charge_id)
);
CREATE INDEX charges_service_order_idx ON charges(service_order_id);
CREATE INDEX charges_status_due_idx ON charges(status, due_date) WHERE status IN ('PENDING','OVERDUE');
CREATE UNIQUE INDEX charges_external_reference_key ON charges(external_reference);

-- Ledger de webhooks financeiros: dedup por (provider, provider_event_id).
-- Persistir ANTES de processar; processamento assíncrono no tick.
CREATE TABLE billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  charge_id uuid REFERENCES charges(id),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  processed boolean NOT NULL DEFAULT false,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  position bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  UNIQUE (provider, provider_event_id)
);

-- Notas fiscais: objeto independente da cobrança (pode emitir sem pagamento).
-- A porta InvoiceProvider permite trocar o emissor (Asaas hoje, Portal
-- Nacional direto amanhã) sem tocar no domínio.
CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_order_id uuid NOT NULL REFERENCES service_orders(id),
  provider text NOT NULL,
  provider_invoice_id text,
  status text NOT NULL DEFAULT 'NOT_REQUESTED' CHECK (status IN ('NOT_REQUESTED','AWAITING_DATA','READY_FOR_APPROVAL','SUBMITTED','PROCESSING','AUTHORIZED','REJECTED','CANCELED','NEEDS_REVIEW')),
  payload jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_invoice_id)
);
CREATE INDEX invoices_service_order_idx ON invoices(service_order_id);
