# HKClaw

![Claude Agent SDK](https://img.shields.io/badge/Claude_Agent_SDK-0.2.81-blueviolet)
![Codex SDK](https://img.shields.io/badge/Codex_SDK-0.115.0-green)
![Node](https://img.shields.io/badge/Node-20+-339933?logo=nodedotjs&logoColor=white)
![Discord](https://img.shields.io/badge/Discord-Bot-5865F2?logo=discord&logoColor=white)

Dual-agent AI staff platform for Discord. HKClaw runs multiple Claude Code and Codex workers from one repository, one database, and one host, then exposes an admin web for staffing, routing, and service operations.

Korean version: [README.kr.md](README.kr.md)

Originally derived from [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw). Prompt design was also influenced by [Q00/ouroboros](https://github.com/Q00/ouroboros).

## What HKClaw Is

HKClaw treats each bot as a managed "staff member".

- One running bot = one service process.
- Each service has a unique `SERVICE_ID`.
- Each service chooses one model family with `SERVICE_AGENT_TYPE`.
- Each service declares one usage role with `SERVICE_ROLE`.
- All services share the same codebase and SQLite database, but runtime state is partitioned by `SERVICE_ID`.

That lets you run layouts such as:

- `hkclaw`: the primary assistant
- `hkclaw-codex`: a separate Codex worker
- `hkclaw-dashboard`: a dashboard-only operator service
- `hkclaw-ops`, `hkclaw-finance`, `hkclaw-map`, `hkclaw-dev`: additional role-specific bots

For a lower-level service model reference, see [docs/service-concepts.md](docs/service-concepts.md).

## Core Runtime Model

HKClaw has three main axes:

- `SERVICE_ID`: concrete runtime identity, state partition key, and service name suffix
- `SERVICE_AGENT_TYPE`: model family, currently `claude-code` or `codex`
- `SERVICE_ROLE`: operational role, with one hard split between `dashboard` and normal interactive workers

Practical consequences:

- Two Claude-based bots can run side by side without sharing session history.
- A dashboard service is operationally different from a chat worker.
- Admin-facing labels such as `chat` and `assistant` are accepted, but current runtime normalizes them to the normal worker role.
- Voice is not a separate role. Voice is a capability enabled by `DISCORD_VOICE_*`.
- Every service is generated from `.env` plus one overlay file.

## Install and Operating Account

### Recommended Host

HKClaw is designed for:

- Linux, including WSL Ubuntu on Windows
- macOS

Windows-native service management is not a first-class target. If you are on Windows, run HKClaw inside WSL Ubuntu.

Host-by-host support details live in [docs/host-support-matrix.md](docs/host-support-matrix.md).
Container deployment details live in [docs/container-deployment.md](docs/container-deployment.md).

### Which OS Account Should Install It

Install and run HKClaw from a dedicated operating-system account whenever possible.

Examples:

- personal lab: your own non-admin Linux or macOS account
- shared machine: a dedicated `hkclaw` or `ops-bot` account
- Windows host: a dedicated WSL user

Do not think of the bots as isolated from the installing account. They are not.

### Security Boundary: Host Account

All generated services run as the installing OS user:

- Linux: `systemctl --user`
- macOS: user `LaunchAgents`
- fallback Linux without systemd: repo-local `nohup` wrappers

That means every HKClaw bot inherits that user's machine-level access:

- files readable by that OS account
- SSH keys and Git credentials available to that OS account
- `~/.claude` and `~/.claude-accounts/*`
- `~/.codex` and `.codex-accounts/*`
- network access available to that OS account
- any shell commands the bot is allowed to execute

If you install HKClaw under a powerful personal account, every bot effectively operates with that account's machine permissions.

Recommended rule:

- use a dedicated, low-privilege OS account for HKClaw
- do not install under `root` unless you intentionally want system-wide privilege
- keep sensitive host files outside the reach of the HKClaw account when possible

### Security Boundary: Discord Bot Identity

Discord permissions are separate from host permissions.

- Host-side permissions come from the OS account that runs HKClaw.
- Discord-side permissions come from the bot token used by each service.

Important consequences:

- if two services reuse the same `DISCORD_BOT_TOKEN`, they are the same Discord bot identity
- if you want strict Discord permission separation, create a separate Discord application and bot token per service
- a service can only see and act in Discord where its bot token has been invited and granted permission

## Installation

### Prerequisites

- Node.js 20+ supported
- `.nvmrc` currently pins Node `22`
- build tools for native modules (`gcc`/`make` on Linux, Xcode Command Line Tools on macOS)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- [Codex CLI](https://github.com/openai/codex)
- Bun 1.0+ for browser-related workflows

### Recommended First Boot: Admin-First

The recommended onboarding flow is:

1. clone and build the repo
2. start the bootstrap admin web
3. open the admin page
4. create Discord bot services from the admin UI
5. let HKClaw write the env overlays and reconcile services for you

This means you do not need to hand-author `.env.primary` or `.env.agent.*` before first boot.

### 1. Clone and Build

```bash
git clone https://gitlab.com/el-psy/hkclaw.git
cd hkclaw
npm ci
npm run build:runners
npm run build
```

### 2. Optional Minimal `.env` for Admin Bind Only

For admin-first boot, `.env` is optional.

If you want to control the bind address or port, create a minimal `.env` like this:

```bash
HKCLAW_ADMIN_HOST=0.0.0.0
HKCLAW_ADMIN_PORT=4622
```

If you want browser login protection immediately, add bootstrap credentials:

```bash
HKCLAW_ADMIN_USERNAME=admin
HKCLAW_ADMIN_PASSWORD=change-this-before-exposing-the-port
```

HKClaw uses these values to create or update the first admin account in SQLite, then signs in through the web login form with a session cookie. If `HKCLAW_ADMIN_PASSWORD` is unset, HKClaw starts in bootstrap open mode and serves the admin web directly until at least one admin account exists.

The admin UI uses local system font stacks for first render, so bootstrap login and dashboard pages do not need public font CDNs or general internet access to paint correctly.

If you skip `.env`, HKClaw still boots the admin service with defaults.
By default it binds the admin web on `0.0.0.0:4622`, so you can also reach it from another machine at `http://<host-ip>:4622/` if the host firewall/network allows it.

### 3. Start the Bootstrap Admin Service

```bash
npm run setup -- --step service
```

Or, after install/build, use the package CLI:

```bash
hkclaw start
```

If no dashboard service is configured yet, HKClaw automatically creates a bootstrap admin service called `hkclaw-admin`.

What that bootstrap service does:

- serves the local admin web
- lets you create the first real services from inside the UI
- exists only until you create a real `dashboard` service

Generated targets:

- Linux user mode: `~/.config/systemd/user/hkclaw-admin.service`
- macOS user mode: `~/Library/LaunchAgents/com.hkclaw-admin.plist`
- Linux without systemd: `start-hkclaw-admin.sh`

The full host matrix, including Windows-native limitations and WSL fallback behavior, is documented in [docs/host-support-matrix.md](docs/host-support-matrix.md).

### Service CLI

When HKClaw is installed from npm, the package exposes an `hkclaw` CLI for the common service lifecycle:

```bash
hkclaw start
hkclaw stop
hkclaw restart
hkclaw status
hkclaw verify
```

Equivalent local npm scripts are also available:

```bash
npm run service:start
npm run service:stop
npm run service:restart
npm run service:status
```

### 4. Open the Admin Web

By default:

- `http://localhost:4622/`
- external access: `http://<host-ip>:4622/`

You can now do initial setup from the internal web instead of manually writing service files.

### 5. Prepare Auth and Bot Identities Under the Same OS Account

Before creating real worker services in admin, prepare the credentials that those services will use.

Discord side:

- create one Discord application per HKClaw service when you want strict separation
- generate a bot token for each one
- invite those bots only where needed

Claude side:

Claude services refresh tokens by reading that account's credential files:

- `~/.claude/.credentials.json`
- `~/.claude-accounts/{index}/.credentials.json`

Typical setup:

```bash
claude setup-token
```

For additional Claude accounts:

```bash
CLAUDE_CONFIG_DIR=~/.claude-accounts/1 claude setup-token
CLAUDE_CONFIG_DIR=~/.claude-accounts/2 claude setup-token
```

Then store access tokens per service with:

- `CLAUDE_CODE_OAUTH_TOKEN`
- `CLAUDE_CODE_OAUTH_TOKENS`

Codex side:

Codex uses OAuth-style auth materialized into session-local `.codex/auth.json`.

Per service, HKClaw resolves Codex auth in this order:

1. `CODEX_AUTH_JSON_B64` from the service overlay
2. the active rotated Codex account file
3. `~/.codex/auth.json` from the installing OS account

If you want full separation, give each service its own `CODEX_AUTH_JSON_B64`. If you do not, the service inherits the installing account's Codex login context.

Recommended Discord capabilities:

- text rooms: `View Channel`, `Send Messages`, `Read Message History`, `Attach Files`
- voice rooms: `View Channel`, `Connect`, `Speak`
- gateway intents: `Guilds`, `GuildMessages`, `GuildVoiceStates`, `DirectMessages`
- `Message Content` intent is strongly recommended for natural text handling

HKClaw will retry without the `Message Content` intent if Discord rejects it, but the normal operating mode expects it.

### 6. Create Real Services from the Admin Web

From the admin page:

1. create a worker or dashboard service
2. paste the Discord bot token
3. set Claude or Codex auth values
4. choose the model family
5. optionally configure voice listen / speak settings
6. save the service

When you save from admin, HKClaw:

- writes `.env.primary` or `.env.agent.<service_id>`
- synchronizes the initial assignment if a team channel is provided
- reruns service discovery
- rewrites service-manager units
- starts or restarts the affected services

This is the important point:

- the admin UI is the recommended authoring surface
- env overlays are still the underlying source of truth for service identity and secrets
- the database is not the secret store

### 7. Assign Teams and Channels from the Admin Web

After services exist:

- use `Team Chart` to map Discord rooms to services
- use office teams for organization-level teams such as HR, management, or general affairs
- use Discord-linked teams for project rooms
- use `HKClaw Office` to verify placement and status visually

### 8. Optional: Replace Bootstrap Admin with a Real Dashboard Service

If you create a real service with `SERVICE_ROLE=dashboard`, that service becomes the long-term admin and dashboard owner.

At the next reconcile:

- the bootstrap `hkclaw-admin` service is no longer needed
- the real dashboard service takes over the admin web and status rendering

### 9. Useful Commands

Useful commands:

```bash
systemctl --user status hkclaw-admin
systemctl --user restart hkclaw-admin

systemctl --user status hkclaw hkclaw-codex hkclaw-dashboard
systemctl --user restart hkclaw hkclaw-codex hkclaw-dashboard

journalctl --user -u hkclaw-admin -f
journalctl --user -u hkclaw -f
journalctl --user -u hkclaw-codex -f
journalctl --user -u hkclaw-dashboard -f
```

### Is `.env` Required?

Short answer:

- `.env` is not required just to boot the admin web
- `.env.primary` and `.env.agent.*` are not required before first boot
- but HKClaw is not a DB-only configuration model

What lives where:

- env / process env:
  service identity
  bot tokens
  Claude / Codex auth
  provider keys
  voice and TTS settings
- SQLite database:
  chats
  messages
  team definitions
  channel assignments
  sessions
  scheduled tasks
  dashboard state

In other words:

- the database stores runtime and organizational state
- env overlays store secrets and process boot configuration
- the admin UI creates those env overlays for you

### Optional Manual Overlay Management

If you prefer to manage services by hand instead of using admin-first setup, HKClaw still supports manual overlay files.

Examples:

```bash
# .env.primary
ASSISTANT_NAME=claude
SERVICE_ID=claude
SERVICE_AGENT_TYPE=claude-code
SERVICE_ROLE=assistant
DISCORD_BOT_TOKEN=
CLAUDE_CODE_OAUTH_TOKEN=
CLAUDE_CODE_OAUTH_TOKENS=

# .env.agent.codex
ASSISTANT_NAME=codex
SERVICE_ID=codex
SERVICE_AGENT_TYPE=codex
SERVICE_ROLE=chat
DISCORD_BOT_TOKEN=
CODEX_AUTH_JSON_B64=
CODEX_MODEL=gpt-5.4
CODEX_EFFORT=high
OPENAI_API_KEY=
GROQ_API_KEY=
```

Env layering:

- `.env`: shared defaults
- `.env.primary`: primary service
- `.env.agent.<service_id>`: additional services
- `.env.codex`: legacy compatibility overlay

Role note:

- `dashboard` is the only special execution role
- admin labels such as `chat` and `assistant` currently normalize to the normal worker runtime

## Admin Web and "HR" Menus

The dashboard service exposes the local admin web. In practice, this is the operations and staffing console.

The main sections are:

- `Hiring Board`: create and update services
- `Team Chart`: map Discord channels to services
- `HKClaw Office`: visualize teams, staff placement, and status

### Hiring Board Categories

Think of the service form as an HR-plus-ops form. These settings belong to six logical buckets.

| Category | Main fields / env keys | Purpose |
| --- | --- | --- |
| Identity and topology | `ASSISTANT_NAME`, `SERVICE_ID`, `SERVICE_AGENT_TYPE`, `SERVICE_ROLE`, `STATUS_CHANNEL_ID`, `USAGE_DASHBOARD` | Defines what the service is and whether it behaves like a worker or dashboard |
| Discord identity | `DISCORD_BOT_TOKEN` | Chooses which Discord bot account the service uses |
| Listen / speech-to-text | `DISCORD_VOICE_CHANNEL_IDS`, `DISCORD_VOICE_TARGET_JID`, `DISCORD_VOICE_SESSION_JID`, `DISCORD_VOICE_ROUTE_MAP`, `DISCORD_VOICE_GROUP_FOLDER`, `DISCORD_VOICE_GROUP_NAME`, `DISCORD_VOICE_RECONNECT_DELAY_MS`, `DISCORD_LIVE_VOICE_SILENCE_MS`, `DISCORD_LIVE_VOICE_MIN_PCM_BYTES`, `DISCORD_GROQ_TRANSCRIPTION_MODEL`, `DISCORD_OPENAI_TRANSCRIPTION_MODEL`, `DISCORD_TRANSCRIPTION_LANGUAGE` | Controls voice room auto-join, live listening, transcript routing, and STT provider behavior |
| Speak / text-to-speech | `DISCORD_EDGE_TTS_RATE`, `DISCORD_EDGE_TTS_VOICE`, `DISCORD_EDGE_TTS_LANG`, `DISCORD_EDGE_TTS_OUTPUT_FORMAT`, `DISCORD_EDGE_TTS_TIMEOUT_MS`, `DISCORD_EDGE_TTS_MAX_CHARS`, `DISCORD_VOICE_OUTPUT_BITRATE` | Controls how the bot speaks back into voice rooms |
| LLM auth and provider | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKENS`, `CODEX_AUTH_JSON_B64`, `OPENAI_API_KEY`, `GROQ_API_KEY`, `CODEX_MODEL`, `CODEX_EFFORT` | Controls model login and provider-specific runtime behavior |
| Fallback and resilience | `FALLBACK_ENABLED`, `FALLBACK_PROVIDER_NAME`, `FALLBACK_BASE_URL`, `FALLBACK_AUTH_TOKEN`, `FALLBACK_MODEL`, `FALLBACK_SMALL_MODEL`, `FALLBACK_COOLDOWN_MS` | Lets Claude services fall through to another provider after rate limits or provider failures |

### Team Chart

`Team Chart` is the staffing matrix.

- Rows are Discord rooms.
- Columns are services.
- Assigning a cell creates or removes a `registered_group` for that service and room.
- Dashboard services do not take normal team assignments.
- Status-dashboard assignment is special and comes from `STATUS_CHANNEL_ID`.

This is where a project room becomes an actual working room for a bot.

### HKClaw Office

`HKClaw Office` is the visual floor map.

- services are rendered like workers
- mapped or active Discord rooms appear like teams or desks
- stopped services move to the offsite area
- idle services move to the lounge
- new service creation is represented as hiring

This view is operational, not merely decorative. It summarizes staffing and room activity from discovered services and assignments.

### Office Map Assets

The office map system stores assets in `admin-assets/`.

Relevant files:

- office map `.tmj`
- Tiled project file
- tileset image
- generated metadata in `admin-assets/hkclaw-office-map-meta.json`

This area is a good fit for a "General Affairs" or map-management team.

## Team Model

HKClaw supports two practical team concepts.

### 1. Base Teams

Base teams are manually defined office teams. They are organizational units first, Discord bindings second.

Typical examples:

- `management`: executive or leadership rooms
- `general-affairs`: office layout, map assets, naming, room presentation
- `hr`: hiring, retirement, staffing changes
- `devops`: CI, deployment, operations rooms
- `finance`, `legal`, `sales`, `support`: domain teams as needed

These names are operating conventions, not hardcoded system roles.

### 2. Project Teams

Project teams are Discord-linked working rooms.

In code terms, a project team is usually a team with a `linkedJid`, or an auto-derived channel-backed team inferred from active assignments.

Examples:

- a Discord text channel for a live product project
- an operations war room
- a voice room mirrored into a text room
- a client-specific working channel

### Recommended Organizational Pattern

One practical pattern is:

- `Management`: owns high-trust planning and decision channels
- `General Affairs`: owns office map, room naming, and dashboard presentation
- `HR`: owns service creation, bot retirement, and assignment changes
- `Project teams`: own the day-to-day Discord working rooms

Again, this is a recommended operating model. HKClaw does not force these names.

## How Team Creation Works

### Manual Team Creation

When you create a manual office team, HKClaw stores:

- `teamId`
- display name
- optional `linkedJid`
- optional group folder
- whether mention is required
- optional layout and color

Manual teams are the right model for base organizational teams such as management, general affairs, and HR.

### Discord-Linked Team Creation

When a team is linked to a Discord room:

- `linkedJid` becomes the channel binding
- the team folder can become the default runtime folder for assigned groups
- `requiresMention` can be pushed into all existing assignments on that room
- if the linked room changes, assignments can move with it

### Auto-Derived Channel Teams

If a Discord room has active assignments or active service presence but no explicit manual team, HKClaw can still surface it as a channel-backed team in admin state.

This is useful for project rooms created from actual work before formal org modeling is added.

## How Service Creation Works

When you create or update a bot from admin:

1. HKClaw validates the request.
2. It normalizes `SERVICE_ID`, `SERVICE_AGENT_TYPE`, and `SERVICE_ROLE`.
3. It writes `.env.primary` or `.env.agent.<service_id>`.
4. If an initial team channel is provided, it creates or syncs the service assignment.
5. It synchronizes the expected trigger, usually `@<assistantName>`.
6. It runs topology reconcile.
7. Topology reconcile calls `npm run setup -- --step service`.
8. Service discovery rescans `.env.primary`, `.env.agent.*`, and legacy `.env.codex`.
9. HKClaw rewrites service-manager units and starts or restarts the affected services.

Important service rules:

- dashboard services require `STATUS_CHANNEL_ID`
- dashboard services do not hold normal team assignments
- renaming an existing `SERVICE_ID` is not supported in place; create a new service instead

## Voice Model: Listen and Speak

HKClaw treats voice as an extension of the normal message pipeline.

### Listen

Voice listening is controlled by the `DISCORD_VOICE_*` and transcription settings.

Flow:

1. a configured voice room becomes active
2. the Discord client joins that room
3. voice packets are buffered
4. silence detection cuts a segment
5. STT runs through Groq or OpenAI
6. the transcript is turned into a synthetic text message
7. the normal worker pipeline continues

### Speak

Voice speaking is controlled by the `DISCORD_EDGE_TTS_*` settings.

Flow:

1. a worker finishes a response
2. HKClaw decides whether the room expects voice playback
3. Edge TTS synthesizes audio
4. ffmpeg converts it into Discord-friendly output
5. the service plays the spoken reply in the voice room

## Authentication and Provider Notes

### Claude

- per-service env: `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKENS`
- refresh source: the installing OS user's `~/.claude*` credentials
- auto-refresh writes refreshed access tokens back into that service overlay

### Codex

- per-service env: `CODEX_AUTH_JSON_B64`
- if not set, HKClaw inherits the installing OS user's active Codex auth
- host `~/.codex/config.toml` and `config.json` are copied into session-local `.codex/`

### Transcription Providers

- primary STT can come from `GROQ_API_KEY`
- fallback STT can come from `OPENAI_API_KEY`
- language can be pinned with `DISCORD_TRANSCRIPTION_LANGUAGE`

### Provider Fallback

Claude-oriented services can fail over to another Anthropic-compatible endpoint with `FALLBACK_*` values.

## Development

```bash
npm run build
npm run build:runners
npm run dev
npm test
```

## License

MIT
