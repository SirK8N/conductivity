const { app: electronApp, BrowserWindow, dialog, Notification } = require('electron');
const fs = require('fs');

if (process.platform === 'win32') {
  electronApp.setAppUserModelId('com.conductivity.app');
}

if (electronApp.isPackaged) {
  process.env.CONDUCTIVITY_USER_DATA = electronApp.getPath('userData');
}

const { app: expressApp, startServer, setVaultPath, ensureVault, setElectronBridge } = require('./server');

let mainWindow;

setElectronBridge({
  notify({ title, body }) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(-1);
      if (!mainWindow.isFocused()) {
        mainWindow.flashFrame(true);
      }
    }

    if (Notification.isSupported()) {
      const notification = new Notification({
        title: title || 'Focus Timer Complete',
        body: body || 'Your focus session has finished.',
        silent: false
      });

      notification.on('click', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
          mainWindow.flashFrame(false);
        }
      });

      notification.show();
      return true;
    }
    return false;
  },
  updateTimerStatus({ running, progress }) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (running && typeof progress === 'number' && progress >= 0) {
        mainWindow.setProgressBar(Math.max(0.01, Math.min(1, progress)));
      } else {
        mainWindow.setProgressBar(-1);
      }
    }
  }
});

// Native folder picker when running inside Electron
expressApp.post('/api/pick-vault', async (req, res) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select or Create Conductivity Vault Folder',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths.length) {
      return res.json({ canceled: true });
    }
    const newDir = setVaultPath(result.filePaths[0]);
    const dataFile = ensureVault(newDir);
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    res.json({
      vaultPath: newDir,
      tasks: data.tasks || [],
      stickyNotes: data.stickyNotes || [],
      recurringTasks: data.recurringTasks || [],
      timeOffsetDays: data.timeOffsetDays || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function createWindow() {
  const { port } = await startServer(0); // Use any available local port
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    title: 'Conductivity',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false
    }
  });

  mainWindow.on('focus', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.flashFrame(false);
    }
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);
}

electronApp.whenReady().then(createWindow);

electronApp.on('window-all-closed', () => {
  if (process.platform !== 'darwin') electronApp.quit();
});

