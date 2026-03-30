# HKClaw Service Concepts

## 1. Three Axes

HKClaw treats one running bot as a combination of three axes.

- `SERVICE_ID`
  Concrete runtime identity. This is the partition key for sessions, registered groups, tasks, and work items.
- `SERVICE_AGENT_TYPE`
  The LLM family. Current values are `claude-code` and `codex`. `claude` is accepted as an alias and normalized to `claude-code`.
- `SERVICE_ROLE`
  The usage shape. Current values are `dashboard`, `chat`, and `assistant`.

In short:

```text
one process = one SERVICE_ID
SERVICE_ID belongs to one SERVICE_AGENT_TYPE
SERVICE_ID also declares one SERVICE_ROLE
```

Example layouts:

```text
hkclaw               -> SERVICE_ID=claude,    SERVICE_AGENT_TYPE=claude-code, SERVICE_ROLE=assistant
hkclaw-codex         -> SERVICE_ID=codex,     SERVICE_AGENT_TYPE=codex,       SERVICE_ROLE=chat
hkclaw-dashboard     -> SERVICE_ID=dashboard, SERVICE_AGENT_TYPE=claude-code, SERVICE_ROLE=dashboard
```

## 2. Why `SERVICE_ID` Matters

Before this change, a lot of runtime state was effectively partitioned only by `agent_type`.
That worked for "one Claude + one Codex", but it broke down as soon as multiple bots shared the same model family.

Now the main state tables are scoped by `service_id`.

- `sessions`
- `registered_groups`
- `scheduled_tasks`
- `work_items`
- `router_state`

Practical result:

- Two Claude-based bots can now run side by side without sharing session IDs.
- A chat bot and an assistant bot can both be `claude-code` without clobbering each other's tasks.
- The dashboard can still aggregate cross-service state when it needs a global view.

## 3. Env Layering Model

HKClaw uses one shared base env and zero or more per-bot overlays.

```text
.env
  -> shared defaults and provider keys for the repo

.env.primary
  -> primary bot overrides managed from the web

.env.agent.<service_id>
  -> per-bot overrides

.env.codex
  -> legacy compatibility overlay
```

Recommended split:

- Put shared API keys and defaults in `.env`.
- Put primary bot identity and token values in `.env.primary`.
- Put additional bot identity and token values in `.env.agent.<service_id>`.

Minimal overlay:

```bash
ASSISTANT_NAME=ops
SERVICE_ID=ops
SERVICE_AGENT_TYPE=claude
SERVICE_ROLE=chat
DISCORD_BOT_TOKEN=
```

## 4. Service Discovery Flow

When `npm run setup -- --step service` runs:

1. HKClaw reads `.env`.
2. It scans the repo root for `.env.agent.*`.
3. It also checks `.env.codex` for backward compatibility.
4. Each discovered service is normalized into:
   - service name: `hkclaw` or `hkclaw-<service_id>`
   - launchd label: `com.hkclaw` or `com.hkclaw-<service_id>`
   - env block: `SERVICE_ID`, `SERVICE_AGENT_TYPE`, `SERVICE_ROLE`, `ASSISTANT_NAME`
5. It writes service manager units for the current platform.
6. Each unit launches the same `dist/index.js`, but with a different env overlay.

Conceptually:

```text
.env + overlays
    -> service discovery
    -> normalized service definitions
    -> systemd/launchd/nohup units
    -> multiple bot processes from one codebase
```

## 5. Boot Flow Log

```text
service manager starts hkclaw-<service_id>
  -> dist/index.js boots
  -> config resolves SERVICE_ID / SERVICE_AGENT_TYPE / SERVICE_ROLE
  -> SQLite schema/migrations run
  -> router_state loads with SERVICE_ID-prefixed keys
  -> sessions load only for this SERVICE_ID
  -> registered_groups load only for this SERVICE_ID
  -> scheduler loop starts for this SERVICE_ID
  -> channel clients connect
  -> message loop and IPC watchers begin
```

## 6. Text Message Flow Log

```text
Discord message arrives
  -> channel adapter normalizes it
  -> chat metadata and message rows are stored
  -> message loop fetches new rows by seq cursor
  -> current service loads only its own registered groups
  -> trigger / allowlist / paired-room rules are applied
  -> GroupQueue serializes work per room
  -> selected runner executes Claude or Codex
  -> streamed output may emit progress / final / tool activity
  -> result is stored as a work item
  -> delivery step posts the final message back to Discord
  -> seq cursor and session state are persisted for this SERVICE_ID
```

## 7. Voice Channel Flow Log

Voice is not a separate role. It is a channel capability enabled by `DISCORD_VOICE_*` settings on any non-dashboard service.

```text
configured Discord voice room becomes active
  -> voice client connects
  -> PCM/audio chunks accumulate
  -> silence cutoff triggers transcription
  -> transcript is converted into a synthetic inbound text message
  -> normal text pipeline runs
  -> final answer may be posted as text
  -> TTS may synthesize spoken output back into the voice room
```

## 8. Scheduled Task Flow Log

```text
MCP tool or IPC creates a task
  -> task row stores service_id + agent_type
  -> scheduler loop for that same SERVICE_ID polls due tasks
  -> queue and runner execute in the target group context
  -> status tracker updates Discord status messages
  -> task result is logged
  -> next_run / status / suspension state are persisted
```

## 9. Role Interpretation

`SERVICE_ROLE` is partly semantic and partly behavioral.
`dashboard` is the only hard execution split:

- `dashboard` renders the Discord dashboard
- `dashboard` also exposes the local admin web UI
- `dashboard` does not run the interactive message loop, scheduler, or IPC worker

The other roles (`chat`, `assistant`) still share the interactive runtime and are mainly differentiated by env and registration choices.

Current intended meaning:

- `dashboard`
  Status aggregation, room visibility, operational views, and the local admin web UI.
- `chat`
  General conversation bot. Voice channel handling can also be enabled here.
- `assistant`
  More stateful and operationally heavy bot. Good fit for scheduling, memory-heavy workflows, and main control rooms.

## 10. Recommended Operating Pattern

```text
LLM families
  1. codex
  2. claude

usage roles
  1. dashboard
  2. chat
  3. assistant
```

One practical mapping:

- `hkclaw`
  Claude assistant
- `hkclaw-codex`
  Codex chat bot
- `hkclaw-dashboard`
  Claude dashboard bot

Voice channels attach through env:

- `DISCORD_VOICE_CHANNEL_IDS`
- `DISCORD_VOICE_TARGET_JID`
- `DISCORD_VOICE_ROUTE_MAP`
- `DISCORD_VOICE_GROUP_FOLDER`
- `DISCORD_VOICE_GROUP_NAME`

## 11. Admin Web Flow Log

```text
dashboard service boots
  -> channels connect for status rendering
  -> unified dashboard starts
  -> local HTTP server binds to HKCLAW_ADMIN_HOST:HKCLAW_ADMIN_PORT
  -> admin page reads discovered services, registered_groups, chats, and status snapshots
  -> operator edits service env overlays or channel assignments
  -> service save schedules a topology reconcile
  -> channel mapping change updates registered_groups and restarts the affected service
```
