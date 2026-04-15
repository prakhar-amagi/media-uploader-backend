CREATE TABLE stormforge_cache (
  channel_id TEXT PRIMARY KEY,
  channel_name TEXT,
  payload JSONB,
  last_fetched_at TIMESTAMP
);
