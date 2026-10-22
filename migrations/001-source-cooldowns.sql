CREATE TABLE IF NOT EXISTS reeltone_source_cooldowns (
  cooldown_key TEXT PRIMARY KEY,
  cooldown_until TIMESTAMPTZ NOT NULL,
  strike_count SMALLINT NOT NULL DEFAULT 1 CHECK (strike_count BETWEEN 1 AND 8),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
