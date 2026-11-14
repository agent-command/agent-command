-- Agent Command's own tables (applied by playerthree/postgres under scope `agent-command`, after PlayerThree's).
-- Anonymous player profiles: the secret is never stored, only its SHA-256 digest (hex).
CREATE TABLE ac_profiles (
  id            text PRIMARY KEY,
  secret_digest text NOT NULL UNIQUE,
  created_at    bigint NOT NULL
);
