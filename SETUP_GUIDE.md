# 🚀 Project Manager Pro - Advanced Features Setup Guide

## 📋 Table of Contents
1. [Installation](#installation)
2. [Features Overview](#features-overview)
3. [Usage Guide](#usage-guide)
4. [Technical Details](#technical-details)

---

## 🔧 Installation

### Step 1: Install Dependencies

```bash
npm install
```

This will install all required packages:
- `chokidar` - File system watcher
- `node-pty` - Terminal emulator
- `xterm` - Terminal UI
- `xterm-addon-fit` - Terminal sizing
- `diff` - Diff algorithm
- `vis-network` - Graph visualization

### Step 2: Start the Application

```bash
npm start
```

---

## ✨ Features Overview

### 1. 🔄 Real-Time Git Status Updates

**What it does:**
- Watches your project directory for file changes
- Automatically refreshes git status when files change
- Debounced updates (500ms) to prevent excessive refreshes
- Visual indicator showing watcher is active

**How to use:**
1. Select a project in Git view
2. File watcher starts automatically
3. Make changes to any file
4. Watch the git status update in real-time!

**Technical:**
- Uses `chokidar` for efficient file watching
- Ignores `.git` directory and node_modules
- Maximum depth of 3 levels to optimize performance
- IPC event: `git-status-changed`

---

### 2. ⏮️ Undo/Redo Git Operations

**What it does:**
- Records every git operation (commit, push, pull, merge, etc.)
- Keeps history of last 50 operations
- One-click undo with intelligent rollback
- View complete operation history with timestamps

**How to use:**
1. Perform any git operation (commit, push, etc.)
2. Click "Undo" button in git view header
3. Operation is automatically rolled back using `git reset --soft`
4. Click "History" to see all recorded operations

**Operations tracked:**
- ✅ Commits
- ✅ Pushes
- ✅ Pulls
- ✅ Merges
- ✅ Rebases
- ✅ Cherry-picks
- ✅ Branch operations

**Technical:**
- Stores in-memory operation stack
- Each operation includes: type, message, timestamp, project path
- Smart undo uses `git reset --soft HEAD~1` for commits
- Can be expanded to `git reflog` based recovery

---

### 3. 📁 Project Templates System

**What it does:**
- One-click project scaffolding
- Pre-configured templates for popular frameworks
- Auto-generates project structure with files
- Includes package.json with dependencies

**Available Templates:**

#### React Application
```
react-app/
├── package.json
├── public/
│   └── index.html
├── src/
│   ├── App.jsx
│   └── index.jsx
└── README.md
```

#### Node.js API
```
node-api/
├── package.json
├── src/
│   └── index.js
└── README.md
```

#### Python Flask App
```
python-app/
├── app.py
├── requirements.txt
└── README.md
```

**How to use:**
1. Click "New Project" or use Ctrl+N
2. Select "Create from Template"
3. Choose template type
4. Enter project name
5. Click "Create"
6. Template is generated with all files!

**Technical:**
- Templates defined in `main.js` - easy to add custom ones!
- Creates directory structure automatically
- Writes all files with correct content
- Initializes git repository by default

---

### 4. 🔀 Conflict Resolution UI

**What it does:**
- Detects merge conflicts automatically
- Shows visual 3-way merge editor
- Accept yours/theirs/both options
- Inline editing of conflicts

**How to use:**
1. Pull changes that cause conflicts
2. Conflict modal appears automatically
3. View side-by-side diff:
   - **Left:** Your changes
   - **Middle:** Merged result
   - **Right:** Their changes
4. Click "Accept Yours" or "Accept Theirs"
5. Or manually edit the middle pane
6. Click "Save Resolution"

**Technical:**
- Parses git conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`)
- Uses `diff` library for 3-way merge algorithm
- Editable merge result
- Auto-stages files after resolution

---

### 5. 📊 Git Graph Visualization

**What it does:**
- Interactive commit history graph
- Visual branch representation
- Color-coded branches and tags
- Click commits to view details

**Features:**
- **Node colors:** Different color per branch
- **Edges:** Show parent-child relationships
- **Hover:** See commit message and author
- **Click:** View full commit details
- **Pan/Zoom:** Navigate large histories

**How to use:**
1. Go to Git view → History tab
2. Click "Show Graph"
3. Interactive graph appears
4. Click any commit to see details
5. Use mouse to pan and zoom

**Technical:**
- Uses `vis-network` for graph rendering
- Parses `git log --graph --all --pretty=format:...`
- Physics-based layout
- Custom styling to match app theme

---

### 6. 💻 Integrated Terminal

**What it does:**
- Full-featured terminal embedded in the app
- Runs in project directory
- Multiple terminal tabs
- PowerShell/CMD support on Windows
- Bash/Zsh support on Linux/Mac

**Features:**
- **Multiple tabs:** Open multiple terminals
- **Auto-CD:** Starts in project directory
- **Copy/Paste:** Ctrl+C/Ctrl+V support
- **Resize:** Auto-fits to container
- **Colors:** Full ANSI color support

**How to use:**
1. Go to Git view → Terminal tab
2. Click "+" to add new terminal
3. Terminal opens in project directory
4. Run any command!
5. Click tab "×" to close

**Shortcuts:**
- `Ctrl+Shift+T` - New terminal tab
- `Ctrl+Shift+W` - Close current tab
- `Ctrl+L` - Clear terminal

**Technical:**
- Uses `xterm.js` for terminal emulator
- `node-pty` for pseudo-terminal
- Integrates with system shell (cmd.exe on Windows)
- Full escape sequence support

---

### 7. 👁️ Code Review Interface

**What it does:**
- Review commits before merging
- Side-by-side diff viewer
- Add inline comments
- Approve or request changes
- Track review history

**Features:**
- **File list:** All changed files
- **Diff view:** Side-by-side comparison
- **Comments:** Add inline comments
- **Status:** Approve/Changes Requested/Pending
- **History:** See all past reviews

**How to use:**
1. Go to Git view → Review tab
2. Select commit or branch to review
3. View changed files
4. Click file to see diff
5. Add comments inline
6. Click "Approve" or "Request Changes"

**Comment System:**
- Click line number to add comment
- Comments saved per commit
- Supports markdown
- Thread conversations

**Technical:**
- Uses `diff` for syntax-aware diffing
- Comments stored in `.git/review-comments/`
- JSON format for easy parsing
- Can integrate with GitHub API for PR comments

---

## 🎮 Usage Examples

### Example 1: Real-Time Development

```
1. Open your project in Git view
2. Terminal auto-opens in project directory
3. Run: npm start
4. Edit files in your code editor
5. Watch git status update automatically!
6. See file changes appear instantly
7. Commit when ready
```

### Example 2: Conflict Resolution

```
1. Working on feature branch
2. Pull from main branch
3. Conflicts detected!
4. Conflict UI appears automatically
5. See your changes vs their changes
6. Click "Accept Both" to merge
7. Edit merged result if needed
8. Save resolution
9. Commit resolved merge
```

### Example 3: Template Project Creation

```
1. New Project → From Template
2. Select "React Application"
3. Name: "my-awesome-app"
4. Click Create
5. Full React project generated!
6. Terminal opens automatically
7. Run: npm install
8. Run: npm start
9. Start coding!
```

---

## 🔧 Configuration

### File Watcher Settings

Add to `settings.json`:
```json
{
  "enableFileWatcher": true,
  "autoRefreshInterval": 2000,
  "watcherDepth": 3
}
```

### Operation History

```json
{
  "maxHistorySize": 50,
  "enableUndo": true
}
```

### Terminal Settings

```json
{
  "terminalApp": "cmd",
  "terminalFontSize": 14,
  "terminalTheme": "dark"
}
```

---

## 🎨 Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| New Terminal | `Ctrl+Shift+T` |
| Close Terminal | `Ctrl+Shift+W` |
| Undo Git Operation | `Ctrl+Z` (in git view) |
| Redo Git Operation | `Ctrl+Y` (in git view) |
| Refresh Status | `F5` |
| Show Git Graph | `Ctrl+G` |
| New from Template | `Ctrl+Shift+N` |

---

## 📊 Performance

All features are optimized for performance:

- **File Watcher:** Debounced updates, ignores node_modules
- **Git Operations:** Async/await, non-blocking
- **Terminal:** Virtual scrollback, efficient rendering
- **Graph:** Lazy loading, viewport culling
- **Diff:** Incremental parsing, worker threads

---

## 🐛 Troubleshooting

### File Watcher Not Working

**Solution:**
1. Check if `chokidar` is installed: `npm list chokidar`
2. Restart application
3. Check logs in `%APPDATA%/project-manager-pro/logs/`

### Terminal Won't Open

**Solution:**
1. Check if `node-pty` is installed
2. On Windows, ensure you have build tools: `npm install --global windows-build-tools`
3. Rebuild: `npm rebuild node-pty`

### Git Graph Not Showing

**Solution:**
1. Ensure project has git history
2. Run: `git log` in terminal to verify
3. Check browser console for errors

---

## 🚀 What's Next?

The application now has enterprise-grade features:

✅ Real-time updates
✅ Visual conflict resolution
✅ Interactive commit graph
✅ Undo/Redo system
✅ Project templates
✅ Integrated terminal
✅ Code review interface

**Enjoy your professional-grade project manager!**

---

## 📝 Notes

- All features work offline
- Git operations are logged for debugging
- Terminal sessions are ephemeral (don't persist)
- Operation history resets on app restart (can be persisted)
- Templates can be customized in `main.js`

---

Made with ❤️ by Project Manager Pro Team
