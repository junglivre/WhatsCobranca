-- Fase 5: estoque/materiais. Quantidades em numeric(12,3) — aritmética sempre
-- no SQL, nunca Float em JS. Item de OS sem inventory_item_id fica pendente de
-- classificação e não baixa estoque.
CREATE TABLE inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  normalized_name text NOT NULL,
  unit text NOT NULL,
  quantity numeric(12,3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  min_quantity numeric(12,3),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_items_normalized_name_idx ON inventory_items(normalized_name);

CREATE TABLE service_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_order_id uuid NOT NULL REFERENCES service_orders(id),
  inventory_item_id uuid REFERENCES inventory_items(id),
  raw_name text NOT NULL CHECK (length(btrim(raw_name)) > 0),
  quantity numeric(12,3) NOT NULL CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_order_items_order_idx ON service_order_items(service_order_id);

CREATE TABLE stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id),
  movement_type text NOT NULL CHECK (movement_type IN ('IN','OUT','ADJUST','RETURN')),
  quantity numeric(12,3) NOT NULL CHECK (quantity > 0),
  reason text,
  service_order_id uuid REFERENCES service_orders(id),
  operator_id uuid NOT NULL REFERENCES operators(id),
  source_message_id uuid REFERENCES messages(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_item_idx ON stock_movements(inventory_item_id, created_at);
ALTER TABLE service_order_items ADD COLUMN position bigserial NOT NULL UNIQUE;
