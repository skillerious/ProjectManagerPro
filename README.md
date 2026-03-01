# Project Manager Pro

Desktop project management app built with Electron.  
It combines project scaffolding, Git tooling, extensions/themes, workflow automation, and secure product registration in one local-first application.

## Overview

Project Manager Pro is a personal engineering project focused on:

- Practical desktop workflow tooling
- Secure IPC and safe command execution patterns
- Real-world product key and registration flows
- Updater and packaging architecture for Electron apps

This repository includes the full app source, tests, and build configuration.

## Core Features

### Project and Workspace Management

- Create projects from templates (`Electron`, `React`, `Vue`, `Node.js`, `Python Flask`, and more)
- Import existing repositories/projects
- Export projects
- Rename/delete projects
- Recent projects tracking and quick-access
- Workspace snapshots:
  - Save workspace state
  - List snapshots
  - Restore snapshots
- Per-project task profiles:
  - Save task profiles
  - Load and run task profiles

### Git Tools

- Repository status, history, and diffs
- Stage/unstage, commit, pull, push, fetch, sync
- Branch operations:
  - Create
  - Checkout
  - Delete
- Stash operations:
  - Create
  - List
  - Apply
  - Pop
- Advanced operations:
  - Merge
  - Rebase
  - Cherry-pick
  - Reset
  - Revert
  - Clean
- Remote management:
  - List remotes
  - Add remote
  - Remove remote
- Tags:
  - List
  - Create
  - Delete
- Conflict assistant flow:
  - List conflicts
  - Resolve conflict entries
  - Continue/abort merge
- Hunk-level diff and selective apply

### GitHub Integration

- Save/disconnect GitHub token
- Load authenticated user profile
- Prepare upload candidates
- Guided upload flow for project publishing

### Extensions and Themes

- Install/uninstall extensions
- Enable/disable installed extensions
- Extension settings persistence
- Theme extension loading and CSS injection
- Download/install themes from URL metadata

### Search and Automation

- Indexed workspace search:
  - Build index
  - Query index
- Operation queue:
  - Enqueue jobs
  - Track queue state
  - Cancel/retry jobs
- Command palette with workflow actions

### Settings and UX

- First-run setup wizard
- Advanced settings model with sanitation and validation
- Smart settings save/unsaved dialogs with animated fallback UX
- External links configurable from settings
- Keyboard shortcuts and menu actions

### App Updates

- Update channel support (`stable`, `beta`, `alpha`)
- Check/download/install updates
- Stable rollback check flow
- Live update status events to renderer
- **Release source configured for GitHub releases**:
  - `https://github.com/skillerious/ProjectManagerPro/releases`

### Security Architecture

- Secure preload bridge (`AppBridge`) with strict IPC allowlists
- Centralized command and path validation
- Safer git command wrappers with structured error handling
- Product key validation and metadata extraction
- Device-bound license persistence and fingerprint checks
- Grace-period handling on hardware changes
- Encrypted license storage and signed payload verification

## Tech Stack

- Electron
- Node.js
- Vanilla JS / HTML / CSS renderer architecture
- `electron-updater` for auto-update pipeline

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
  assets/
```

## Getting Started

### Prerequisites

- Node.js 18+ recommended
- npm
- Windows is the primary target (NSIS packaging configured)

### Install Dependencies

```bash
npm install
```

### Run in Development

```bash
npm start
```

### Run Safety Tests

```bash
npm run test:safety
```

### Build Installer (Windows)

```bash
npm run build-win
```

### Build Distribution

```bash
npm run dist
```

## Update Source Configuration

The app updater is configured to use GitHub Releases from:

- `https://github.com/skillerious/ProjectManagerPro/releases`

In build configuration, publish provider is GitHub (`owner: skillerious`, `repo: ProjectManagerPro`).

## Product Registration Notice

This app includes a product registration system because this is a personal project where I explored cryptography, validation design, and secure local license storage workflows.

- There is **no purchase required** for this repository/demo setup.
- You can use the keys below to activate tiers in-app.

## Activation Keys

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

## Notes

- Update download/install actions depend on packaged build behavior.
- Development mode typically does not perform full install/restart update flow.
- Use a packaged build to validate end-to-end updater installation behavior.

## License

MIT (repository codebase)
