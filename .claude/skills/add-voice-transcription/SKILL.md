---
name: add-voice-transcription
description: Enable Discord voice transcription using Groq Whisper with OpenAI fallback.
---

# Add Voice Transcription

디스코드 음성 첨부 전사는 이미 코드에 들어 있습니다. 현재 구현은 `src/channels/discord.ts`에 있고, 별도 브랜치 머지나 채널 추가 작업은 필요 없습니다.

우선순위는 `Groq Whisper -> OpenAI Whisper fallback` 입니다.

## 1. 환경 변수 설정

`.env`에 아래 중 하나 이상을 넣습니다.

```bash
GROQ_API_KEY=gsk_...          # 권장. 빠르고 무료 티어가 있음
OPENAI_API_KEY=sk-...         # fallback
```

Groq를 쓰면 `whisper-large-v3-turbo`, OpenAI를 쓰면 `whisper-1` 경로를 탑니다.

## 2. 재시작

```bash
npm run build
npm run setup -- --step service
```

이미 서비스가 떠 있다면 플랫폼에 맞게 재시작만 해도 됩니다.

## 3. 검증

등록된 디스코드 채널에 음성 메시지나 오디오 첨부를 보냅니다. 정상이라면 에이전트 입력에 전사 텍스트가 포함됩니다.

```bash
tail -f logs/hkclaw.log | grep -iE 'transcri|audio'
```

성공 신호:

- `Audio transcribed + cached`
- `provider: "groq"` 또는 `provider: "openai"`
- 동일 첨부 재처리 시 cache hit

## Troubleshooting

**전사가 전혀 안 됨**

- `.env`에 `GROQ_API_KEY`나 `OPENAI_API_KEY`가 없는 경우가 대부분입니다.
- 서비스 재시작 전에는 새 키가 반영되지 않습니다.

**너무 느림**

- 로그에 `provider: "groq"`가 안 보이면 Groq 키가 빠졌거나 잘못된 상태입니다.

**채널에서는 보이는데 에이전트가 못 읽음**

- 채널 등록과 서비스 상태를 먼저 확인합니다.
- `npm run setup -- --step verify` 결과에서 `REGISTERED_GROUPS`와 `SERVICE`를 같이 봅니다.
