# AlgaGuard OTA service

The portable OTA control plane stores immutable signed release metadata, rollout campaigns, per-device assignments, expiration, rollout rings, and idempotent device status history in PostgreSQL. Release registration is restricted to the firmware release service client and streams the object from S3-compatible storage to verify its exact size, SHA-256 digest, and configured public-key signature before publication. Private signing keys are never accepted or stored.

Rollouts require an Access Service decision for every device, reject cross-organization campaigns, fetch authoritative hardware/current-version metadata from Device Service, and reject hardware mismatch or downgrade unless an explicit recovery policy is introduced later. Assignments expire and produce short-lived provider-neutral download URLs through `ObjectStorage`; no AWS types enter the domain.

```sh
npm ci
npm run migrate
npm run check
docker build -t algaguard-ota-service:local .
```

The development workflow uses ECDSA P-256/SHA-256 signatures over the firmware binary. Ed25519 verification is supported for objects up to 64 MiB because Node verification requires the complete message. This repository does not claim production signing, cloud deployment, physical OTA installation, MicroSD validation, or battery validation.
