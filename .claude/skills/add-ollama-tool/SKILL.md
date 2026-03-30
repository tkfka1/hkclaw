---
name: add-ollama-tool
description: Add an Ollama MCP tool to the current host-process Claude runner.
---

# Add Ollama Tool

현재 구조에서는 컨테이너를 건드리지 않습니다. Ollama 연동은 호스트에서 실행되는 Claude 러너에 MCP를 추가하는 방식으로 넣습니다.

## 전제 조건

```bash
ollama list
```

- Ollama가 설치되어 있어야 합니다.
- 최소 한 개 이상의 모델이 있어야 합니다.

권장 예시:

```bash
ollama pull gemma3:1b
ollama pull llama3.2
```

## 수정 지점

### 1. 환경 변수 전달

`src/agent-runner.ts`

- `.env`에서 `OLLAMA_HOST`를 읽도록 `readEnvFile([...])` 목록에 추가합니다.
- Claude 러너 child env에 `OLLAMA_HOST`를 명시적으로 넣습니다.

기본값을 쓰면 생략 가능하지만, 원격 Ollama나 다른 포트를 쓸 때는 필요합니다.

## 2. MCP 서버 추가

`runners/agent-runner/src/index.ts`

- 호스트에서 동작하는 stdio MCP 서버 파일을 추가합니다.
  - 예: `runners/agent-runner/src/ollama-mcp-stdio.ts`
- `query({ options: { mcpServers, allowedTools } })` 쪽에 Ollama 서버를 등록합니다.
- `allowedTools`에 `mcp__ollama__*` 또는 실제 툴 prefix를 추가합니다.

핵심은 두 가지입니다.

- Claude가 Ollama를 CLI가 아니라 MCP 도구로 보게 만들 것
- 툴 이름이 `allowedTools`에 포함될 것

## 3. 프롬프트 문서화

`groups/global/CLAUDE.md` 또는 대상 그룹의 `CLAUDE.md`

- 언제 Ollama를 쓰는지
- 어떤 모델을 우선 쓰는지
- 빠른 요약/분류/초안 작업에 먼저 쓰도록 할지

이 부분을 적어두지 않으면 에이전트가 도구를 잘 안 고릅니다.

## 4. 빌드와 검증

```bash
npm run build:runners
npm run build
npm run setup -- --step service
```

디스코드에서 테스트:

> `ollama 도구를 써서 이 문단을 3줄로 요약해줘`

## 문제 확인

### 에이전트가 `ollama` CLI를 직접 치려고 함

- MCP 서버 등록이 빠졌거나
- `allowedTools`에 툴 prefix가 없거나
- 프롬프트 문서에 사용 규칙이 없습니다

### 연결 실패

- `ollama list`가 호스트에서 되는지 먼저 확인합니다
- 원격 호스트면 `.env`의 `OLLAMA_HOST`를 확인합니다
