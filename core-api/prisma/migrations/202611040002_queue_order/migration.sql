-- Use durable sequence positions rather than transaction timestamps: a single
-- transaction can queue several replies with the same created_at value.
ALTER TABLE webhook_events ADD COLUMN position bigserial NOT NULL UNIQUE;
ALTER TABLE outbound_messages ADD COLUMN position bigserial NOT NULL UNIQUE;
ALTER TABLE service_orders ADD CONSTRAINT service_order_nonnegative_amount CHECK (amount_cents IS NULL OR amount_cents >= 0);
CREATE INDEX webhook_events_pending_position_idx ON webhook_events(state, position);
CREATE INDEX outbound_messages_operator_position_idx ON outbound_messages(operator_id, position);

ALTER TABLE service_orders DROP CONSTRAINT service_orders_status_check;
ALTER TABLE service_orders ADD CONSTRAINT service_orders_status_check
  CHECK (status IN ('RASCUNHO','AGUARDANDO_DADOS','AGUARDANDO_CONFIRMACAO','CONFIRMADA','CANCELADA'));