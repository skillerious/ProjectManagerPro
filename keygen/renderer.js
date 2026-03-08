const keyCountInput = document.getElementById('key-count');
const decreaseCountBtn = document.getElementById('decrease-count-btn');
const increaseCountBtn = document.getElementById('increase-count-btn');
const generateBtn = document.getElementById('generate-btn');
const copyAllBtn = document.getElementById('copy-all-btn');
const keyTotalEl = document.getElementById('key-total');
const statusTextEl = document.getElementById('status-text');
const statusPillEl = document.getElementById('status-pill');
const keysListEl = document.getElementById('keys-list');
const minimizeBtn = document.getElementById('minimize-btn');
const closeBtn = document.getElementById('close-btn');
const tierSelect = document.getElementById('tier-select');

// Custom dropdown elements
const tierDropdown = document.getElementById('tier-dropdown');
const tierTrigger = document.getElementById('tier-trigger');
const tierMenu = document.getElementById('tier-menu');
const tierDisplayText = document.getElementById('tier-display-text');
const tierItems = tierMenu ? tierMenu.querySelectorAll('.kg-dropdown-item') : [];

// Overlay elements
const aboutBtn = document.getElementById('about-btn');
const helpBtn = document.getElementById('help-btn');
const aboutOverlay = document.getElementById('about-overlay');

// View elements
const viewGenerator = document.getElementById('view-generator');
const viewHelp = document.getElementById('view-help');
const helpBackBtn = document.getElementById('help-back-btn');
const helpNav = document.getElementById('help-nav');
const helpContent = document.getElementById('help-content');

let generatedKeys = [];

// --- About Overlay Logic ---

function openOverlay(overlay) {
  if (!overlay) return;
  overlay.classList.add('open');
}

function closeOverlay(overlay) {
  if (!overlay) return;
  overlay.classList.remove('open');
}

function populateAboutInfo() {
  const electronEl = document.getElementById('about-electron-ver');
  const nodeEl = document.getElementById('about-node-ver');
  const platformEl = document.getElementById('about-platform-ver');

  const info = window.keygenApi.getSystemInfo();
  if (electronEl) electronEl.textContent = info.electron || '--';
  if (nodeEl) nodeEl.textContent = info.node || '--';
  if (platformEl) platformEl.textContent = info.platform || '--';
}

if (aboutBtn) {
  aboutBtn.addEventListener('click', () => {
    populateAboutInfo();
    openOverlay(aboutOverlay);
  });
}

// Close buttons and backdrop clicks (about overlay)
document.querySelectorAll('[data-close]').forEach((el) => {
  el.addEventListener('click', () => {
    const target = el.dataset.close;
    if (target === 'about') closeOverlay(aboutOverlay);
  });
});

// --- Help View Logic ---

function showView(viewName) {
  if (viewName === 'help') {
    viewGenerator.classList.remove('view-active');
    viewHelp.classList.add('view-active');
  } else {
    viewHelp.classList.remove('view-active');
    viewGenerator.classList.add('view-active');
  }
}

function switchHelpTab(tabName) {
  if (!helpNav || !helpContent) return;

  helpNav.querySelectorAll('.help-nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.tab === tabName);
  });

  helpContent.querySelectorAll('.help-pane').forEach((pane) => {
    pane.classList.toggle('active', pane.dataset.pane === tabName);
  });
}

if (helpBtn) {
  helpBtn.addEventListener('click', () => {
    showView('help');
  });
}

if (helpBackBtn) {
  helpBackBtn.addEventListener('click', () => {
    showView('generator');
  });
}

if (helpNav) {
  helpNav.addEventListener('click', (e) => {
    const navItem = e.target.closest('.help-nav-item');
    if (navItem && navItem.dataset.tab) {
      switchHelpTab(navItem.dataset.tab);
    }
  });
}

// --- Custom Dropdown Logic ---

function openTierDropdown() {
  tierDropdown.classList.add('open');
}

function closeTierDropdown() {
  tierDropdown.classList.remove('open');
}

function selectTierItem(item) {
  const value = item.dataset.value;
  const name = item.querySelector('.kg-dropdown-item-name')?.textContent || '';

  tierSelect.value = value;
  tierDisplayText.textContent = name;

  tierItems.forEach((el) => el.classList.remove('selected'));
  item.classList.add('selected');

  closeTierDropdown();
}

if (tierTrigger) {
  tierTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (tierDropdown.classList.contains('open')) {
      closeTierDropdown();
    } else {
      openTierDropdown();
    }
  });
}

tierItems.forEach((item) => {
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    selectTierItem(item);
  });
});

document.addEventListener('click', (e) => {
  if (tierDropdown && !tierDropdown.contains(e.target)) {
    closeTierDropdown();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (aboutOverlay && aboutOverlay.classList.contains('open')) {
      closeOverlay(aboutOverlay);
      return;
    }
    if (viewHelp && viewHelp.classList.contains('view-active')) {
      showView('generator');
      return;
    }
    if (tierDropdown.classList.contains('open')) {
      closeTierDropdown();
      tierTrigger.focus();
    }
  }
});

// --- Core Logic ---

function setStatus(message, state = 'ready') {
  if (!statusTextEl || !statusPillEl) {
    return;
  }

  statusTextEl.textContent = message;
  statusPillEl.classList.remove('ready', 'working', 'error', 'success');
  statusPillEl.classList.add(state);
}

function normalizeCount(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return 10;
  }
  return Math.max(1, Math.min(parsed, 200));
}

