ALTER TABLE ota_assignments ALTER COLUMN device_id TYPE text USING device_id::text;
ALTER TABLE ota_releases
  ADD COLUMN IF NOT EXISTS created_by text,
  ADD COLUMN IF NOT EXISTS published_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE ota_releases ALTER COLUMN rollout_ring DROP NOT NULL;
ALTER TABLE ota_releases ALTER COLUMN expires_at DROP NOT NULL;

CREATE TABLE IF NOT EXISTS ota_rollouts (
  id uuid PRIMARY KEY,
  release_id uuid NOT NULL REFERENCES ota_releases(id),
  rollout_ring text NOT NULL,
  status text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ota_assignments
  ADD COLUMN IF NOT EXISTS rollout_id uuid REFERENCES ota_rollouts(id),
  ADD COLUMN IF NOT EXISTS rollout_ring text,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS hardware_model text,
  ADD COLUMN IF NOT EXISTS running_version text;

CREATE TABLE IF NOT EXISTS ota_status_history (
  message_id uuid PRIMARY KEY,
  assignment_id uuid NOT NULL REFERENCES ota_assignments(id),
  device_id text NOT NULL,
  release_id uuid NOT NULL REFERENCES ota_releases(id),
  status text NOT NULL,
  progress_percent integer NOT NULL,
  downloaded_bytes bigint NOT NULL,
  reported_at timestamptz NOT NULL,
  running_version text NOT NULL,
  error jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ota_status_device_time
  ON ota_status_history(device_id,reported_at DESC);
