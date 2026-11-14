-- Community ladder (DESIGN §Ladder). Ratings are derived from the signed commander log; these tables are its
-- incremental state, recomputed nightly from the log in (endedAt, matchId) order.

-- Quarterly seasons, closed early by a new build. A finished season's standings are frozen with their digest.
CREATE TABLE ac_seasons (
  id           text PRIMARY KEY,
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  game_version text NOT NULL,
  rules_hash   text NOT NULL,
  frozen_at    timestamptz,
  digest       text CHECK (digest ~ '^[a-f0-9]{64}$'),
  standings    jsonb
);

CREATE TABLE ac_ratings (
  pool               text NOT NULL,
  season             text NOT NULL,
  segment_id         text NOT NULL,
  public_id          text NOT NULL,
  mu                 double precision NOT NULL,
  sigma              double precision NOT NULL,
  games              integer NOT NULL,
  opponents_distinct integer NOT NULL,
  last_played        timestamptz NOT NULL,
  record             jsonb NOT NULL,
  PRIMARY KEY (pool, season, segment_id)
);
CREATE INDEX ac_ratings_public ON ac_ratings (public_id);

CREATE TABLE ac_rating_events (
  match_id   text NOT NULL,
  segment_id text NOT NULL,
  pool       text NOT NULL,
  season     text NOT NULL,
  at         timestamptz NOT NULL,
  before     jsonb NOT NULL,
  after      jsonb NOT NULL,
  weight     double precision NOT NULL,
  PRIMARY KEY (match_id, segment_id)
);
CREATE INDEX ac_rating_events_segment ON ac_rating_events (segment_id, at);

-- The matchmaker's record of each rated match it opened (lineups, owners' clusters): the verdict's input.
CREATE TABLE ac_rated_matches (
  match_id   text PRIMARY KEY,
  pool       text NOT NULL,
  created_at timestamptz NOT NULL,
  record     jsonb NOT NULL
);

-- Queue joins, found matches, dodges and metadata edits per account or commander: rate limits and dodge locks.
CREATE TABLE ac_rated_events (
  subject text NOT NULL,
  kind    text NOT NULL CHECK (kind IN ('join', 'match', 'dodge', 'metadata', 'gauntlet')),
  at      timestamptz NOT NULL
);
CREATE INDEX ac_rated_events_subject ON ac_rated_events (subject, kind, at);

CREATE TABLE ac_integrity_flags (
  id          text PRIMARY KEY,
  kind        text NOT NULL,
  subject     jsonb NOT NULL,
  detail      jsonb NOT NULL,
  created_at  timestamptz NOT NULL,
  reviewed_at timestamptz,
  decision    text CHECK (decision IN ('void', 'dismiss'))
);

-- Rated replays kept 180 days outside the session history's pruning (D10).
CREATE TABLE ac_rated_replays (
  match_id   text PRIMARY KEY,
  session    text NOT NULL,
  expires_at timestamptz NOT NULL,
  replay     json NOT NULL
);

-- Opt-in public cards (D5). No row: private.
CREATE TABLE ac_commander_cards (
  public_id      text PRIMARY KEY,
  owner          text NOT NULL,
  commander_id   text NOT NULL,
  public         boolean NOT NULL,
  disclose_model boolean NOT NULL,
  updated_at     timestamptz NOT NULL,
  UNIQUE (owner, commander_id)
);

-- Gauntlet runs (policy-only, never rated): one per segment and policy version per 24 h; every run is kept.
CREATE TABLE ac_gauntlet_runs (
  id            text PRIMARY KEY,
  public_id     text NOT NULL,
  segment_id    text NOT NULL,
  artifact      text NOT NULL,
  season        text NOT NULL,
  series_id     text NOT NULL,
  created_at    timestamptz NOT NULL,
  result        jsonb
);
CREATE INDEX ac_gauntlet_runs_segment ON ac_gauntlet_runs (segment_id, artifact, created_at);