function setCountValue(nextValue) {
  const normalized = normalizeCount(nextValue);
  keyCountInput.value = String(normalized);
  return normalized;
}

function updateKeyTotalBadge(count) {
  if (!keyTotalEl) {
    return;
  }
  keyTotalEl.textContent = `${count} ${count === 1 ? 'key' : 'keys'}`;
  keyTotalEl.classList.toggle('has-keys', count > 0);
}

function renderKeys(keys) {
  if (!keysListEl) {
    return;
  }

  keysListEl.textContent = '';

  if (!Array.isArray(keys) || keys.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'keys-empty';

    const icon = document.createElement('div');
    icon.className = 'keys-empty-icon';
    icon.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>';

    const textWrap = document.createElement('div');
    textWrap.className = 'keys-empty-text';

    const title = document.createElement('div');
    title.className = 'keys-empty-title';
    title.textContent = 'No keys generated';

    const sub = document.createElement('div');
    sub.className = 'keys-empty-sub';
    sub.innerHTML = 'Click <strong>Generate Keys</strong> to create license keys';

    textWrap.append(title, sub);
    empty.append(icon, textWrap);
    keysListEl.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();

  keys.forEach((key, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'key-row animate-in';
    row.style.animationDelay = `${Math.min(index * 20, 400)}ms`;
    row.setAttribute('role', 'listitem');
    row.setAttribute('aria-label', `Copy key ${index + 1}`);

    const rowIndex = document.createElement('span');
    rowIndex.className = 'key-row-index';
    rowIndex.textContent = String(index + 1).padStart(3, '0');

    const rowValue = document.createElement('span');
    rowValue.className = 'key-row-value';
    rowValue.textContent = key;

    const rowAction = document.createElement('span');
    rowAction.className = 'key-row-action';
    rowAction.textContent = 'Copy';

    row.append(rowIndex, rowValue, rowAction);
    row.addEventListener('click', async () => {
      await copySingleKey(key, row, rowAction);
    });

    fragment.appendChild(row);
  });

  keysListEl.appendChild(fragment);
}

async function copySingleKey(key, rowEl, actionEl) {
  if (!key) {
    return;
  }

  try {
    await window.keygenApi.copy(key);

    if (rowEl) {
      rowEl.classList.add('copied', 'copy-flash');
      if (actionEl) {
        actionEl.textContent = 'Copied!';
      }
      setTimeout(() => {
        rowEl.classList.remove('copied', 'copy-flash');
        if (actionEl) {
          actionEl.textContent = 'Copy';
        }
      }, 1200);
    }

    setStatus('Key copied to clipboard', 'success');
  } catch (error) {
    setStatus(error.message || 'Copy failed', 'error');
  }
}

async function generateKeys() {
  const count = setCountValue(keyCountInput.value);
  const tier = tierSelect ? tierSelect.value : '20';
  setStatus('Generating keys\u2026', 'working');
  generateBtn.disabled = true;
  copyAllBtn.disabled = true;

  generateBtn.classList.add('generating');

  try {
    const result = await window.keygenApi.generate(count, tier);
    if (!result || !result.success || !Array.isArray(result.keys)) {
      throw new Error('Generator returned an invalid response.');
    }

    generatedKeys = result.keys;
    renderKeys(generatedKeys);
    updateKeyTotalBadge(generatedKeys.length);
    copyAllBtn.disabled = generatedKeys.length === 0;
    setStatus(`${generatedKeys.length} keys ready`, 'success');
  } catch (error) {
    generatedKeys = [];
    renderKeys(generatedKeys);
    updateKeyTotalBadge(0);
    copyAllBtn.disabled = true;
    setStatus(error.message || 'Failed to generate keys', 'error');
  } finally {
    generateBtn.disabled = false;
    generateBtn.classList.remove('generating');
  }
}

async function copyAll() {
  if (!generatedKeys.length) {
    setStatus('Nothing to copy', 'error');
    return;
  }

  try {
    await window.keygenApi.copy(generatedKeys.join('\n'));
    setStatus('All keys copied', 'success');
  } catch (error) {
    setStatus(error.message || 'Copy failed', 'error');
  }
}

generateBtn.addEventListener('click', async () => {
  await generateKeys();
});

copyAllBtn.addEventListener('click', async () => {
  await copyAll();
});

decreaseCountBtn.addEventListener('click', () => {
  const current = setCountValue(keyCountInput.value);
  setCountValue(current - 1);
});

increaseCountBtn.addEventListener('click', () => {
  const current = setCountValue(keyCountInput.value);
  setCountValue(current + 1);
});

keyCountInput.addEventListener('change', () => {
  setCountValue(keyCountInput.value);
});

keyCountInput.addEventListener('keydown', async (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    await generateKeys();
  }
});

minimizeBtn.addEventListener('click', () => {
  window.keygenApi.minimize();
});

closeBtn.addEventListener('click', () => {
  window.keygenApi.close();
});

window.addEventListener('keydown', async (event) => {
  const isCtrlOrCmd = event.ctrlKey || event.metaKey;
  const activeEl = document.activeElement;

  if (!isCtrlOrCmd) {
    return;
  }

  if (event.key.toLowerCase() === 'g') {
    event.preventDefault();
    await generateKeys();
    return;
  }

  if (event.key.toLowerCase() === 'c') {
    if (activeEl === keyCountInput) {
      return;
    }
    event.preventDefault();
    await copyAll();
  }
});

renderKeys([]);
updateKeyTotalBadge(0);
setStatus('Ready', 'ready');
generateKeys();
