-- Custo médio ponderado do material (limitação conhecida da Fase 5: "custo
-- médio do material não é calculado"). NULL até a primeira entrada com custo
-- informado — sem custo nunca é inventado como zero.
ALTER TABLE inventory_items ADD COLUMN average_cost_cents int;
