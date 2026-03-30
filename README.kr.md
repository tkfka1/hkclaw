# HKClaw

![Claude Agent SDK](https://img.shields.io/badge/Claude_Agent_SDK-0.2.81-blueviolet)
![Codex SDK](https://img.shields.io/badge/Codex_SDK-0.115.0-green)
![Node](https://img.shields.io/badge/Node-20+-339933?logo=nodedotjs&logoColor=white)
![Discord](https://img.shields.io/badge/Discord-Bot-5865F2?logo=discord&logoColor=white)

HKClaw는 Discord 위에서 여러 Claude Code / Codex 봇을 "직원"처럼 운영하는 듀얼 에이전트 플랫폼이다. 하나의 저장소, 하나의 호스트, 하나의 SQLite를 기반으로 여러 봇 서비스를 띄우고, admin 웹에서 채용, 배치, 채널 연결, 서비스 운영을 관리한다.

영문 문서: [README.md](README.md)

[qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw)에서 출발했고, 프롬프트 구조는 [Q00/ouroboros](https://github.com/Q00/ouroboros)의 영향을 받았다.

## HKClaw를 어떻게 봐야 하나

HKClaw는 봇 하나를 "직원 한 명"처럼 다룬다.

- 실행 중인 봇 1개 = 서비스 프로세스 1개
- 각 서비스는 고유한 `SERVICE_ID`를 가진다
- 각 서비스는 `SERVICE_AGENT_TYPE`으로 모델 계열을 고른다
- 각 서비스는 `SERVICE_ROLE`로 운영 역할을 정한다
- 모든 서비스는 같은 코드베이스를 쓰지만, 실제 런타임 상태는 `SERVICE_ID` 기준으로 분리된다

예를 들면 이런 식이다.

- `hkclaw`: 메인 비서
- `hkclaw-codex`: 별도 Codex 작업자
- `hkclaw-dashboard`: 대시보드 전용 운영 서비스
- `hkclaw-ops`, `hkclaw-finance`, `hkclaw-map`, `hkclaw-dev`: 역할별 추가 봇

더 낮은 수준의 서비스 개념은 [docs/service-concepts.md](docs/service-concepts.md)를 보면 된다.

## 핵심 런타임 모델

HKClaw는 세 축으로 돌아간다.

- `SERVICE_ID`: 실제 런타임 정체성, 상태 분리 키, 서비스 이름 suffix
- `SERVICE_AGENT_TYPE`: 모델 계열, 현재 `claude-code` 또는 `codex`
- `SERVICE_ROLE`: 운영 역할. 현재 하드하게 나뉘는 것은 `dashboard` 대 일반 작업자뿐이다

실무적으로 중요한 점:

- Claude 기반 봇을 여러 개 띄워도 세션이 섞이지 않는다
- dashboard 서비스는 일반 작업자와 다르게 동작한다
- admin에서 보이는 `chat`, `assistant` 같은 값은 입력 별칭이고, 현재 런타임에서는 일반 작업자 role로 정규화된다
- 음성은 별도 role이 아니다. `DISCORD_VOICE_*`를 켜면 음성 기능이 붙는다
- 모든 서비스는 `.env` + 오버레이 파일 조합으로 만들어진다

## 설치 계정과 운영 계정

### 어떤 호스트에서 돌려야 하나

HKClaw는 다음 환경을 기준으로 설계되어 있다.

- Linux
- Windows라면 WSL Ubuntu
- macOS

Windows 네이티브 서비스 운영은 1급 경로가 아니다. Windows 사용자라면 WSL Ubuntu 안에서 돌리는 것이 맞다.

### 어떤 OS 계정에서 설치해야 하나

가능하면 HKClaw 전용 운영 계정에서 설치하고 실행하는 것이 좋다.

예시:

- 개인 장비: 본인 일반 계정
- 공용 장비: `hkclaw`, `ops-bot` 같은 전용 계정
- Windows 호스트: 전용 WSL 사용자

중요한 점은 "봇이 설치한 계정과 분리되어 있다"라고 생각하면 안 된다는 것이다. 실제로는 그렇지 않다.

### 보안 경계 1: 호스트 OS 계정

생성되는 서비스는 모두 설치한 OS 계정으로 돌아간다.

- Linux: `systemctl --user`
- macOS: 사용자 `LaunchAgents`
- systemd 없는 Linux: 저장소 내부 `nohup` wrapper

즉, 모든 HKClaw 봇은 그 계정이 가진 머신 권한을 그대로 공유한다.

- 그 계정이 읽을 수 있는 파일
- 그 계정의 SSH 키와 Git 자격 증명
- `~/.claude` 와 `~/.claude-accounts/*`
- `~/.codex` 와 `.codex-accounts/*`
- 그 계정이 접근 가능한 네트워크
- 그 계정 권한으로 실행 가능한 shell 명령

따라서 강한 권한을 가진 개인 계정으로 설치하면, 봇들도 사실상 그 계정의 머신 권한 전체를 가진다.

권장 원칙:

- HKClaw 전용 저권한 계정을 써라
- 특별한 이유가 없으면 `root`로 설치하지 마라
- 민감한 파일은 HKClaw 계정이 못 읽게 분리해라

### 보안 경계 2: Discord 봇 권한

Discord 권한은 호스트 권한과 별개다.

- 호스트 권한: HKClaw를 실행하는 OS 계정이 결정
- Discord 권한: 각 서비스가 사용하는 `DISCORD_BOT_TOKEN`이 결정

중요한 점:

- 두 서비스가 같은 `DISCORD_BOT_TOKEN`을 쓰면 Discord 상으로는 같은 봇이다
- Discord 권한을 서비스별로 분리하고 싶으면 Discord 애플리케이션과 봇 토큰을 서비스마다 따로 만들어야 한다
- 어떤 서비스든, 그 봇 토큰이 초대되고 권한을 받은 서버/채널에서만 동작한다

## 설치 방법

### 사전 준비

- Node.js 20+ 지원
- 현재 `.nvmrc`는 `22`
- 네이티브 모듈 빌드 도구
  - Linux: `gcc`, `make`
  - macOS: Xcode Command Line Tools
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- [Codex CLI](https://github.com/openai/codex)
- 브라우저 관련 워크플로우용 Bun 1.0+

### 권장 시작 방식: Admin-First

권장 온보딩 흐름은 이렇다.

1. 저장소를 clone 하고 빌드한다
2. bootstrap admin 웹만 먼저 띄운다
3. admin 웹에 접속한다
4. 내부 웹에서 실제 Discord 봇 서비스를 만든다
5. HKClaw가 `.env.primary` / `.env.agent.*`를 대신 생성하고 서비스 reconcile을 돌린다

즉, 첫 부팅 전에 `.env.primary`나 `.env.agent.*`를 손으로 만들 필요는 없다.

### 1. 저장소 클론과 빌드

```bash
git clone https://gitlab.com/el-psy/hkclaw.git
cd hkclaw
npm ci
npm run build:runners
npm run build
```

### 2. admin bind용 최소 `.env`는 선택

admin-first 부팅에서는 `.env`가 필수는 아니다.

다만 host/port를 명시하고 싶으면 최소한 이렇게 둘 수 있다.

```bash
HKCLAW_ADMIN_HOST=0.0.0.0
HKCLAW_ADMIN_PORT=4621
```

이 파일이 없어도 HKClaw는 기본값으로 admin을 띄울 수 있다.

### 3. bootstrap admin 서비스 시작

```bash
npm run setup -- --step service
```

아직 dashboard 서비스가 하나도 없으면 HKClaw가 자동으로 `hkclaw-admin` bootstrap admin 서비스를 만든다.

이 bootstrap service가 하는 일:

- 로컬 admin 웹 제공
- 내부 UI에서 첫 실제 서비스를 만들 수 있게 해줌
- 나중에 진짜 `dashboard` 서비스가 생기면 역할을 넘겨줌

생성 위치:

- Linux user mode: `~/.config/systemd/user/hkclaw-admin.service`
- macOS user mode: `~/Library/LaunchAgents/com.hkclaw-admin.plist`
- systemd 없는 Linux: `start-hkclaw-admin.sh`

### 4. admin 웹 접속

기본 주소:

- `http://localhost:4621/`

이제부터 초기 설정은 파일을 직접 쓰는 대신 내부 웹에서 진행하는 것이 기본 경로다.

### 5. 같은 OS 계정에서 인증과 봇 계정 준비

실제 worker 서비스를 admin에서 만들기 전에, 그 서비스들이 사용할 인증을 먼저 준비해야 한다.

Discord 쪽:

- 서비스마다 Discord 애플리케이션을 따로 만들면 권한 분리가 깔끔하다
- 각 애플리케이션에서 bot token을 발급한다
- 필요한 서버에만 초대한다

Claude 쪽:

Claude 서비스는 설치한 계정의 credential 파일을 읽어서 토큰을 갱신한다.

- `~/.claude/.credentials.json`
- `~/.claude-accounts/{index}/.credentials.json`

기본 계정 준비:

```bash
claude setup-token
```

추가 계정 준비:

```bash
CLAUDE_CONFIG_DIR=~/.claude-accounts/1 claude setup-token
CLAUDE_CONFIG_DIR=~/.claude-accounts/2 claude setup-token
```

서비스 오버레이에는 보통 아래 값이 들어간다.

- `CLAUDE_CODE_OAUTH_TOKEN`
- `CLAUDE_CODE_OAUTH_TOKENS`

Codex 쪽:

Codex는 세션별 `.codex/auth.json`으로 인증을 물질화한다.

서비스별 우선순위는 다음과 같다.

1. 오버레이의 `CODEX_AUTH_JSON_B64`
2. 현재 활성화된 회전용 Codex 계정 파일
3. 설치 계정의 `~/.codex/auth.json`

서비스를 강하게 분리하고 싶으면 `CODEX_AUTH_JSON_B64`를 서비스별로 따로 넣어라. 그렇지 않으면 설치 계정의 Codex 로그인 컨텍스트를 상속한다.

권장 Discord 권한:

- 텍스트 채널: `View Channel`, `Send Messages`, `Read Message History`, `Attach Files`
- 음성 채널: `View Channel`, `Connect`, `Speak`
- 게이트웨이 인텐트: `Guilds`, `GuildMessages`, `GuildVoiceStates`, `DirectMessages`
- `Message Content` intent는 켜는 쪽이 맞다

HKClaw는 `Message Content` intent가 막히면 그 인텐트 없이 재접속을 시도하지만, 정상 운영 기준은 켜진 상태다.

### 6. 내부 admin 웹에서 실제 서비스 생성

admin 페이지에서:

1. worker 또는 dashboard 서비스를 만든다
2. Discord bot token을 넣는다
3. Claude 또는 Codex 인증값을 넣는다
4. 모델 계열을 고른다
5. 필요하면 voice listen / speak 설정도 넣는다
6. 저장한다

admin에서 저장하면 HKClaw는:

- `.env.primary` 또는 `.env.agent.<service_id>`를 쓴다
- 초기 팀 채널이 있으면 assignment를 동기화한다
- service discovery를 다시 돌린다
- service-manager unit을 다시 쓴다
- 영향을 받은 서비스를 시작하거나 재시작한다

여기서 핵심은:

- admin UI가 권장 입력 면이다
- 하지만 실제 하부 저장소는 여전히 env overlay다
- DB가 secret store를 대체하는 구조는 아니다

### 7. 내부 admin 웹에서 팀과 채널 배치

서비스가 만들어진 뒤에는:

- `Team Chart`에서 Discord 방과 서비스를 연결한다
- 경영, 총무, 인사 같은 조직 팀은 office team으로 잡는다
- 프로젝트 방은 Discord-linked team으로 잡는다
- `HKClaw Office`에서 배치와 상태를 시각적으로 확인한다

### 8. 선택: bootstrap admin 대신 진짜 dashboard 서비스로 전환

`SERVICE_ROLE=dashboard`인 진짜 서비스를 하나 만들면, 그 서비스가 장기적인 admin / dashboard 소유자가 된다.

다음 reconcile 시점에:

- bootstrap `hkclaw-admin`은 더 이상 필요하지 않다
- 실제 dashboard 서비스가 admin 웹과 status rendering을 넘겨받는다

### 9. 자주 쓰는 명령

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

### `.env`가 꼭 필요한가

짧게 말하면:

- admin 웹만 띄우는 데 `.env`는 필수가 아니다
- 첫 부팅 전에 `.env.primary`, `.env.agent.*`를 만들 필요도 없다
- 하지만 HKClaw는 DB-only 설정 구조는 아니다

무엇이 어디에 사는가:

- env / process env:
  서비스 정체성
  bot token
  Claude / Codex 인증
  provider key
  voice / TTS 설정
- SQLite DB:
  chats
  messages
  team 정의
  channel assignment
  sessions
  scheduled task
  dashboard 상태

즉:

- DB는 운영 상태와 조직 상태를 저장한다
- env overlay는 비밀값과 프로세스 부팅 설정을 저장한다
- admin UI가 그 env overlay를 대신 만들어주는 구조다

### 선택: 수동으로 overlay 파일 관리

admin-first가 아니라 수동 파일 관리도 여전히 가능하다.

예시:

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

환경 계층은 이렇게 본다.

- `.env`: 공통 기본값
- `.env.primary`: 메인 서비스
- `.env.agent.<service_id>`: 추가 서비스
- `.env.codex`: 레거시 호환 오버레이

role 메모:

- 특수 실행 role은 `dashboard` 하나다
- admin에서 쓰는 `chat`, `assistant` 값은 현재 런타임에서 일반 작업자 role로 정규화된다

## Admin 웹과 "인사팀 메뉴"

dashboard 서비스는 로컬 admin 웹을 연다. 실무적으로는 이것이 인사/운영 콘솔이다.

주요 섹션:

- `Hiring Board`: 서비스 생성과 수정
- `Team Chart`: Discord 채널과 서비스 연결
- `HKClaw Office`: 팀, 직원, 상태를 오피스처럼 시각화

### Hiring Board를 어떻게 읽어야 하나

서비스 폼은 "인사 + 운영" 폼이다. 필드는 아래 여섯 묶음으로 보는 게 맞다.

| 분류 | 주요 필드 / env 키 | 의미 |
| --- | --- | --- |
| 정체성과 토폴로지 | `ASSISTANT_NAME`, `SERVICE_ID`, `SERVICE_AGENT_TYPE`, `SERVICE_ROLE`, `STATUS_CHANNEL_ID`, `USAGE_DASHBOARD` | 이 서비스가 누구인지, 작업자인지 dashboard인지 정의 |
| Discord 정체성 | `DISCORD_BOT_TOKEN` | 어떤 Discord 봇 계정을 쓰는지 결정 |
| Listen / STT | `DISCORD_VOICE_CHANNEL_IDS`, `DISCORD_VOICE_TARGET_JID`, `DISCORD_VOICE_SESSION_JID`, `DISCORD_VOICE_ROUTE_MAP`, `DISCORD_VOICE_GROUP_FOLDER`, `DISCORD_VOICE_GROUP_NAME`, `DISCORD_VOICE_RECONNECT_DELAY_MS`, `DISCORD_LIVE_VOICE_SILENCE_MS`, `DISCORD_LIVE_VOICE_MIN_PCM_BYTES`, `DISCORD_GROQ_TRANSCRIPTION_MODEL`, `DISCORD_OPENAI_TRANSCRIPTION_MODEL`, `DISCORD_TRANSCRIPTION_LANGUAGE` | 음성 채널 자동 접속, 듣기, 전사, 텍스트 미러링, 세션 폴더 동작 |
| Speak / TTS | `DISCORD_EDGE_TTS_RATE`, `DISCORD_EDGE_TTS_VOICE`, `DISCORD_EDGE_TTS_LANG`, `DISCORD_EDGE_TTS_OUTPUT_FORMAT`, `DISCORD_EDGE_TTS_TIMEOUT_MS`, `DISCORD_EDGE_TTS_MAX_CHARS`, `DISCORD_VOICE_OUTPUT_BITRATE` | 음성 채널에서 어떻게 말할지 결정 |
| LLM 인증과 제공자 | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKENS`, `CODEX_AUTH_JSON_B64`, `OPENAI_API_KEY`, `GROQ_API_KEY`, `CODEX_MODEL`, `CODEX_EFFORT` | 모델 인증과 제공자별 실행 방식 결정 |
| fallback / 복원력 | `FALLBACK_ENABLED`, `FALLBACK_PROVIDER_NAME`, `FALLBACK_BASE_URL`, `FALLBACK_AUTH_TOKEN`, `FALLBACK_MODEL`, `FALLBACK_SMALL_MODEL`, `FALLBACK_COOLDOWN_MS` | Claude 레이트리밋이나 장애 때 대체 제공자로 넘길지 결정 |

### Team Chart

`Team Chart`는 배치표다.

- 행: Discord 방
- 열: 서비스
- 셀을 할당하면 그 서비스와 방 사이에 `registered_group`이 생긴다
- dashboard 서비스는 일반 팀 배치를 받지 않는다
- status dashboard 연결은 `STATUS_CHANNEL_ID` 기반의 특수 연결이다

즉, 프로젝트 방을 실제 봇 작업방으로 만드는 메뉴가 여기다.

### HKClaw Office

`HKClaw Office`는 오피스 바닥맵 시각화다.

- 서비스는 직원처럼 그려진다
- 매핑된 채널이나 활성 채널은 팀 구역처럼 보인다
- 멈춘 서비스는 offsite로 간다
- 쉬는 서비스는 lounge로 간다
- 새 서비스 생성은 hiring으로 표현된다

이 화면은 단순 장식이 아니라 현재 배치와 방 활동을 요약하는 운영 뷰다.

### 오피스 맵 자산

오피스 맵 자산은 `admin-assets/` 아래에 저장된다.

관련 파일:

- 오피스 맵 `.tmj`
- Tiled project 파일
- tileset 이미지
- `admin-assets/hkclaw-office-map-meta.json`

이 영역은 "총무팀" 또는 맵 관리 담당 팀의 책임으로 두는 패턴이 잘 맞는다.

## 팀 모델

HKClaw에서는 팀을 실무적으로 두 가지로 보면 된다.

### 1. 기본 팀

기본 팀은 수동으로 정의하는 오피스 팀이다. Discord 연결보다 조직 단위가 먼저다.

예시:

- `management`: 경영진 / 의사결정
- `general-affairs`: 총무 / 오피스 레이아웃 / 맵 자산 / 명칭 관리
- `hr`: 인사 / 채용 / 퇴사 / 배치 변경
- `devops`: CI / 배포 / 운영 방
- `finance`, `legal`, `sales`, `support`: 필요에 따라 추가

이 이름들은 운영 규칙이지, 코드에 박힌 강제 role은 아니다.

### 2. 프로젝트 팀

프로젝트 팀은 Discord 채널에 연결된 작업 팀이다.

코드 관점에서는 보통 `linkedJid`가 있는 팀, 또는 실제 배치/활동에서 자동 추론된 채널 팀을 뜻한다.

예시:

- 제품 프로젝트 전용 Discord 텍스트 채널
- 운영 워룸
- 음성방과 텍스트방이 연결된 콜룸
- 고객별 작업 채널

### 추천 운영 구조

실제로는 이런 패턴이 깔끔하다.

- `경영`: 높은 신뢰가 필요한 판단 채널 담당
- `총무`: 오피스 맵, 방 이름, 대시보드 표현 담당
- `인사`: 서비스 생성, 서비스 정리, 배치 변경 담당
- `프로젝트 팀`: Discord 실작업 채널 담당

다시 말하지만, 이건 권장 운영 모델이고 HKClaw가 이름을 강제하는 것은 아니다.

## 팀 생성 로직

### 수동 팀 생성

수동 오피스 팀을 만들면 HKClaw는 아래 값을 저장한다.

- `teamId`
- 표시 이름
- 선택적 `linkedJid`
- 선택적 group folder
- mention 필요 여부
- 선택적 레이아웃과 색상

경영, 총무, 인사 같은 기본 팀은 이 방식으로 만드는 게 맞다.

### Discord 연결 팀 생성

팀이 Discord 방에 연결되면:

- `linkedJid`가 채널 바인딩이 된다
- 팀 folder를 그 방의 기본 런타임 folder처럼 쓸 수 있다
- `requiresMention` 값을 기존 배치들에 밀어 넣을 수 있다
- 연결 채널이 바뀌면 기존 배치도 같이 옮길 수 있다

### 자동 추론 채널 팀

Discord 방에 실제 배치나 활성 서비스가 있는데 수동 팀이 아직 없으면, HKClaw는 admin 상태에서 그 방을 채널 기반 팀으로 보여줄 수 있다.

즉, 프로젝트가 먼저 생기고 조직 모델링은 나중에 얹어도 된다.

## 서비스 생성 로직

admin에서 봇을 만들거나 수정하면 흐름은 이렇게 간다.

1. 입력값을 검증한다
2. `SERVICE_ID`, `SERVICE_AGENT_TYPE`, `SERVICE_ROLE`을 정규화한다
3. `.env.primary` 또는 `.env.agent.<service_id>`를 쓴다
4. 초기 팀 채널이 들어오면 해당 서비스의 배치를 만든다
5. 트리거를 보통 `@<assistantName>`로 맞춘다
6. topology reconcile을 실행한다
7. 내부적으로 `npm run setup -- --step service`가 돈다
8. service discovery가 `.env.primary`, `.env.agent.*`, `.env.codex`를 다시 스캔한다
9. service manager unit을 다시 쓰고 해당 서비스를 시작 또는 재시작한다

중요한 규칙:

- dashboard 서비스는 `STATUS_CHANNEL_ID`가 필수다
- dashboard 서비스는 일반 팀 배치를 갖지 않는다
- 기존 `SERVICE_ID`를 제자리 rename하는 것은 지원하지 않는다. 새 서비스를 만들어야 한다

## 음성 모델: Listen 과 Speak

HKClaw는 음성을 별도 엔진이 아니라 일반 메시지 파이프라인의 확장으로 본다.

### Listen

듣기 쪽은 `DISCORD_VOICE_*`와 전사 관련 설정이 제어한다.

흐름:

1. 설정된 음성방이 활성화된다
2. Discord 클라이언트가 그 방에 붙는다
3. 음성 패킷을 버퍼링한다
4. 무음 기준으로 한 덩어리를 자른다
5. Groq 또는 OpenAI로 STT를 돌린다
6. 결과를 synthetic text message로 만든다
7. 이후는 일반 텍스트 파이프라인으로 계속 간다

### Speak

말하기 쪽은 `DISCORD_EDGE_TTS_*`가 제어한다.

흐름:

1. 작업자가 답변을 끝낸다
2. 그 방이 음성 재생 대상인지 판단한다
3. Edge TTS로 음성을 만든다
4. ffmpeg로 Discord 재생 형식으로 변환한다
5. 음성방에 재생한다

## 인증과 제공자 메모

### Claude

- 서비스별 env: `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKENS`
- refresh source: 설치 계정의 `~/.claude*`
- 토큰 자동 갱신 후에는 그 서비스 오버레이에 새 access token을 다시 쓴다

### Codex

- 서비스별 env: `CODEX_AUTH_JSON_B64`
- 없으면 설치 계정의 활성 Codex 인증을 상속한다
- 호스트의 `~/.codex/config.toml`, `config.json`도 세션 로컬 `.codex/`로 복사된다

### 전사 제공자

- 1차 STT: `GROQ_API_KEY`
- 대체 STT: `OPENAI_API_KEY`
- 언어 고정: `DISCORD_TRANSCRIPTION_LANGUAGE`

### Provider fallback

Claude 계열 서비스는 `FALLBACK_*` 값으로 다른 Anthropic 호환 endpoint로 넘길 수 있다.

## 개발

```bash
npm run build
npm run build:runners
npm run dev
npm test
```

## 라이선스

MIT
