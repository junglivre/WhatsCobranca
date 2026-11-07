-- Boleto: a Asaas devolve o link do PDF (bankSlipUrl) já na criação da
-- cobrança. Até aqui o operador só via "link disponível no painel Asaas" —
-- persistimos o link real para mostrar e, quando o cliente tiver telefone
-- e consentimento, oferecer o envio (mesmo fluxo do Pix copia-e-cola).
ALTER TABLE charges ADD COLUMN boleto_url text;
