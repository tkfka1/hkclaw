# Container Deployment

HKClaw can run in a container, but the image has to preserve the repo layout that the runtime expects.

Architecture targets and native dependency notes live in [multi-architecture-support.md](multi-architecture-support.md).

## Runtime Assumptions

- The main service runs from the project root and starts with `node dist/index.js`.
- Both runner packages must already be built:
  - `runners/agent-runner/dist/index.js`
  - `runners/codex-runner/dist/index.js`
- Persistent state is file-backed, not externalized:
  - SQLite DB: `store/messages.db`
  - task/session IPC state: `data/`
- registered group folders: `groups/`
- caches and voice/transcription scratch space: `cache/`
- optional admin map assets: `admin-assets/`
- Service-specific auth and model settings are expected to live in a writable overlay file referenced by `HKCLAW_SERVICE_ENV_PATH`.
- Admin web first render uses bundled HTML/CSS with local system font stacks, so restricted containers do not need outbound access to Google Fonts or other public font CDNs.

That means a production container should not be treated as a stateless single-binary bot image.

## Files Added Here

- `Dockerfile`: multi-stage build for the main app plus both runner packages
- `docker-compose.yml`: single-service deployment example with persistent bind mounts

## Build

Single-architecture local build:

```bash
docker build -t hkclaw:local .
```

Recommended release build for both supported container targets:

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t hkclaw:<tag> \
  --push .
```

## Compose Workflow

1. Create `.env` for shared defaults such as `HKCLAW_ADMIN_PORT`.
2. Create a writable service overlay file such as `.env.agent.primary`.
3. Set `HKCLAW_SERVICE_ENV_FILE` if you want Compose to mount a different overlay file.
4. Start the stack:

```bash
docker compose up -d --build
```

The provided compose file mounts:

- `./data` to `/app/data`
- `./store` to `/app/store`
- `./groups` to `/app/groups`
- `./cache` to `/app/cache`
- `./logs` to `/app/logs`
- `./admin-assets` to `/app/admin-assets`
- `./.env` to `/app/.env` as read-only
- one writable service overlay file to the path named by `HKCLAW_SERVICE_ENV_PATH`

## Required Operator Decisions

### Auth Material

Choose one of these models:

- Put service credentials directly in the mounted overlay file, such as `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_AUTH_JSON_B64`, `OPENAI_API_KEY`, or `GROQ_API_KEY`.
- Mount host auth directories separately if you want HKClaw to inherit and refresh account state from container-visible homes.

If you rely on automatic Claude/Codex credential inheritance, the container also needs access to the relevant home directories, for example:

- `~/.claude`
- `~/.claude-accounts`
- `~/.codex`
- `~/.codex-accounts`

Those mounts are intentionally not hard-coded into the example compose file because they are host-specific and security-sensitive.

### Overlay File Writability

Do not mount the service overlay read-only. HKClaw updates service overlays when token refresh rotates credentials.

### Admin Exposure

The compose example publishes port `4622` by default. If you expose it beyond localhost, set bootstrap admin credentials in `.env`:

```bash
HKCLAW_ADMIN_USERNAME=admin
HKCLAW_ADMIN_PASSWORD=change-this-before-exposing-the-port
```

## Persistence Summary

For backup and restore, preserve at minimum:

- `store/`
- `data/`
- `groups/`
- the mounted service overlay file

`cache/` is recommended for smoother restarts but is not the primary durable source of truth.
