# Multi-Architecture Support

This document makes the HKClaw architecture contract explicit for [HK-17](/HK/issues/HK-17).

## Support Statement

HKClaw targets 64-bit hosts only.

### Source Install Targets

| Host OS | CPU | Support level | Notes |
| --- | --- | --- | --- |
| Linux | `x64` | Supported | Primary server target. |
| Linux | `arm64` | Supported | Intended for ARM servers and Apple Silicon Linux VMs. |
| macOS | `x64` | Supported | Supported for local/dev installs. |
| macOS | `arm64` | Supported | Supported for local/dev installs. |
| Windows via WSL Ubuntu | `x64` / `arm64` | Supported | Follows the Linux support path inside WSL. |
| Windows native | any | Unsupported | HKClaw itself is not a supported native Windows install target. |
| Any OS | `arm`, `ia32`, other 32-bit CPUs | Unsupported | Do not publish or claim support. |

### Container Image Targets

Official container images should be published for:

- `linux/amd64`
- `linux/arm64`

No other image architectures should be advertised unless they are explicitly tested and added to the release flow.

## Native and Runtime Dependency Audit

| Dependency | Where used | Architecture impact | HKClaw handling |
| --- | --- | --- | --- |
| `better-sqlite3` | main app and setup commands | Native Node addon. Install uses prebuilds when available and falls back to `node-gyp rebuild --release`. | Build hosts and container build stages need a compiler toolchain. Keep Node and libc consistent per target architecture. |
| `ffmpeg-static` | Discord voice/TTS pipeline | Downloads an architecture-specific `ffmpeg` binary at install time. Supports Linux `x64`/`arm64`, macOS `x64`/`arm64`, plus some extra platforms upstream. HKClaw throws if no binary is present. | Treat `linux/amd64` and `linux/arm64` as the only release-image targets. Keep `FFMPEG_BIN` override available for custom operators. |
| `node-edge-tts` | Discord TTS generation | Pure JS/network client. No architecture-specific binary in this package. | No special handling beyond Node support. |
| `opusscript` | Discord voice codec fallback | JS/WASM package, not host-native. | No extra architecture work needed. |
| `@openai/codex` | Codex runner | Ships optional platform packages for Linux/macOS/Windows on `x64` and `arm64`. | The runner already aligns with the 64-bit support policy. |
| `@anthropic-ai/claude-agent-sdk` | agent runner | Pulls `sharp` optional packages for `x64`/`arm64`, including Linux musl variants. | No HKClaw-specific arch patching required, but keep runner installs architecture-native. |

## Host and Container Combinations

| Operator shape | Support level | Notes |
| --- | --- | --- |
| Linux host + source install on `x64` | Supported | Primary path. |
| Linux host + source install on `arm64` | Supported | Expected for ARM servers such as Graviton-class hosts. |
| macOS host + source install on `x64` or `arm64` | Supported | Local/dev path, not the primary production target. |
| `linux/amd64` container on an `amd64` host | Supported | Normal container deployment path. |
| `linux/arm64` container on an `arm64` host | Supported | Normal ARM container deployment path. |
| Cross-running an `amd64` image on an `arm64` host via emulation | Limited | Useful for debugging, but not a release target because native install and runtime behavior can diverge. |
| Cross-running an `arm64` image on an `amd64` host via emulation | Limited | Same restriction as above. |

## Packaging and Release Strategy

Use one source tree and one Dockerfile, but publish separate architecture artifacts:

1. npm package: publish once from source because consumers install dependencies on their own target architecture.
2. Container image: publish a multi-platform manifest that includes `linux/amd64` and `linux/arm64`.
3. Helm chart: keep a single chart; operators select the image tag and, when needed, constrain scheduling with `nodeSelector`.

Recommended container release command:

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/<owner>/hkclaw:<tag> \
  -t ghcr.io/<owner>/hkclaw:latest \
  --push .
```

## CI Expectations

PR validation can remain architecture-light for fast feedback, but release validation should be architecture-explicit:

- run unit/typecheck/test on the normal CI runner
- build the container image for both `linux/amd64` and `linux/arm64` before publishing
- smoke-test `npm run build` plus `npm run build:runners` on both target architectures before claiming release support

If a future CI workflow cannot run native `arm64` jobs directly, use buildx for image validation and keep the support statement limited to the targets that were actually exercised.

## Operator Guidance

- Prefer Debian/Ubuntu-style glibc environments for official docs and images, matching the current `node:22-bookworm-slim` base image.
- Keep build tools available anywhere `npm ci` may need to compile `better-sqlite3`.
- Do not claim support for `armv7`, `ia32`, or native Windows packaging.
