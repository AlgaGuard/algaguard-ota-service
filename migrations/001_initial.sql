CREATE TABLE ota_releases (id uuid PRIMARY KEY, hardware_model text NOT NULL, version text NOT NULL, size_bytes bigint NOT NULL, sha256 text NOT NULL, signature jsonb NOT NULL, object_key text NOT NULL, rollout_ring text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ota_assignments (id uuid PRIMARY KEY, release_id uuid NOT NULL REFERENCES ota_releases(id), device_id uuid NOT NULL, status text NOT NULL, assigned_at timestamptz NOT NULL DEFAULT now(), UNIQUE(release_id, device_id));

