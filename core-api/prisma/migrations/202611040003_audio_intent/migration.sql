-- Fase 4: audio (Groq STT + LLM) sem persistir bytes de midia.
ALTER TABLE messages ADD COLUMN transcription text;
ALTER TABLE messages ADD COLUMN media_mimetype text;
ALTER TABLE messages ADD COLUMN media_path text;

ALTER TABLE service_orders ADD COLUMN due_date date;

-- Envelopes autenticados mas estruturalmente invalidos sao persistidos para
-- pericia e confirmados com 200 (WAHA faz retry com storm em 400).
ALTER TABLE webhook_events ALTER COLUMN message_db_id DROP NOT NULL;
ALTER TABLE webhook_events ALTER COLUMN session DROP NOT NULL;
ALTER TABLE webhook_events ALTER COLUMN message_id DROP NOT NULL;
ALTER TABLE webhook_events DROP CONSTRAINT webhook_events_state_check;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_state_check
  CHECK (state IN ('PENDING','PROCESSED','FAILED','INVALID'));
