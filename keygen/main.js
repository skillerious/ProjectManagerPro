const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const {
  generateProductKey,
  formatProductKey,
  getLicenseSecret,
  VALID_TIERS
} = require('../license-utils');

function resolveAssetPath(fileName) {
  const candidates = [
    path.join(process.resourcesPath || '', 'assets', fileName),
    path.join(__dirname, '..', 'assets', fileName)
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return path.join(__dirname, '..', 'assets', fileName);
}

const iconPath = resolveAssetPath('keygen.ico');
const splashLogoUrl = pathToFileURL(resolveAssetPath('keygen.png')).toString();

let splashWindow = null;
let keygenWindow = null;

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 320,
    frame: false,
    transparent: false,
    icon: iconPath,
    backgroundColor: '#1e1f22',
    resizable: false,
    movable: true,
    center: true,
    skipTaskbar: false,
    show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
  });

  splashWindow.loadFile(path.join(__dirname, 'splash.html'), {
    query: {
      logo: splashLogoUrl
    }
  });
  splashWindow.once('ready-to-show', () => {
    splashWindow.show();
  });
}

function createKeygenWindow() {
  keygenWindow = new BrowserWindow({
    width: 740,
    height: 660,
    minWidth: 620,
    minHeight: 540,
    maxWidth: 960,
    maxHeight: 900,
    frame: false,
    icon: iconPath,
    backgroundColor: '#1e1f22',
    resizable: true,
    maximizable: false,
    show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
  });

  keygenWindow.loadFile(path.join(__dirname, 'index.html'));

  keygenWindow.once('ready-to-show', () => {
    // Small delay so the splash progress animation can finish
    setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
        splashWindow = null;
      }
      keygenWindow.show();
    }, 5000);
  });

  keygenWindow.on('closed', () => {
    keygenWindow = null;
  });
}

ipcMain.handle('keygen:generate', async (event, countInput, tierInput) => {
  const parsedCount = Number.parseInt(countInput, 10);
  const count = Number.isFinite(parsedCount) ? Math.max(1, Math.min(parsedCount, 200)) : 1;
  const tier = VALID_TIERS[tierInput] ? tierInput : '20';

  const keys = [];
  for (let index = 0; index < count; index += 1) {
    keys.push(formatProductKey(generateProductKey(getLicenseSecret(), { tier })));
  }

  return {
    success: true,
    keys,
    tier
  };
});

ipcMain.handle('keygen:copy', async (event, text) => {
  clipboard.writeText(typeof text === 'string' ? text : '');
  return { success: true };
});

ipcMain.handle('keygen:minimize', async () => {
  if (keygenWindow && !keygenWindow.isDestroyed()) {
    keygenWindow.minimize();
  }
});

ipcMain.handle('keygen:close', async () => {
  if (keygenWindow && !keygenWindow.isDestroyed()) {
    keygenWindow.close();
  }
});

app.whenReady().then(() => {
  createSplashWindow();
  createKeygenWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
