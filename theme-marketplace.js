// ============================================
// THEME MARKETPLACE - Professional Curated Themes
// ============================================

const THEME_MARKETPLACE = [
    {
        id: 'monokai-pro',
        displayName: 'Monokai Pro',
        description: 'Beautiful Monokai-inspired dark theme with vibrant syntax highlighting',
        author: 'Monokai',
        version: '2.1.0',
        rating: 4.9,
        downloads: 125340,
        category: 'Dark',
        tags: ['dark', 'vibrant', 'popular', 'pro'],
        preview: {
            background: '#2d2a2e',
            accent: '#ff6188',
            secondary: '#ffd866',
            palette: ['#2d2a2e', '#ff6188', '#ffd866', '#a9dc76', '#78dce8', '#ab9df2']
        },
        css: `:root {
    --bg-primary: #2d2a2e;
    --bg-secondary: #221f22;
    --bg-tertiary: #3a3739;
    --text-primary: #fcfcfa;
    --text-secondary: #939293;
    --accent-primary: #ff6188;
    --accent-secondary: #ffd866;
    --border-color: #5b595c;
    --success: #a9dc76;
    --warning: #fc9867;
    --error: #ff6188;
    --info: #78dce8;
}

.sidebar { background: var(--bg-secondary); border-right: 1px solid var(--border-color); }
.titlebar { background: var(--bg-secondary); }
.project-card, .extension-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover, .extension-card:hover { border-color: var(--accent-primary); transform: translateY(-2px); box-shadow: 0 8px 24px rgba(255, 97, 136, 0.15); }
.btn-primary { background: linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%); }
.stat-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.stat-card:hover { border-color: var(--accent-primary); }
.modal-content { background: var(--bg-secondary); border-color: var(--border-color); }`
    },
    {
        id: 'dracula-official',
        displayName: 'Dracula Official',
        description: 'Dark theme with perfect contrast and vibrant colors. Official Dracula theme',
        author: 'Dracula Theme',
        version: '4.0.1',
        rating: 4.8,
        downloads: 234750,
        category: 'Dark',
        tags: ['dark', 'vibrant', 'popular', 'purple'],
        preview: {
            background: '#282a36',
            accent: '#bd93f9',
            secondary: '#ff79c6',
            palette: ['#282a36', '#bd93f9', '#ff79c6', '#50fa7b', '#8be9fd', '#f1fa8c']
        },
        css: `:root {
    --bg-primary: #282a36;
    --bg-secondary: #21222c;
    --bg-tertiary: #343746;
    --text-primary: #f8f8f2;
    --text-secondary: #6272a4;
    --accent-primary: #bd93f9;
    --accent-secondary: #ff79c6;
    --border-color: #44475a;
    --success: #50fa7b;
    --warning: #f1fa8c;
    --error: #ff5555;
    --info: #8be9fd;
}

.sidebar { background: var(--bg-secondary); }
.titlebar { background: var(--bg-secondary); }
.project-card, .extension-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover, .extension-card:hover { border-color: var(--accent-primary); box-shadow: 0 4px 20px rgba(189, 147, 249, 0.2); }
.btn-primary { background: linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%); }`
    },
    {
        id: 'nord-aurora',
        displayName: 'Nord Aurora',
        description: 'Arctic-inspired color palette with beautiful frost blues and aurora accents',
        author: 'Arctic Ice Studio',
        version: '0.19.0',
        rating: 4.7,
        downloads: 187920,
        category: 'Dark',
        tags: ['dark', 'blue', 'minimal', 'nord'],
        preview: {
            background: '#2e3440',
            accent: '#88c0d0',
            secondary: '#81a1c1',
            palette: ['#2e3440', '#88c0d0', '#81a1c1', '#a3be8c', '#ebcb8b', '#bf616a']
        },
        css: `:root {
    --bg-primary: #2e3440;
    --bg-secondary: #3b4252;
    --bg-tertiary: #434c5e;
    --text-primary: #eceff4;
    --text-secondary: #d8dee9;
    --accent-primary: #88c0d0;
    --accent-secondary: #81a1c1;
    --border-color: #4c566a;
    --success: #a3be8c;
    --warning: #ebcb8b;
    --error: #bf616a;
    --info: #5e81ac;
}

.sidebar { background: var(--bg-secondary); }
.titlebar { background: var(--bg-secondary); }
.project-card, .extension-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover, .extension-card:hover { border-color: var(--accent-primary); box-shadow: 0 4px 16px rgba(136, 192, 208, 0.15); }`
    },
    {
        id: 'tokyo-night',
        displayName: 'Tokyo Night',
        description: 'Clean, dark theme inspired by Tokyo nights with neon accents',
        author: 'Tokyo Night',
        version: '1.3.0',
        rating: 4.9,
        downloads: 156240,
        category: 'Dark',
        tags: ['dark', 'blue', 'neon', 'modern'],
        preview: {
            background: '#1a1b26',
            accent: '#7aa2f7',
            secondary: '#bb9af7',
            palette: ['#1a1b26', '#7aa2f7', '#bb9af7', '#9ece6a', '#e0af68', '#f7768e']
        },
        css: `:root {
    --bg-primary: #1a1b26;
    --bg-secondary: #16161e;
    --bg-tertiary: #24283b;
    --text-primary: #c0caf5;
    --text-secondary: #565f89;
    --accent-primary: #7aa2f7;
    --accent-secondary: #bb9af7;
    --border-color: #292e42;
    --success: #9ece6a;
    --warning: #e0af68;
    --error: #f7768e;
    --info: #7dcfff;
}

.sidebar { background: var(--bg-secondary); }
.project-card, .extension-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover { border-color: var(--accent-primary); box-shadow: 0 8px 24px rgba(122, 162, 247, 0.2); }`
    },
    {
        id: 'github-dark',
        displayName: 'GitHub Dark',
        description: 'Professional dark theme from GitHub with clean aesthetics',
        author: 'GitHub',
        version: '1.0.0',
        rating: 4.6,
        downloads: 98750,
        category: 'Dark',
        tags: ['dark', 'minimal', 'professional', 'github'],
        preview: {
            background: '#0d1117',
            accent: '#58a6ff',
            secondary: '#8b949e',
            palette: ['#0d1117', '#58a6ff', '#8b949e', '#3fb950', '#d29922', '#f85149']
        },
        css: `:root {
    --bg-primary: #0d1117;
    --bg-secondary: #010409;
    --bg-tertiary: #161b22;
    --text-primary: #c9d1d9;
    --text-secondary: #8b949e;
    --accent-primary: #58a6ff;
    --accent-secondary: #1f6feb;
    --border-color: #30363d;
    --success: #3fb950;
    --warning: #d29922;
    --error: #f85149;
    --info: #79c0ff;
}

.sidebar { background: var(--bg-secondary); border-right: 1px solid var(--border-color); }
.project-card, .extension-card { background: var(--bg-tertiary); border: 1px solid var(--border-color); }`
    },
    {
        id: 'catppuccin-mocha',
        displayName: 'Catppuccin Mocha',
        description: 'Soothing pastel theme with warm, cozy colors. Community favorite!',
        author: 'Catppuccin',
        version: '1.2.0',
        rating: 4.9,
        downloads: 142680,
        category: 'Dark',
        tags: ['dark', 'pastel', 'cozy', 'popular'],
        preview: {
            background: '#1e1e2e',
            accent: '#cba6f7',
            secondary: '#f5c2e7',
            palette: ['#1e1e2e', '#cba6f7', '#f5c2e7', '#a6e3a1', '#fab387', '#f38ba8']
        },
        css: `:root {
    --bg-primary: #1e1e2e;
    --bg-secondary: #181825;
    --bg-tertiary: #313244;
    --text-primary: #cdd6f4;
    --text-secondary: #9399b2;
    --accent-primary: #cba6f7;
    --accent-secondary: #f5c2e7;
    --border-color: #45475a;
    --success: #a6e3a1;
    --warning: #fab387;
    --error: #f38ba8;
    --info: #89dceb;
}

.sidebar { background: var(--bg-secondary); }
.project-card, .extension-card { background: var(--bg-tertiary); border-color: var(--border-color); }
.project-card:hover { border-color: var(--accent-primary); box-shadow: 0 6px 20px rgba(203, 166, 247, 0.2); }`
    },
    {
        id: 'one-dark-pro',
        displayName: 'One Dark Pro',
        description: 'Atom One Dark theme for professionals. Highly customizable',
        author: 'Binaryify',
        version: '3.15.2',
        rating: 4.8,
        downloads: 312450,
        category: 'Dark',
        tags: ['dark', 'atom', 'popular', 'classic'],
        preview: {
            background: '#282c34',
            accent: '#61afef',
            secondary: '#c678dd',
            palette: ['#282c34', '#61afef', '#c678dd', '#98c379', '#e5c07b', '#e06c75']
        },
        css: `:root {
    --bg-primary: #282c34;
    --bg-secondary: #21252b;
    --bg-tertiary: #2c313c;
    --text-primary: #abb2bf;
    --text-secondary: #5c6370;
    --accent-primary: #61afef;
    --accent-secondary: #c678dd;
    --border-color: #181a1f;
    --success: #98c379;
    --warning: #e5c07b;
    --error: #e06c75;
    --info: #56b6c2;
}

.sidebar { background: var(--bg-secondary); }
.project-card, .extension-card { background: var(--bg-tertiary); border-color: var(--border-color); }`
    },
    {
        id: 'gruvbox-dark',
        displayName: 'Gruvbox Dark',
        description: 'Retro groove color scheme with warm, earthy tones',
        author: 'Gruvbox',
        version: '1.0.0',
        rating: 4.7,
        downloads: 94320,
        category: 'Dark',
        tags: ['dark', 'retro', 'warm', 'earthy'],
        preview: {
            background: '#282828',
            accent: '#fe8019',
            secondary: '#d3869b',
            palette: ['#282828', '#fe8019', '#d3869b', '#b8bb26', '#fabd2f', '#fb4934']
        },
        css: `:root {
    --bg-primary: #282828;
    --bg-secondary: #1d2021;
    --bg-tertiary: #3c3836;
    --text-primary: #ebdbb2;
    --text-secondary: #a89984;
    --accent-primary: #fe8019;
    --accent-secondary: #d3869b;
    --border-color: #504945;
    --success: #b8bb26;
    --warning: #fabd2f;
    --error: #fb4934;
    --info: #83a598;
}

.sidebar { background: var(--bg-secondary); }
.project-card, .extension-card { background: var(--bg-tertiary); border-color: var(--border-color); }`
    },
    {
        id: 'material-ocean',
        displayName: 'Material Ocean',
        description: 'Material Design inspired theme with ocean blue tones',
        author: 'Material Theme',
        version: '6.8.0',
        rating: 4.7,
        downloads: 178920,
        category: 'Dark',
        tags: ['dark', 'material', 'blue', 'modern'],
        preview: {
            background: '#0f111a',
            accent: '#82aaff',
            secondary: '#c792ea',
            palette: ['#0f111a', '#82aaff', '#c792ea', '#c3e88d', '#ffcb6b', '#f07178']
        },
        css: `:root {
    --bg-primary: #0f111a;
    --bg-secondary: #090b10;
    --bg-tertiary: #1b1e2b;
    --text-primary: #8f93a2;
    --text-secondary: #4b526d;
    --accent-primary: #82aaff;
    --accent-secondary: #c792ea;
    --border-color: #464b5d;
    --success: #c3e88d;
    --warning: #ffcb6b;
    --error: #f07178;
    --info: #89ddff;
}

.sidebar { background: var(--bg-secondary); }
.project-card, .extension-card { background: var(--bg-tertiary); border-color: var(--border-color); }`
    },
    {
        id: 'night-owl',
        displayName: 'Night Owl',
        description: 'Fine-tuned for those who code late into the night',
        author: 'Sarah Drasner',
        version: '2.0.1',
        rating: 4.8,
        downloads: 167430,
        category: 'Dark',
        tags: ['dark', 'blue', 'night', 'accessibility'],
        preview: {
            background: '#011627',
            accent: '#7fdbca',
            secondary: '#c792ea',
            palette: ['#011627', '#7fdbca', '#c792ea', '#addb67', '#ecc48d', '#ef5350']
        },
        css: `:root {
    --bg-primary: #011627;
    --bg-secondary: #01111d;
    --bg-tertiary: #0b2942;
    --text-primary: #d6deeb;
    --text-secondary: #5f7e97;
    --accent-primary: #7fdbca;
    --accent-secondary: #c792ea;
    --border-color: #1d3b53;
    --success: #addb67;
    --warning: #ecc48d;
    --error: #ef5350;
    --info: #82aaff;
}

.sidebar { background: var(--bg-secondary); }
.project-card, .extension-card { background: var(--bg-tertiary); border-color: var(--border-color); }`
    }
];

// Export for use in renderer
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { THEME_MARKETPLACE };
}
