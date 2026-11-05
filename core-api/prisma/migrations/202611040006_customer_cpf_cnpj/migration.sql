-- Fase 6 (follow-up): CPF/CNPJ do cliente. O Asaas exige o documento do
-- pagador para criar cobrança; o campo é opcional porque clientes antigos
-- e clientes só de recebimento manual não precisam dele.
ALTER TABLE customers ADD COLUMN cpf_cnpj text;
