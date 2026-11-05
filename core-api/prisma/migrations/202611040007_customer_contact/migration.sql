-- Fase 6.5: dados de contato/fiscais do tomador e consentimento explícito
-- para mensagens financeiras. Todo campo de contato é opcional; opt-in
-- começa false para nunca enviar cobrança sem autorização inequívoca.
ALTER TABLE customers
  ADD COLUMN phone text,
  ADD COLUMN email text,
  ADD COLUMN address_street text,
  ADD COLUMN address_number text,
  ADD COLUMN address_district text,
  ADD COLUMN address_city text,
  ADD COLUMN address_state char(2),
  ADD COLUMN address_zip text,
  ADD COLUMN billing_opt_in boolean NOT NULL DEFAULT false;
