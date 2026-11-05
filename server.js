const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DATA_ROOT = process.env.CONDUCTIVITY_USER_DATA || __dirname;
const CONFIG_FILE = path.join(DATA_ROOT, 'vault-config.json');
const DEFAULT_VAULT = path.join(DATA_ROOT, 'vault');


// This checks for and returns the vault
function getVaultPath() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (cfg.vaultPath) return cfg.vaultPath;
    }
  } catch (e) {}
  return DEFAULT_VAULT;
}

// This will create a file for a new vault
function setVaultPath(newPath) {
  const resolved = path.resolve(newPath);
  fs.mkdirSync(resolved, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ vaultPath: resolved }, null, 2));
  return resolved;
}

// 
function ensureVault(vaultDir) {
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.mkdirSync(path.join(vaultDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, 'stickies'), { recursive: true });
  const dataFile = path.join(vaultDir, 'vault.json');
  if (!fs.existsSync(dataFile)) {
    const initial = { tasks: [], stickyNotes: [], recurringTasks: [], timeOffsetDays: 0 };
    fs.writeFileSync(dataFile, JSON.stringify(initial, null, 2));
  }
  return dataFile;
}

// Also write Obsidian-friendly markdown files for each task and sticky note
function syncMarkdownFiles(vaultDir, tasks, stickyNotes = []) {
  const tasksDir = path.join(vaultDir, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const activeFiles = new Set();

  for (const t of tasks) {
    const safeTitle = (t.title || 'untitled').replace(/[^a-z0-9-_ ]/gi, '').trim().replace(/\s+/g, '-').toLowerCase();
    const filename = `${safeTitle || 'task'}-${t.id.slice(-4)}.md`;
    activeFiles.add(filename);
    const md = [
      '---',
      `id: "${t.id}"`,
      `title: "${(t.title || '').replace(/"/g, '\\"')}"`,
      `status: "${t.completed ? (t.inJar ? 'in-jar' : 'completed') : 'active'}"`,
      t.recurrenceFrequency ? `recurrence: "${t.recurrenceFrequency}"` : null,
      `createdAt: ${ new Date(t.createdAt).toISOString() }`,
      t.completedAt ? `completedAt: ${ new Date(t.completedAt).toISOString() }` : null,
      `timeSpentSeconds: ${t.timeSpent || 0}`,
      `position: [${Number(t.x || 0.2).toFixed(3)}, ${Number(t.y || 0.2).toFixed(3)}]`,
      '---',
      '',
      `# ${t.title || 'Untitled Task'}`,
      '',
      '## Notes',
      t.notes || '_No notes yet._',
      '',
      '## Marble Memory',
      t.memory || '_No completion memory recorded._',
      ''
    ].filter(line => line !== null).join('\n');

    fs.writeFileSync(path.join(tasksDir, filename), md, 'utf8');
  }

  // Clean up removed task markdown files
  for (const file of fs.readdirSync(tasksDir)) {
    if (file.endsWith('.md') && !activeFiles.has(file)) {
      try { fs.unlinkSync(path.join(tasksDir, file)); } catch (e) {}
    }
  }

  // Sync sticky notes markdown files
  const stickiesDir = path.join(vaultDir, 'stickies');
  fs.mkdirSync(stickiesDir, { recursive: true });
  const activeStickyFiles = new Set();

  for (const s of stickyNotes) {
    const safeTitle = (s.title || 'sticky').replace(/[^a-z0-9-_ ]/gi, '').trim().replace(/\s+/g, '-').toLowerCase();
    const filename = `${safeTitle || 'sticky'}-${s.id.slice(-4)}.md`;
    activeStickyFiles.add(filename);
    const md = [
      '---',
      `id: "${s.id}"`,
      `title: "${(s.title || '').replace(/"/g, '\\"')}"`,
      `color: "${s.color || 'yellow'}"`,
      `createdAt: ${ new Date(s.createdAt || Date.now()).toISOString() }`,
      `position: [${Number(s.x || 0.5).toFixed(3)}, ${Number(s.y || 0.5).toFixed(3)}]`,
      '---',
      '',
      `# ${s.title || 'Untitled Idea'}`,
      '',
      s.content || '_No content._',
      ''
    ].join('\n');

    fs.writeFileSync(path.join(stickiesDir, filename), md, 'utf8');
  }

  for (const file of fs.readdirSync(stickiesDir)) {
    if (file.endsWith('.md') && !activeStickyFiles.has(file)) {
      try { fs.unlinkSync(path.join(stickiesDir, file)); } catch (e) {}
    }
  }
}

app.get('/api/state', (req, res) => {
  const vaultDir = getVaultPath();
  const dataFile = ensureVault(vaultDir);
  try {
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    res.json({
      vaultPath: vaultDir,
      tasks: data.tasks || [],
      stickyNotes: data.stickyNotes || [],
      recurringTasks: data.recurringTasks || [],
      timeOffsetDays: data.timeOffsetDays || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/state', (req, res) => {
  const vaultDir = getVaultPath();
  const dataFile = ensureVault(vaultDir);
  try {
    const payload = {
      tasks: Array.isArray(req.body.tasks) ? req.body.tasks : [],
      stickyNotes: Array.isArray(req.body.stickyNotes) ? req.body.stickyNotes : [],
      recurringTasks: Array.isArray(req.body.recurringTasks) ? req.body.recurringTasks : [],
      timeOffsetDays: Number(req.body.timeOffsetDays) || 0,
      updatedAt: Date.now()
    };
    fs.writeFileSync(dataFile, JSON.stringify(payload, null, 2), 'utf8');
    syncMarkdownFiles(vaultDir, payload.tasks, payload.stickyNotes);
    res.json({ ok: true, vaultPath: vaultDir });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vault-path', (req, res) => {
  try {
    if (!req.body.vaultPath) return res.status(400).json({ error: 'vaultPath required' });
    const newDir = setVaultPath(req.body.vaultPath);
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

let electronBridge = null;

function setElectronBridge(bridge) {
  electronBridge = bridge;
}

app.post('/api/notify', (req, res) => {
  try {
    const { title, body, taskId, durationMinutes } = req.body || {};
    if (electronBridge && typeof electronBridge.notify === 'function') {
      const shown = electronBridge.notify({ title, body, taskId, durationMinutes });
      return res.json({ ok: true, native: Boolean(shown) });
    }
    res.json({ ok: true, native: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/timer-status', (req, res) => {
  try {
    if (electronBridge && typeof electronBridge.updateTimerStatus === 'function') {
      electronBridge.updateTimerStatus(req.body || {});
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function startServer(port = 3456) {
  return new Promise((resolve) => {
    const server = app.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      console.log(`Conductivity server running at http://127.0.0.1:${actualPort}`);
      resolve({ server, port: actualPort });
    });
  });
}

if (require.main === module) {
  startServer(3456);
}

module.exports = { app, startServer, setVaultPath, ensureVault, setElectronBridge };
