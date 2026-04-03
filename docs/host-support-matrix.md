# Host Support Matrix

This document makes the HKClaw host contract explicit for [HK-13](/HK/issues/HK-13).

Architecture-specific support and release guidance live in [multi-architecture-support.md](multi-architecture-support.md).

## Summary

HKClaw is intended to run on Unix-like hosts. Ubuntu/Linux with systemd is the primary path, macOS is supported through `launchd`, and Windows users should run the repo inside WSL Ubuntu rather than on native Windows.

## Matrix

| Host environment | Support level | Service manager path | Setup flow | Notes |
| --- | --- | --- | --- | --- |
| Ubuntu Linux | First-class | `systemd --user` | Normal install and `npm run setup -- --step service` | Primary tested Linux target. |
| Other Linux with systemd | Supported | `systemd --user` | Same as Ubuntu | Expected to work when Node/native-module prerequisites match Ubuntu. |
| Linux without systemd | Limited | Repo-local `start-*.sh` wrappers | Normal install, then `service` step writes wrapper scripts instead of units | Good for constrained hosts and some containers, but not the preferred long-running service path. |
| Windows via WSL Ubuntu | Supported | `systemd --user` when available, otherwise repo-local `start-*.sh` wrappers | Run the Linux setup path inside WSL | This is the supported Windows-host route. |
| macOS | Supported | User `LaunchAgents` | Normal install and `service` step | Requires Xcode Command Line Tools for native module builds. |
| Windows native | Unsupported | None | Do not use native Windows service setup | Use WSL Ubuntu instead. |

## Setup by Host

### Ubuntu Linux

1. Install Node 20+ and native build tools.
2. Run `npm ci`, `npm run build:runners`, and `npm run build`.
3. Run `npm run setup -- --step service`.
4. Expect user services under `~/.config/systemd/user/`.

### Other Linux with systemd

Use the Ubuntu path. If `systemctl --user` is unavailable, HKClaw falls back to the limited wrapper-script path below.

### Linux without systemd

1. Install/build normally.
2. Run `npm run setup -- --step service`.
3. Expect generated `start-*.sh` scripts in the repo root.
4. Use those wrappers to start or restart long-running services manually.

### Windows Host via WSL Ubuntu

1. Install Ubuntu inside WSL.
2. Clone and build HKClaw inside the WSL filesystem, not on native Windows.
3. Run the same Linux setup commands from the WSL shell.
4. If your WSL distro has systemd enabled, HKClaw uses `systemd --user`; otherwise it writes repo-local wrapper scripts.

### macOS

1. Install Node 20+ and Xcode Command Line Tools.
2. Clone and build normally.
3. Run `npm run setup -- --step service`.
4. Expect LaunchAgent plists under `~/Library/LaunchAgents/`.

## Unsupported and Explicitly Limited Cases

- Native Windows service management is not supported.
- Linux hosts without `systemd` are installable, but long-running services rely on generated `nohup` wrappers instead of a native service manager.
- Container-only or ephemeral hosts should be treated as the limited Linux-without-systemd path unless they provide a real init/service manager.
