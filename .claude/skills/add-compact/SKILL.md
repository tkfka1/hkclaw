---
name: add-compact
description: Verify or port the existing /compact session command in current HKClaw.
---

# Add /compact Command

현재 HKClaw에는 `/compact`가 이미 들어 있습니다. 이 스킬은 새로 브랜치를 머지하는 용도보다, 오래된 포크에 같은 기능을 옮기거나 리팩터링 뒤 동작을 검증하는 체크리스트로 씁니다.

## 관련 파일

- `src/session-commands.ts` - 명령 파싱, 권한 검사, pre-compact 처리
- `src/index.ts` - 메시지 루프에서 세션 명령을 가로채는 호출부
- `runners/agent-runner/src/index.ts` - Claude Code 쪽 compaction 처리
- `runners/codex-runner/src/index.ts` - Codex 쪽 compaction 처리

## 확인할 동작

1. `/compact`가 정확히 명령으로 인식되는지
2. 메인 그룹 또는 admin/trusted sender만 허용되는지
3. `/compact` 전에 들어온 메시지를 먼저 세션에 반영하는지
4. compaction 후 세션이 이어지고 `newSessionId`가 갱신되는지
5. 대화 아카이브가 `groups/<folder>/conversations/`에 남는지

## 포팅할 때 원칙

- 예전 skill branch를 다시 머지하지 말고 현재 트리의 관련 파일을 기준으로 옮깁니다
- Claude 러너와 Codex 러너 양쪽을 같이 봅니다
- `/clear`와 `/compact`의 의미를 섞지 않습니다

## 검증

```bash
npm run typecheck
npm test
npm run build:runners
npm run build
```

그 다음 디스코드에서 확인합니다.

- 메인 채널에서 `/compact`
- 비메인 채널에서 일반 사용자 `/compact` 또는 멘션 포함 `/compact`
- 비메인 채널에서 admin/trusted sender의 `/compact`

정상이라면 비권한 사용자는 거부되고, 권한 있는 쪽은 세션이 압축된 뒤 계속 이어집니다.
