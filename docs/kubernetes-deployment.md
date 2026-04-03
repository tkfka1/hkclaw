# Kubernetes Deployment

HKClaw can run on Kubernetes, but only in a constrained shape that matches the runtime.

Architecture targets and image publication rules live in [multi-architecture-support.md](multi-architecture-support.md).

## Supported Model

- One replica only.
- One persistent writer for SQLite, task state, group folders, caches, and the writable service overlay env file.
- One admin HTTP port exposed from the main process on `/` and `/healthz`.

This is why the supported chart uses a `StatefulSet` with `replicas: 1` and a persistent volume, not a horizontally scaled `Deployment`.

## Runtime Assumptions Carried Into Kubernetes

- SQLite remains local file storage, normally under `store/messages.db`.
- Runtime folders remain local writable paths:
  - `data/`
  - `groups/`
  - `cache/`
  - `logs/`
  - `admin-assets/`
- `HKCLAW_SERVICE_ENV_PATH` must point to a writable file because HKClaw updates that overlay when token refresh rotates credentials.

## Secrets and Config Injection

There are two separate concerns:

1. Bootstrap admin login.
   - Inject `HKCLAW_ADMIN_USERNAME` and `HKCLAW_ADMIN_PASSWORD` from a Kubernetes `Secret`.
2. Service runtime env.
   - Put service-scoped env into a bootstrap secret entry such as `service.env`.
   - The chart copies that file into the persistent volume during init so the running container can keep the file writable.

Do not mount the service overlay secret directly at `HKCLAW_SERVICE_ENV_PATH`. Secret volumes are read-only, and token rotation would not be able to persist updates.

## Storage Model

The chart uses one PVC mounted at `/workspace` and points HKClaw at:

- `/workspace/store`
- `/workspace/data`
- `/workspace/groups`
- `/workspace/service.env`

This keeps the runtime coherent and avoids partial persistence. `ReadWriteOnce` storage is the expected mode.

## Scaling Constraints

Kubernetes should treat HKClaw as stateful middleware, not a stateless web tier.

- Do not run more than one replica against the same PVC.
- Do not enable HPA.
- Expect rolling updates to replace the single pod in place.
- If you need HA, the runtime first has to move SQLite and local task/session state out of the pod filesystem.

## What Lives In Helm vs Raw Cluster Manifests

Helm-managed objects:

- `StatefulSet`
- `Service`
- optional `Ingress`
- optional bootstrap `Secret` objects
- optional PVC

Cluster- or operator-managed inputs:

- existing storage classes and PV policy
- externally managed secrets
- ingress controller policy, DNS, and TLS issuer details
- any node placement or security policy specific to your cluster

The chart is intentionally generic about those operator-owned inputs and expects them to come from `values.yaml` or existing cluster resources.

When you publish multi-arch images, keep the Helm chart architecture-neutral and use cluster scheduling controls such as `nodeSelector` only when you need to pin workloads to a specific CPU architecture.

## Helm Chart

Chart path:

- `deploy/helm/hkclaw`

Minimal install flow:

1. Create a secret for the service overlay file.
2. Create a secret for admin login.
3. Install the chart with a persistent volume.

Example bootstrap secret:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: hkclaw-service-env
type: Opaque
stringData:
  service.env: |
    DISCORD_BOT_TOKEN=...
    CODEX_AUTH_JSON_B64=...
    CODEX_MODEL=gpt-5.4
    CODEX_EFFORT=high
```

Example admin secret:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: hkclaw-admin
type: Opaque
stringData:
  username: admin
  password: change-this
```

Install:

```bash
helm upgrade --install hkclaw ./deploy/helm/hkclaw \
  --set image.repository=ghcr.io/example/hkclaw \
  --set image.tag=1.2.12 \
  --set persistence.size=50Gi \
  --set serviceEnv.existingSecret=hkclaw-service-env \
  --set admin.existingSecret=hkclaw-admin
```

## Operational Notes

- `/healthz` is safe for Kubernetes probes and does not require admin login.
- The admin UI remains available on the same HTTP port as the health endpoint.
- Backup the PVC contents if you want durable restore of SQLite state, sessions, group folders, and rotated service credentials.
