# Project Manager Pro

<p align="center">
  <strong>Desktop Project Workflow Hub built with Electron</strong><br/>
  Project scaffolding, Git workflows, extensions/themes, task automation, secure registration, and app updates in one place.
</p>

<p align="center">
  <img alt="Platform" src="https://img.shields.io/badge/Platform-Windows-0078D4?logo=windows&logoColor=white">
  <img alt="Electron" src="https://img.shields.io/badge/Electron-39.x-47848F?logo=electron&logoColor=white">
  <img alt="Node" src="https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/License-MIT-22c55e">
  <img alt="Updater" src="https://img.shields.io/badge/Auto%20Update-GitHub%20Releases-181717?logo=github">
</p>

---

## Table of Contents

- [What This Project Is](#what-this-project-is)
- [Feature Highlights](#feature-highlights)
- [Feature Matrix](#feature-matrix)
- [Security and Registration](#security-and-registration)
- [Activation Keys](#activation-keys)
- [Getting Started](#getting-started)
- [Build and Release](#build-and-release)
- [Update Source](#update-source)
- [Project Structure](#project-structure)
- [Scripts](#scripts)
- [Testing](#testing)
- [License](#license)

---

## What This Project Is

Project Manager Pro is a personal engineering project focused on practical desktop tooling and secure architecture patterns.

Main goals:

- Build a real desktop workflow app, not a demo-only shell
- Practice secure IPC, command/path validation, and defensive Electron patterns
- Implement a product-key registration system as a cryptography learning exercise
- Deliver a production-style packaging and GitHub-releases update flow

---

## Feature Highlights

- Smart project creation from templates (Electron, React, Vue, Node, Python Flask, and more)
- Advanced Git operations in-app (branching, stash, diff/hunks, merge/rebase/cherry-pick, tags, remotes)
- Conflict assistant and merge-resolution helpers
- Workspace snapshots and task-profile automation
- Extension/theme installation and per-extension settings
- Indexed search and operation queue with cancel/retry behavior
- Smart dialogs for settings and update flows
- Secure preload bridge with strict IPC allowlists
- Product registration with encrypted local license state and machine fingerprint checks
- GitHub Releases update checks/download/install with update channels

---

## Feature Matrix

| Area | Included |
|---|---|
| Project Management | Create, import, export, rename, delete, recent projects, workspace path control |
| Templates | Multi-stack templates and scaffolded project bootstrapping |
| Git Core | Status, commit, pull, push, fetch, sync, history, diff |
| Git Advanced | Branching, stash workflow, merge/rebase/cherry-pick, reset/revert/clean |
| Merge/Conflict Tools | Conflict listing, conflict resolution actions, merge continue/abort |
| GitHub | Token auth, user lookup, upload candidate discovery, guided project upload |
| Extensions/Themes | Install/uninstall, enable/disable, settings persistence, theme CSS loading |
| Automation | Workspace snapshots, task profiles, operation queue, indexed search |
| Settings UX | First-run setup, validated settings model, smart save/unsaved dialog flows |
| Security | IPC channel allowlists, sanitized inputs, validated command execution, secure license handling |
| Updates | Stable/beta/alpha channels, check/download/install, rollback-to-stable checks |

---

## Security and Registration

> [!NOTE]
> Product registration is implemented as part of this personal project to learn and practice cryptography, secure local persistence, key validation, and device-binding behavior.
>
> **No purchase is required** for this repository/demo setup.

Security architecture includes:

- Strict renderer-to-main IPC allowlists in preload bridge
- Safer command/path validation for shell and Git operations
- Encrypted/signed local license payload handling
- Product-key metadata and checksum validation
- Device fingerprint matching with grace-period logic

---

## Activation Keys

Use any key below in the app registration flow.

### Standard Keys

```text
1028-9038-2060-0413
1026-3267-6248-1731
1025-4820-2538-6566
1023-6447-0465-8126
1028-4560-2126-1278
1022-1228-3434-6065
1021-1612-4406-1401
1021-2274-5075-2667
1029-5301-2197-1036
1025-1154-1323-3640
```

### Pro Keys

```text
2026-7495-0172-7380
2028-9606-7139-8831
2022-6758-5687-6619
2020-3418-5659-4232
2021-9220-5484-5240
2026-1875-5430-0479
2027-4989-7499-3910
2028-8320-3947-0132
2021-1535-4296-0380
2024-3191-8711-7304
```

### Enterprise Keys

```text
3020-5521-7856-0405
3024-5671-6966-9546
3027-9582-3102-7824
3024-3458-0303-1758
3027-5314-6350-5595
3027-0004-2852-6496
3026-8914-1756-8550
3029-7587-3591-8702
3029-7619-1719-5928
3025-9944-1204-1768
```

---

## Getting Started

### Prerequisites

- Node.js 18+ (recommended)
- npm
- Windows environment (primary packaging target)

### Install

```bash
npm install
```

### Run (Development)

```bash
npm start
```

---

## Build and Release

### Build Windows Installer

```bash
npm run build-win
```

### Build Distribution

```bash
npm run dist
```

### Build Keygen App

```bash
npm run build-keygen
```

---

## Update Source

Updater is configured to pull from GitHub releases:

- https://github.com/skillerious/ProjectManagerPro/releases

Configured provider values:

- `provider`: `github`
- `owner`: `skillerious`
- `repo`: `ProjectManagerPro`

---

## Project Structure

```text
AppManager/
  main.js
  renderer.js
  preload.js
  index.html
  styles.css
  main/
    update-manager.js
    operation-queue.js
    workspace-services.js
  tests/
  scripts/
  assets/
```

---

## Scripts

| Script | Purpose |
|---|---|
| `npm start` | Launch app in development mode |
| `npm run test:safety` | Run safety-focused test suite |
| `npm run build-win` | Build Windows installer |
| `npm run dist` | Build distribution artifacts |
| `npm run keygen` | Run key generation app |
| `npm run build-keygen` | Build key generation app package |
| `npm run generate:key` | Generate product key via script |

---

## Testing

Run:

```bash
npm run test:safety
```

This validates security utilities, license logic, operation queue, workspace services, and IPC contract coverage.

---

## License

MIT
