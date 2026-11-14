-- Linked sign-in accounts (GitHub) of anonymous profiles: rated eligibility (DESIGN §Ladder, D2). Private.
CREATE TABLE ac_accounts (
  profile_id          text PRIMARY KEY,
  provider            text NOT NULL CHECK (provider = 'github'),
  subject             text NOT NULL,
  login               text NOT NULL,
  provider_created_at timestamptz NOT NULL,
  linked_at           timestamptz NOT NULL,
  UNIQUE (provider, subject)
);

-- Cluster evidence: SHA-256 digests of signals two accounts can share (IP prefix, device cookie, OAuth harness,
-- policy artifact). Private, never projected; rows older than 90 days are pruned.
CREATE TABLE ac_account_links (
  profile_id text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('ip', 'device', 'harness', 'artifact')),
  digest     text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  seen_at    timestamptz NOT NULL,
  PRIMARY KEY (profile_id, kind, digest)
);
CREATE INDEX ac_account_links_digest ON ac_account_links (kind, digest);
