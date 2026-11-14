-- Curated snapshots have no foreign key to ephemeral match/series storage.
CREATE TABLE ac_benchmark_releases (
  id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  digest text NOT NULL,
  document jsonb NOT NULL,
  withdrawn_at timestamptz,
  PRIMARY KEY (id, revision)
);
