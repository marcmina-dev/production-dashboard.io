ALTER TABLE protrack_admin_sessions
  ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'admin' AFTER token_hash;
