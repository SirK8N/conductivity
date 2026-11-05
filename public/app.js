// ==================== APPLICATION STATE ====================
let state = {
  vaultPath: './vault',
  tasks: [],
  stickyNotes: [],
  recurringTasks: [],
  timeOffsetDays: 0
};

let activeSection = 'section-matrix';
let selectedMatrixTaskId = null;
let selectedStickyId = null;
let convertingStickyId = null;
let newStickyColor = 'yellow';
let selectedMarbleTaskId = null;
let selectedFocusTaskId = null;

// Focus Timer State
let timerInterval = null;
let timerWorker = null;
let timerRunning = false;
let timerModeMinutes = 25; // 0 = Stopwatch mode
let timerRemainingSec = 25 * 60;
let timerSessionElapsedSec = 0;
let timerLastTickAt = null;
let timerUnsavedSec = 0;

// Marble Jar Physics State
const marblesPhysics = new Map(); // id -> { x, y, vx, vy, r }
let hoveredMarbleId = null;
let jarDimensions = { cx: 0, cy: 0, width: 180, height: 220, topY: 0, bottomY: 0 };

// ==================== INITIALIZATION & VAULT SYNC ====================
async function init() {
  initTheme();
  await loadState();
  applyTimeDrift(0); // Apply any real-world elapsed drift since last session
  processRecurringTasks();
  bindNavigation();
  bindVaultActions();
  bindStickiesSection();
  bindMatrixSection();
  bindRecurringModal();
  bindJarSection();
  bindFocusSection();
  renderAll();
  requestAnimationFrame(stepJarPhysics);

  // Subtle background check every 60s for real-time aging, drift, & recurring spawns
  setInterval(() => {
    applyTimeDrift(0);
    processRecurringTasks();
    if (activeSection === 'section-matrix') renderMatrix();
  }, 60000);
}

function initTheme() {
  const savedTheme = localStorage.getItem('conductivity-theme') || 'dark';
  applyTheme(savedTheme);
  const toggleBtn = document.getElementById('btn-theme-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
      applyTheme(current === 'light' ? 'dark' : 'light');
    });
  }
}

function applyTheme(theme) {
  const isLight = theme === 'light';
  if (isLight) {
    document.documentElement.dataset.theme = 'light';
  } else {
    delete document.documentElement.dataset.theme;
  }
  localStorage.setItem('conductivity-theme', isLight ? 'light' : 'dark');
  const toggleBtn = document.getElementById('btn-theme-toggle');
  if (toggleBtn) {
    toggleBtn.textContent = isLight ? '☾ Dark' : '☀ Light';
  }
}

async function loadState() {
  try {
    const res = await fetch('/api/state');
    const data = await res.json();
    state.vaultPath = data.vaultPath || './vault';
    state.tasks = Array.isArray(data.tasks) ? data.tasks : [];
    state.stickyNotes = Array.isArray(data.stickyNotes) ? data.stickyNotes : [];
    state.recurringTasks = Array.isArray(data.recurringTasks) ? data.recurringTasks : [];
    state.timeOffsetDays = Number(data.timeOffsetDays) || 0;
    document.getElementById('vault-indicator').textContent = state.vaultPath;
  } catch (err) {
    console.error('Failed to load state:', err);
  }
}

let saveTimeout = null;
function saveState(immediate = false) {
  const badge = document.getElementById('notes-save-status');
  if (badge) badge.textContent = 'Saving...';

  const performSave = async () => {
    try {
      await fetch('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tasks: state.tasks,
          stickyNotes: state.stickyNotes,
          recurringTasks: state.recurringTasks,
          timeOffsetDays: state.timeOffsetDays
        })
      });
      if (badge) badge.textContent = 'Saved to Vault';
    } catch (e) {
      if (badge) badge.textContent = 'Save error';
    }
  };

  if (immediate) {
    clearTimeout(saveTimeout);
    performSave();
  } else {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(performSave, 350);
  }
}

// ==================== HELPER CALCULATIONS ====================
function getEffectiveNow() {
  return Date.now() + state.timeOffsetDays * 86400000;
}

function getTaskAgeDays(task) {
  const realDays = Math.max(0, (Date.now() - (task.createdAt || Date.now())) / 86400000);
  const taskOffsetStart = typeof task.simOffsetAtCreation === 'number' ? task.simOffsetAtCreation : 0;
  return Math.max(0, realDays + (state.timeOffsetDays - taskOffsetStart));
}

// Color transitions from Pastel Yellow -> Warm Amber -> Dark Red as task ages
function getTaskColor(task) {
  const ageDays = task.completed && typeof task.frozenAgeDays === 'number'
    ? task.frozenAgeDays
    : getTaskAgeDays(task);
  const maxDays = Math.max(1, Number(task.maxDays) || 7);
  const ratio = Math.min(1, Math.max(0, ageDays / maxDays));

  // Hue: 54 (pastel yellow) -> 0 (dark red)
  // Saturation: 95% -> 78%
  // Lightness: 80% -> 26%
  const hue = Math.round(54 * (1 - ratio));
  const sat = Math.round(95 - 17 * ratio);
  const light = Math.round(80 - 54 * ratio);
  const textColor = light > 52 ? '#0a0a0a' : '#f5f5f5';

  return {
    bg: `hsl(${hue}, ${sat}%, ${light}%)`,
    text: textColor,
    ratio
  };
}

// Scale grows larger toward center (0.5, 0.5) and drastically shrinks toward all edges & corners
function getCenterScale(x, y) {
  const dx = x - 0.5;
  const dy = y - 0.5;
  // Normalize against arena bounds so both cardinal edges (~0.42..0.44) and corners shrink drastically
  const normX = Math.abs(dx) / 0.44;
  const normY = Math.abs(dy) / 0.42;
  const radial = Math.hypot(normX, normY); // 0 at center, 1 at cardinal edges, ~1.41 at corners
  const edgeProximity = Math.max(normX, normY); // 0 at center, 1 at any outer edge
  const combined = Math.min(1, 0.52 * (radial / 1.12) + 0.48 * edgeProximity);
  const curve = Math.pow(combined, 1.15);
  return Math.max(0.30, 1.56 - curve * 1.26); // 1.56x at center -> 0.30x at outer edges
}

function getQuadrantCoords(quad) {
  const jitter = () => (Math.random() - 0.5) * 0.12;
  return {
    tl: { x: 0.22 + jitter(), y: 0.24 + jitter() },
    tr: { x: 0.78 + jitter(), y: 0.24 + jitter() },
    bl: { x: 0.22 + jitter(), y: 0.72 + jitter() },
    br: { x: 0.78 + jitter(), y: 0.72 + jitter() }
  }[quad] || { x: 0.25, y: 0.25 };
}

function inferQuadrantFromCoords(x, y) {
  const isRight = (x ?? 0.25) >= 0.5;
  const isBottom = (y ?? 0.25) >= 0.5;
  if (!isRight && !isBottom) return 'tl';
  if (isRight && !isBottom) return 'tr';
  if (!isRight && isBottom) return 'bl';
  return 'br';
}

// ==================== RECURRING TASKS ENGINE ====================
// Structured schedule format designed to support daily/weekly/monthly/yearly now,
// and complex rules (e.g. daysOfWeek: [1,3,5], custom intervals, dayOfMonth) later.
function createRecurrenceSchedule(frequency = 'daily', options = {}) {
  if (frequency && typeof frequency === 'object') {
    return {
      frequency: frequency.frequency || 'daily',
      interval: Math.max(1, Number(frequency.interval) || 1),
      daysOfWeek: Array.isArray(frequency.daysOfWeek) ? frequency.daysOfWeek : null,
      dayOfMonth: frequency.dayOfMonth || null,
      monthOfYear: frequency.monthOfYear || null
    };
  }
  return {
    frequency: String(frequency || 'daily').toLowerCase(),
    interval: Math.max(1, Number(options.interval) || 1),
    daysOfWeek: Array.isArray(options.daysOfWeek) ? options.daysOfWeek : null,
    dayOfMonth: options.dayOfMonth || null,
    monthOfYear: options.monthOfYear || null
  };
}

function computeNextOccurrence(scheduleInput, fromTimestamp = getEffectiveNow()) {
  const schedule = createRecurrenceSchedule(scheduleInput);
  const interval = schedule.interval || 1;
  const baseMs = Number(fromTimestamp) || getEffectiveNow();

  switch (schedule.frequency) {
    case 'daily':
      return baseMs + interval * 86400000;

    case 'weekly': {
      // Support future multi-day weekly schedules (e.g. daysOfWeek: [1, 3, 5])
      if (Array.isArray(schedule.daysOfWeek) && schedule.daysOfWeek.length > 0) {
        const sortedDays = [...new Set(schedule.daysOfWeek.map(Number))].sort((a, b) => a - b);
        const d = new Date(baseMs);
        for (let step = 1; step <= 7 * interval; step++) {
          const candidate = new Date(baseMs + step * 86400000);
          if (sortedDays.includes(candidate.getDay())) {
            return candidate.getTime();
          }
        }
      }
      return baseMs + interval * 7 * 86400000;
    }

    case 'monthly': {
      const d = new Date(baseMs);
      d.setMonth(d.getMonth() + interval);
      if (schedule.dayOfMonth) {
        d.setDate(schedule.dayOfMonth);
      }
      return d.getTime();
    }

    case 'yearly': {
      const d = new Date(baseMs);
      d.setFullYear(d.getFullYear() + interval);
      return d.getTime();
    }

    default:
      return baseMs + 86400000;
  }
}

function formatFrequencyLabel(scheduleInput) {
  const schedule = createRecurrenceSchedule(scheduleInput);
  const map = {
    daily: 'Daily',
    weekly: 'Weekly',
    monthly: 'Monthly',
    yearly: 'Yearly'
  };
  return map[schedule.frequency] || schedule.frequency;
}

function spawnTaskFromRecurringRule(rule, customCoords = null) {
  const effectiveNow = getEffectiveNow();
  const coords = customCoords || getQuadrantCoords(rule.quadrant || 'tl');
  const freq = rule.schedule ? rule.schedule.frequency : 'daily';

  const newTask = {
    id: 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    title: rule.title,
    notes: rule.notes || '',
    memory: '',
    maxDays: Number(rule.maxDays) || 7,
    x: coords.x,
    y: coords.y,
    createdAt: Date.now(),
    simOffsetAtCreation: state.timeOffsetDays,
    lastDriftAt: Date.now(),
    timeSpent: 0,
    completed: false,
    completedAt: null,
    inJar: false,
    recurringId: rule.id,
    recurrenceFrequency: freq
  };

  state.tasks.push(newTask);
  rule.lastSpawnedAt = effectiveNow;
  rule.nextDueAt = computeNextOccurrence(rule.schedule, effectiveNow);
  return newTask;
}

function processRecurringTasks() {
  if (!Array.isArray(state.recurringTasks) || state.recurringTasks.length === 0) return false;
  const effectiveNow = getEffectiveNow();
  let changed = false;

  for (const rule of state.recurringTasks) {
    if (rule.enabled === false) continue;
    rule.schedule = createRecurrenceSchedule(rule.schedule || rule.frequency || 'daily');
    if (!rule.nextDueAt) {
      rule.nextDueAt = computeNextOccurrence(rule.schedule, rule.lastSpawnedAt || effectiveNow);
      changed = true;
    }

    if (effectiveNow >= rule.nextDueAt) {
      const hasActiveInstance = state.tasks.some(t => !t.completed && t.recurringId === rule.id);
      if (!hasActiveInstance) {
        spawnTaskFromRecurringRule(rule);
      } else {
        // Advance nextDueAt so it checks again on the next cycle
        rule.nextDueAt = computeNextOccurrence(rule.schedule, effectiveNow);
      }
      changed = true;
    }
  }

  if (changed) {
    saveState();
  }
  return changed;
}

// Slowly drift active tasks toward (0.5, 0.5) over days
function applyTimeDrift(extraSimulatedDays = 0) {
  const now = Date.now();
  let changed = false;

  if (extraSimulatedDays !== 0) {
    state.timeOffsetDays = Math.max(0, state.timeOffsetDays + extraSimulatedDays);
    changed = true;
  }

  for (const t of state.tasks) {
    if (t.completed) continue;
    const lastDrift = t.lastDriftAt || t.createdAt || now;
    const elapsedRealDays = Math.max(0, (now - lastDrift) / 86400000);
    const totalDriftDays = elapsedRealDays + Math.max(0, extraSimulatedDays);

    if (totalDriftDays > 0.001) {
      // Each day, task moves ~14% closer to the center (0.5, 0.5)
      const factor = Math.pow(0.86, totalDriftDays);
      t.x = 0.5 + (t.x - 0.5) * factor;
      t.y = 0.5 + (t.y - 0.5) * factor;
      t.lastDriftAt = now;
      changed = true;
    }
  }

  if (processRecurringTasks()) {
    changed = true;
  }

  if (changed) saveState();
}

function formatDuration(totalSeconds) {
  const sec = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
}

// ==================== NAVIGATION & VAULT CONTROLS ====================
function bindNavigation() {
  document.querySelectorAll('.dock-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switchSection(btn.dataset.target);
    });
  });
}

function switchSection(targetId) {
  activeSection = targetId;
  document.querySelectorAll('.view-section').forEach(s => {
    s.classList.toggle('active', s.id === targetId);
  });
  document.querySelectorAll('.dock-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.target === targetId);
  });
  closePopover();
  closeStickyPopover();
  renderAll();
}

function bindVaultActions() {
  // Change Vault Folder (uses Electron native dialog if available, else prompt)
  document.getElementById('btn-change-vault').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/pick-vault', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        if (!data.canceled && data.vaultPath) {
          state.vaultPath = data.vaultPath;
          state.tasks = data.tasks || [];
          state.stickyNotes = data.stickyNotes || [];
          state.recurringTasks = data.recurringTasks || [];
          state.timeOffsetDays = data.timeOffsetDays || 0;
          document.getElementById('vault-indicator').textContent = state.vaultPath;
          marblesPhysics.clear();
          renderAll();
        }
        return;
      }
    } catch (e) {}

    // Fallback when running in standalone web mode
    const manualPath = prompt('Enter local folder path for your Vault:', state.vaultPath);
    if (manualPath && manualPath.trim()) {
      const res = await fetch('/api/vault-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vaultPath: manualPath.trim() })
      });
      const data = await res.json();
      if (data.vaultPath) {
        state.vaultPath = data.vaultPath;
        state.tasks = data.tasks || [];
        state.stickyNotes = data.stickyNotes || [];
        state.recurringTasks = data.recurringTasks || [];
        state.timeOffsetDays = data.timeOffsetDays || 0;
        document.getElementById('vault-indicator').textContent = state.vaultPath;
        marblesPhysics.clear();
        renderAll();
      }
    }
  });

  // Export Vault JSON
  document.getElementById('btn-export-vault').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `conductivity-vault-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // Import Vault JSON
  document.getElementById('input-import-vault').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(reader.result);
        if (Array.isArray(imported.tasks)) {
          state.tasks = imported.tasks;
          state.stickyNotes = Array.isArray(imported.stickyNotes) ? imported.stickyNotes : [];
          state.recurringTasks = Array.isArray(imported.recurringTasks) ? imported.recurringTasks : [];
          state.timeOffsetDays = Number(imported.timeOffsetDays) || 0;
          marblesPhysics.clear();
          saveState(true);
          renderAll();
        }
      } catch (err) {
        alert('Invalid Vault JSON file.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });
}

// ==================== SECTION 0: STICKY NOTES ====================
function bindStickiesSection() {
  const modal = document.getElementById('modal-add-sticky');
  const form = document.getElementById('form-add-sticky');

  document.getElementById('btn-add-sticky').addEventListener('click', () => {
    closeStickyPopover();
    modal.classList.remove('hidden');
    document.getElementById('new-sticky-title').focus();
  });

  const closeStickyModal = () => {
    modal.classList.add('hidden');
    form.reset();
    newStickyColor = 'yellow';
    document.querySelectorAll('#new-sticky-colors .sticky-color-swatch').forEach(sw => {
      sw.classList.toggle('active', sw.dataset.color === 'yellow');
    });
  };

  document.getElementById('modal-sticky-close').addEventListener('click', closeStickyModal);
  document.getElementById('modal-sticky-cancel').addEventListener('click', closeStickyModal);

  // Color swatches in Add Sticky Modal
  document.querySelectorAll('#new-sticky-colors .sticky-color-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      newStickyColor = sw.dataset.color;
      document.querySelectorAll('#new-sticky-colors .sticky-color-swatch').forEach(s => {
        s.classList.toggle('active', s.dataset.color === newStickyColor);
      });
    });
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = document.getElementById('new-sticky-title').value.trim();
    if (!title) return;
    const content = document.getElementById('new-sticky-content').value;

    const count = state.stickyNotes.length;
    const col = count % 4;
    const row = Math.floor(count / 4) % 3;
    const jitter = () => (Math.random() - 0.5) * 0.05;
    const x = Math.min(0.86, Math.max(0.14, 0.22 + col * 0.19 + jitter()));
    const y = Math.min(0.80, Math.max(0.22, 0.28 + row * 0.22 + jitter()));

    const sticky = {
      id: 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      title,
      content,
      color: newStickyColor || 'yellow',
      x,
      y,
      createdAt: Date.now()
    };

    state.stickyNotes.push(sticky);
    saveState(true);
    closeStickyModal();
    renderAll();
  });

  // Sticky Note Inspector Popover bindings
  document.getElementById('sticky-pop-close').addEventListener('click', closeStickyPopover);

  document.getElementById('sticky-pop-title').addEventListener('input', (e) => {
    const s = state.stickyNotes.find(x => x.id === selectedStickyId);
    if (s) {
      s.title = e.target.value;
      saveState();
      renderStickies();
    }
  });

  document.getElementById('sticky-pop-content').addEventListener('input', (e) => {
    const s = state.stickyNotes.find(x => x.id === selectedStickyId);
    if (s) {
      s.content = e.target.value;
      saveState();
      renderStickies();
    }
  });

  document.querySelectorAll('#sticky-pop-colors .sticky-color-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      const s = state.stickyNotes.find(x => x.id === selectedStickyId);
      if (s) {
        s.color = sw.dataset.color;
        document.querySelectorAll('#sticky-pop-colors .sticky-color-swatch').forEach(btn => {
          btn.classList.toggle('active', btn.dataset.color === s.color);
        });
        saveState();
        renderStickies();
      }
    });
  });

  document.getElementById('sticky-pop-convert').addEventListener('click', () => {
    const s = state.stickyNotes.find(x => x.id === selectedStickyId);
    if (s) {
      closeStickyPopover();
      openConvertStickyModal(s);
    }
  });

  document.getElementById('sticky-pop-delete').addEventListener('click', () => {
    state.stickyNotes = state.stickyNotes.filter(x => x.id !== selectedStickyId);
    closeStickyPopover();
    saveState(true);
    renderAll();
  });

  document.getElementById('sticky-arena').addEventListener('pointerdown', (e) => {
    if (e.target.id === 'sticky-arena' || e.target.id === 'sticky-nodes') {
      closeStickyPopover();
    }
  });
}

function renderStickies() {
  const container = document.getElementById('sticky-nodes');
  if (!container) return;
  container.innerHTML = '';

  if (state.stickyNotes.length === 0) {
    container.innerHTML = `
      <div class="sticky-empty-hint">
        NO STICKY NOTES YET<br/>
        Click + in the top-right to jot down an idea before it becomes a goal.
      </div>
    `;
    updateDockBadges();
    return;
  }

  for (const sticky of state.stickyNotes) {
    const el = document.createElement('div');
    el.className = 'sticky-note';
    el.dataset.id = sticky.id;
    el.dataset.color = sticky.color || 'yellow';

    // Static positioning — sticky notes do NOT shrink or scale as they move around
    el.style.left = `${(sticky.x * 100).toFixed(2)}%`;
    el.style.top = `${(sticky.y * 100).toFixed(2)}%`;

    el.innerHTML = `
      <div>
        <div class="sticky-note-title">${escapeHtml(sticky.title || 'Untitled Idea')}</div>
        <div class="sticky-note-body">${escapeHtml(sticky.content || '')}</div>
      </div>
      <div class="sticky-note-footer">
        <span class="sticky-note-tag">IDEA NOTE</span>
        <button type="button" class="sticky-convert-inline" title="Turn this sticky note into a task">&rarr; Task</button>
      </div>
    `;

    const convertBtn = el.querySelector('.sticky-convert-inline');
    convertBtn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    });
    convertBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeStickyPopover();
      openConvertStickyModal(sticky);
    });

    bindStickyDragAndClick(el, sticky);
    container.appendChild(el);
  }

  updateDockBadges();
}

function bindStickyDragAndClick(el, sticky) {
  let startX = 0, startY = 0;
  let moved = false;

  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    startX = e.clientX;
    startY = e.clientY;
    moved = false;
    el.classList.add('dragging');
  });

  el.addEventListener('pointermove', (e) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.hypot(dx, dy) > 4) moved = true;

    if (moved) {
      closeStickyPopover();
      const arena = document.getElementById('sticky-arena').getBoundingClientRect();
      const nx = Math.min(0.92, Math.max(0.08, (e.clientX - arena.left) / arena.width));
      const ny = Math.min(0.86, Math.max(0.12, (e.clientY - arena.top) / arena.height));
      sticky.x = nx;
      sticky.y = ny;

      el.style.left = `${(nx * 100).toFixed(2)}%`;
      el.style.top = `${(ny * 100).toFixed(2)}%`;
    }
  });

  el.addEventListener('pointerup', (e) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    el.releasePointerCapture(e.pointerId);
    el.classList.remove('dragging');
    if (moved) {
      saveState();
    } else {
      openStickyPopover(sticky, el);
    }
  });
}

function openStickyPopover(sticky, el) {
  selectedStickyId = sticky.id;
  const pop = document.getElementById('sticky-popover');
  document.getElementById('sticky-pop-title').value = sticky.title || '';
  document.getElementById('sticky-pop-content').value = sticky.content || '';

  document.querySelectorAll('#sticky-pop-colors .sticky-color-swatch').forEach(sw => {
    sw.classList.toggle('active', sw.dataset.color === (sticky.color || 'yellow'));
  });

  pop.classList.remove('hidden');
  const arena = document.getElementById('sticky-arena').getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  let left = rect.left - arena.left + rect.width / 2 - 155;
  let top = rect.bottom - arena.top + 12;

  left = Math.max(16, Math.min(arena.width - 326, left));
  if (top + 260 > arena.height - 70) {
    top = Math.max(16, rect.top - arena.top - 255);
  }

  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function closeStickyPopover() {
  selectedStickyId = null;
  const pop = document.getElementById('sticky-popover');
  if (pop) pop.classList.add('hidden');
}

function openConvertStickyModal(sticky) {
  convertingStickyId = sticky.id;
  switchSection('section-matrix');
  const modal = document.getElementById('modal-add');
  document.getElementById('modal-add-heading').textContent = 'CONVERT STICKY TO TASK';
  document.getElementById('modal-add-submit').textContent = 'Convert to Task';
  document.getElementById('convert-sticky-banner').classList.remove('hidden');
  document.getElementById('new-title').value = sticky.title || '';
  document.getElementById('new-notes').value = sticky.content || '';
  document.getElementById('new-quadrant').value = inferQuadrantFromCoords(sticky.x, sticky.y);
  document.getElementById('new-max-days').value = '7';
  document.getElementById('new-recurrence').value = 'none';
  modal.classList.remove('hidden');
  document.getElementById('new-title').focus();
}

// ==================== SECTION 1: PRIORITY MATRIX ====================
function bindMatrixSection() {
  const modal = document.getElementById('modal-add');
  const form = document.getElementById('form-add-task');

  document.getElementById('btn-add-task').addEventListener('click', () => {
    convertingStickyId = null;
    document.getElementById('modal-add-heading').textContent = 'NEW TASK';
    document.getElementById('modal-add-submit').textContent = 'Create Task';
    document.getElementById('convert-sticky-banner').classList.add('hidden');
    modal.classList.remove('hidden');
    document.getElementById('new-title').focus();
  });

  const closeModal = () => {
    convertingStickyId = null;
    modal.classList.add('hidden');
    document.getElementById('convert-sticky-banner').classList.add('hidden');
    document.getElementById('modal-add-heading').textContent = 'NEW TASK';
    document.getElementById('modal-add-submit').textContent = 'Create Task';
    form.reset();
  };
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = document.getElementById('new-title').value.trim();
    if (!title) return;
    const quad = document.getElementById('new-quadrant').value;
    const maxDays = Number(document.getElementById('new-max-days').value) || 7;
    const recurrence = document.getElementById('new-recurrence').value || 'none';
    const notes = document.getElementById('new-notes').value;

    const coords = getQuadrantCoords(quad);

    if (recurrence !== 'none') {
      // Create a recurring task rule and immediately spawn the initial instance
      const schedule = createRecurrenceSchedule(recurrence);
      const effectiveNow = getEffectiveNow();
      const rule = {
        id: 'rt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        title,
        notes,
        quadrant: quad,
        maxDays,
        schedule,
        enabled: true,
        createdAt: Date.now(),
        lastSpawnedAt: effectiveNow,
        nextDueAt: computeNextOccurrence(schedule, effectiveNow)
      };
      state.recurringTasks.push(rule);
      spawnTaskFromRecurringRule(rule, coords);
    } else {
      const newTask = {
        id: 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        title,
        notes,
        memory: '',
        maxDays,
        x: coords.x,
        y: coords.y,
        createdAt: Date.now(),
        simOffsetAtCreation: state.timeOffsetDays,
        lastDriftAt: Date.now(),
        timeSpent: 0,
        completed: false,
        completedAt: null,
        inJar: false
      };
      state.tasks.push(newTask);
    }

    // If this task was converted from a Sticky Note, remove the sticky note
    if (convertingStickyId) {
      state.stickyNotes = state.stickyNotes.filter(s => s.id !== convertingStickyId);
      convertingStickyId = null;
    }

    saveState(true);
    closeModal();
    renderAll();
  });

  // Simulate +1 Day aging, center drift, & recurring task triggers
  document.getElementById('btn-sim-day').addEventListener('click', () => {
    applyTimeDrift(1);
    renderAll();
  });

  document.getElementById('btn-sim-reset').addEventListener('click', () => {
    state.timeOffsetDays = 0;
    saveState(true);
    renderAll();
  });

  // Popover bindings
  document.getElementById('pop-close').addEventListener('click', closePopover);

  document.getElementById('pop-title').addEventListener('input', (e) => {
    const t = state.tasks.find(x => x.id === selectedMatrixTaskId);
    if (t) {
      t.title = e.target.value;
      if (t.recurringId) {
        const rule = state.recurringTasks.find(r => r.id === t.recurringId);
        if (rule) rule.title = t.title;
      }
      saveState();
      renderMatrix();
    }
  });

  document.getElementById('pop-recurrence').addEventListener('change', (e) => {
    const t = state.tasks.find(x => x.id === selectedMatrixTaskId);
    if (!t) return;
    const val = e.target.value;
    const effectiveNow = getEffectiveNow();

    if (val === 'none') {
      if (t.recurringId) {
        state.recurringTasks = state.recurringTasks.filter(r => r.id !== t.recurringId);
      }
      delete t.recurringId;
      delete t.recurrenceFrequency;
    } else {
      t.recurrenceFrequency = val;
      let rule = t.recurringId ? state.recurringTasks.find(r => r.id === t.recurringId) : null;
      if (rule) {
        rule.schedule = createRecurrenceSchedule(val);
        rule.nextDueAt = computeNextOccurrence(rule.schedule, effectiveNow);
      } else {
        const schedule = createRecurrenceSchedule(val);
        rule = {
          id: 'rt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          title: t.title,
          notes: t.notes || '',
          quadrant: inferQuadrantFromCoords(t.x, t.y),
          maxDays: t.maxDays || 7,
          schedule,
          enabled: true,
          createdAt: Date.now(),
          lastSpawnedAt: effectiveNow,
          nextDueAt: computeNextOccurrence(schedule, effectiveNow)
        };
        state.recurringTasks.push(rule);
        t.recurringId = rule.id;
      }
    }
    saveState(true);
    renderMatrix();
  });

  document.getElementById('pop-notes').addEventListener('input', (e) => {
    const t = state.tasks.find(x => x.id === selectedMatrixTaskId);
    if (t) {
      t.notes = e.target.value;
      if (t.recurringId) {
        const rule = state.recurringTasks.find(r => r.id === t.recurringId);
        if (rule) rule.notes = t.notes;
      }
      saveState();
    }
  });

  document.getElementById('pop-complete').addEventListener('click', () => {
    const t = state.tasks.find(x => x.id === selectedMatrixTaskId);
    if (t) {
      markTaskComplete(t);
      closePopover();
      selectedMarbleTaskId = t.id;
      switchSection('section-jar');
    }
  });

  document.getElementById('pop-focus').addEventListener('click', () => {
    if (selectedMatrixTaskId) {
      selectedFocusTaskId = selectedMatrixTaskId;
      closePopover();
      switchSection('section-focus');
    }
  });

  document.getElementById('pop-delete').addEventListener('click', () => {
    state.tasks = state.tasks.filter(x => x.id !== selectedMatrixTaskId);
    closePopover();
    saveState(true);
    renderAll();
  });

  // Close popover when clicking empty matrix background
  document.getElementById('matrix-arena').addEventListener('pointerdown', (e) => {
    if (e.target.id === 'matrix-arena' || e.target.id === 'matrix-nodes') {
      closePopover();
    }
  });
}

// ==================== RECURRING TASKS MANAGEMENT MENU ====================
function bindRecurringModal() {
  const modal = document.getElementById('modal-recurring');
  const form = document.getElementById('form-recurring-task');
  const resetBtn = document.getElementById('btn-recurring-form-reset');

  const openModal = () => {
    closePopover();
    closeStickyPopover();
    resetRecurringForm();
    renderRecurringModal();
    modal.classList.remove('hidden');
  };

  const closeModal = () => {
    modal.classList.add('hidden');
    resetRecurringForm();
  };

  document.getElementById('btn-open-recurring').addEventListener('click', openModal);
  document.getElementById('btn-top-recurring').addEventListener('click', openModal);
  document.getElementById('modal-recurring-close').addEventListener('click', closeModal);
  resetBtn.addEventListener('click', resetRecurringForm);

  modal.addEventListener('pointerdown', (e) => {
    if (e.target === modal) closeModal();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const editId = document.getElementById('rec-edit-id').value;
    const title = document.getElementById('rec-title').value.trim();
    if (!title) return;
    const freq = document.getElementById('rec-frequency').value || 'daily';
    const maxDays = Number(document.getElementById('rec-max-days').value) || 7;
    const quadrant = document.getElementById('rec-quadrant').value || 'tl';
    const notes = document.getElementById('rec-notes').value;
    const spawnNow = document.getElementById('rec-spawn-now').checked;
    const effectiveNow = getEffectiveNow();

    if (editId) {
      const rule = state.recurringTasks.find(r => r.id === editId);
      if (rule) {
        rule.title = title;
        rule.schedule = createRecurrenceSchedule(freq);
        rule.maxDays = maxDays;
        rule.quadrant = quadrant;
        rule.notes = notes;
        rule.nextDueAt = computeNextOccurrence(rule.schedule, rule.lastSpawnedAt || effectiveNow);

        // Sync active uncompleted task instances linked to this rule
        for (const t of state.tasks) {
          if (!t.completed && t.recurringId === rule.id) {
            t.title = title;
            t.maxDays = maxDays;
            t.recurrenceFrequency = freq;
          }
        }
      }
    } else {
      const schedule = createRecurrenceSchedule(freq);
      const rule = {
        id: 'rt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        title,
        notes,
        quadrant,
        maxDays,
        schedule,
        enabled: true,
        createdAt: Date.now(),
        lastSpawnedAt: spawnNow ? effectiveNow : null,
        nextDueAt: computeNextOccurrence(schedule, effectiveNow)
      };
      state.recurringTasks.push(rule);
      if (spawnNow) {
        spawnTaskFromRecurringRule(rule);
      }
    }

    saveState(true);
    resetRecurringForm();
    renderRecurringModal();
    renderAll();
  });
}

function resetRecurringForm() {
  const form = document.getElementById('form-recurring-task');
  if (form) form.reset();
  document.getElementById('rec-edit-id').value = '';
  document.getElementById('rec-max-days').value = '7';
  document.getElementById('recurring-form-heading').textContent = 'CREATE RECURRING GOAL';
  document.getElementById('rec-submit-btn').textContent = 'Save Recurring Goal';
  document.getElementById('rec-spawn-now-row').classList.remove('hidden');
  document.getElementById('btn-recurring-form-reset').classList.add('hidden');
}

function loadRuleIntoRecurringForm(rule) {
  document.getElementById('rec-edit-id').value = rule.id;
  document.getElementById('rec-title').value = rule.title || '';
  const freq = rule.schedule ? rule.schedule.frequency : 'daily';
  document.getElementById('rec-frequency').value = freq;
  document.getElementById('rec-max-days').value = rule.maxDays || 7;
  document.getElementById('rec-quadrant').value = rule.quadrant || 'tl';
  document.getElementById('rec-notes').value = rule.notes || '';
  document.getElementById('recurring-form-heading').textContent = 'EDIT RECURRING GOAL';
  document.getElementById('rec-submit-btn').textContent = 'Update Recurring Goal';
  document.getElementById('rec-spawn-now-row').classList.add('hidden');
  document.getElementById('btn-recurring-form-reset').classList.remove('hidden');
  document.getElementById('rec-title').focus();
}

function renderRecurringModal() {
  const listEl = document.getElementById('recurring-rules-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  const totalPill = document.getElementById('recurring-total-pill');
  if (totalPill) totalPill.textContent = state.recurringTasks.length;

  if (state.recurringTasks.length === 0) {
    listEl.innerHTML = `
      <div class="block-sub">
        No recurring goals configured yet. Create a Daily, Weekly, Monthly, or Yearly goal on the right (or when adding a task).
      </div>
    `;
    return;
  }

  const quadNames = {
    tl: 'I: Urgent & Important',
    tr: 'II: Important / Not Urgent',
    bl: 'III: Urgent / Not Important',
    br: 'IV: Low Priority'
  };

  const effectiveNow = getEffectiveNow();

  for (const rule of state.recurringTasks) {
    const card = document.createElement('div');
    const isEnabled = rule.enabled !== false;
    card.className = `recurring-rule-card ${isEnabled ? '' : 'paused'}`;

    const freqLabel = formatFrequencyLabel(rule.schedule);
    const activeOnMatrix = state.tasks.some(t => !t.completed && t.recurringId === rule.id);
    const daysUntilDue = rule.nextDueAt ? Math.max(0, (rule.nextDueAt - effectiveNow) / 86400000) : 0;
    const dueStr = isEnabled
      ? `Next spawn in ${daysUntilDue.toFixed(1)}d`
      : 'Paused';

    card.innerHTML = `
      <div class="recurring-rule-top">
        <span class="recurring-rule-title">${escapeHtml(rule.title)}</span>
        <span class="recurring-freq-pill">&#x21bb; ${escapeHtml(freqLabel)}</span>
      </div>
      <div class="recurring-rule-meta">
        ${escapeHtml(quadNames[rule.quadrant] || 'Quadrant I')} &bull; Cycle: ${rule.maxDays || 7}d &bull; ${dueStr}
        ${activeOnMatrix ? ' &bull; <strong>Active on Matrix</strong>' : ''}
      </div>
      <div class="recurring-rule-actions">
        <button type="button" class="btn-mini act-spawn" title="Spawn a task instance on the Priority Matrix right now">+ Spawn Now</button>
        <button type="button" class="btn-mini act-toggle">${isEnabled ? 'Pause' : 'Resume'}</button>
        <button type="button" class="btn-mini act-edit">Edit</button>
        <button type="button" class="btn-mini btn-danger act-delete">Delete</button>
      </div>
    `;

    card.querySelector('.act-spawn').addEventListener('click', () => {
      spawnTaskFromRecurringRule(rule);
      saveState(true);
      renderRecurringModal();
      renderAll();
    });

    card.querySelector('.act-toggle').addEventListener('click', () => {
      rule.enabled = !isEnabled;
      if (rule.enabled && (!rule.nextDueAt || rule.nextDueAt < effectiveNow)) {
        rule.nextDueAt = computeNextOccurrence(rule.schedule, effectiveNow);
      }
      saveState(true);
      renderRecurringModal();
      renderAll();
    });

    card.querySelector('.act-edit').addEventListener('click', () => {
      loadRuleIntoRecurringForm(rule);
    });

    card.querySelector('.act-delete').addEventListener('click', () => {
      state.recurringTasks = state.recurringTasks.filter(r => r.id !== rule.id);
      for (const t of state.tasks) {
        if (t.recurringId === rule.id) {
          delete t.recurringId;
          delete t.recurrenceFrequency;
        }
      }
      saveState(true);
      renderRecurringModal();
      renderAll();
    });

    listEl.appendChild(card);
  }
}

function markTaskComplete(task) {
  task.completed = true;
  task.completedAt = Date.now();
  task.frozenAgeDays = getTaskAgeDays(task);
  task.inJar = false;
  saveState(true);
}

function renderMatrix() {
  const container = document.getElementById('matrix-nodes');
  container.innerHTML = '';

  document.getElementById('sim-days-label').textContent =
    `Age Offset: +${state.timeOffsetDays.toFixed(1)}d`;

  const recBadge = document.getElementById('recurring-count-badge');
  if (recBadge) {
    recBadge.textContent = state.recurringTasks.filter(r => r.enabled !== false).length;
  }

  const activeTasks = state.tasks.filter(t => !t.completed);

  for (const task of activeTasks) {
    const node = document.createElement('div');
    node.className = 'task-node';
    node.dataset.id = task.id;

    const color = getTaskColor(task);
    const scale = getCenterScale(task.x, task.y);
    const ageDays = getTaskAgeDays(task);
    const recFreq = task.recurrenceFrequency;

    node.style.left = `${(task.x * 100).toFixed(2)}%`;
    node.style.top = `${(task.y * 100).toFixed(2)}%`;
    node.style.backgroundColor = color.bg;
    node.style.color = color.text;
    node.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`;

    node.innerHTML = `
      ${recFreq ? `<span class="task-node-rec" title="Recurring: ${escapeHtml(recFreq)}">&#x21bb; ${escapeHtml(recFreq.slice(0, 1).toUpperCase())}</span>` : ''}
      <span class="task-node-title">${escapeHtml(task.title)}</span>
      <span class="task-node-age">${ageDays.toFixed(1)}d</span>
    `;

    bindNodeDragAndClick(node, task);
    container.appendChild(node);
  }

  updateDockBadges();
}

function bindNodeDragAndClick(node, task) {
  let startX = 0, startY = 0;
  let moved = false;

  node.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    node.setPointerCapture(e.pointerId);
    startX = e.clientX;
    startY = e.clientY;
    moved = false;
    node.classList.add('dragging');
  });

  node.addEventListener('pointermove', (e) => {
    if (!node.hasPointerCapture(e.pointerId)) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.hypot(dx, dy) > 4) moved = true;

    if (moved) {
      closePopover();
      const arena = document.getElementById('matrix-arena').getBoundingClientRect();
      const nx = Math.min(0.94, Math.max(0.06, (e.clientX - arena.left) / arena.width));
      const ny = Math.min(0.88, Math.max(0.08, (e.clientY - arena.top) / arena.height));
      task.x = nx;
      task.y = ny;

      const scale = getCenterScale(nx, ny);
      node.style.left = `${(nx * 100).toFixed(2)}%`;
      node.style.top = `${(ny * 100).toFixed(2)}%`;
      node.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`;
    }
  });

  node.addEventListener('pointerup', (e) => {
    if (!node.hasPointerCapture(e.pointerId)) return;
    node.releasePointerCapture(e.pointerId);
    node.classList.remove('dragging');
    if (moved) {
      saveState();
    } else {
      openTaskPopover(task, node);
    }
  });
}

function openTaskPopover(task, nodeEl) {
  selectedMatrixTaskId = task.id;
  const pop = document.getElementById('task-popover');
  document.getElementById('pop-title').value = task.title;
  document.getElementById('pop-notes').value = task.notes || '';
  document.getElementById('pop-recurrence').value = task.recurrenceFrequency || 'none';
  const age = getTaskAgeDays(task).toFixed(1);
  const mins = Math.floor((task.timeSpent || 0) / 60);
  document.getElementById('pop-meta').textContent = `Age: ${age}d / ${task.maxDays || 7}d • Focused: ${mins}m`;

  pop.classList.remove('hidden');
  const arena = document.getElementById('matrix-arena').getBoundingClientRect();
  const rect = nodeEl.getBoundingClientRect();
  let left = rect.left - arena.left + rect.width / 2 - 155;
  let top = rect.bottom - arena.top + 12;

  left = Math.max(16, Math.min(arena.width - 326, left));
  if (top + 280 > arena.height - 70) {
    top = Math.max(16, rect.top - arena.top - 270);
  }

  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function closePopover() {
  selectedMatrixTaskId = null;
  document.getElementById('task-popover').classList.add('hidden');
}

// ==================== SECTION 2: MARBLE JAR ====================
function bindJarSection() {
  const memoryInput = document.getElementById('marble-memory-input');
  const notesInput = document.getElementById('marble-notes-input');

  memoryInput.addEventListener('input', () => {
    const t = state.tasks.find(x => x.id === selectedMarbleTaskId);
    if (t) {
      t.memory = memoryInput.value;
      saveState();
    }
  });

  notesInput.addEventListener('input', () => {
    const t = state.tasks.find(x => x.id === selectedMarbleTaskId);
    if (t) {
      t.notes = notesInput.value;
      saveState();
    }
  });

  document.getElementById('btn-drop-marble').addEventListener('click', () => {
    const t = state.tasks.find(x => x.id === selectedMarbleTaskId);
    if (!t) return;
    if (!t.inJar) {
      dropMarbleIntoJar(t);
    } else {
      // Pull marble back out of jar to ready tray (shrinks jar!)
      t.inJar = false;
      marblesPhysics.delete(t.id);
      saveState(true);
      renderJarSidebar();
    }
  });

  document.getElementById('btn-return-matrix').addEventListener('click', () => {
    const t = state.tasks.find(x => x.id === selectedMarbleTaskId);
    if (!t) return;
    t.completed = false;
    t.inJar = false;
    marblesPhysics.delete(t.id);
    selectedMarbleTaskId = null;
    saveState(true);
    renderAll();
  });

  // HTML5 Drag & Drop over Jar Canvas
  const dropzone = document.getElementById('jar-dropzone');
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    const taskId = e.dataTransfer.getData('text/plain');
    const t = state.tasks.find(x => x.id === taskId);
    if (t && t.completed && !t.inJar) {
      const canvas = document.getElementById('jar-canvas');
      const rect = canvas.getBoundingClientRect();
      const dropX = e.clientX - rect.left;
      dropMarbleIntoJar(t, dropX);
    }
  });

  // Canvas Mouse Hover Tooltip & Click to Select
  const canvas = document.getElementById('jar-canvas');
  const tooltip = document.getElementById('marble-tooltip');

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    let hitId = null;
    for (const [id, body] of marblesPhysics.entries()) {
      if (Math.hypot(mx - body.x, my - body.y) <= body.r + 2) {
        hitId = id;
        break;
      }
    }

    hoveredMarbleId = hitId;
    if (hitId) {
      const task = state.tasks.find(t => t.id === hitId);
      if (task) {
        canvas.style.cursor = 'pointer';
        const dateStr = task.completedAt
          ? new Date(task.completedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
          : 'Completed';
        const mem = task.memory ? escapeHtml(task.memory) : '<em>No memory recorded yet. Click marble to write thoughts.</em>';
        const mins = Math.floor((task.timeSpent || 0) / 60);
        tooltip.innerHTML = `
          <div class="tt-title">${escapeHtml(task.title)}</div>
          <div class="tt-date">Completed ${dateStr} &bull; Focused ${mins}m</div>
          <div class="tt-memory">${mem}</div>
        `;
        tooltip.classList.remove('hidden');
        const tx = Math.min(rect.width - 290, Math.max(12, mx + 16));
        const ty = Math.max(12, my - 30);
        tooltip.style.left = `${tx}px`;
        tooltip.style.top = `${ty}px`;
        return;
      }
    }

    canvas.style.cursor = 'default';
    tooltip.classList.add('hidden');
  });

  canvas.addEventListener('mouseleave', () => {
    hoveredMarbleId = null;
    tooltip.classList.add('hidden');
  });

  canvas.addEventListener('click', () => {
    if (hoveredMarbleId) {
      selectedMarbleTaskId = hoveredMarbleId;
      renderJarSidebar();
    }
  });
}

function dropMarbleIntoJar(task, customX = null) {
  task.inJar = true;
  selectedMarbleTaskId = task.id;
  const spawnX = customX !== null
    ? Math.max(jarDimensions.cx - jarDimensions.width * 0.25, Math.min(jarDimensions.cx + jarDimensions.width * 0.25, customX))
    : jarDimensions.cx + (Math.random() - 0.5) * 30;

  marblesPhysics.set(task.id, {
    x: spawnX,
    y: jarDimensions.topY - 24,
    vx: (Math.random() - 0.5) * 2.2,
    vy: 1.5,
    r: 22
  });

  saveState(true);
  renderJarSidebar();
  updateDockBadges();
}

function renderJarSidebar() {
  const readyList = document.getElementById('ready-marbles-list');
  const jarredList = document.getElementById('jarred-marbles-list');
  readyList.innerHTML = '';
  jarredList.innerHTML = '';

  const readyTasks = state.tasks.filter(t => t.completed && !t.inJar);
  const jarredTasks = state.tasks.filter(t => t.completed && t.inJar);

  document.getElementById('ready-count').textContent = readyTasks.length;
  document.getElementById('archive-count').textContent = jarredTasks.length;
  document.getElementById('jar-count-label').textContent =
    `${jarredTasks.length} MARBLE${jarredTasks.length === 1 ? '' : 'S'} IN JAR`;

  // Auto-select first ready task if none selected
  if (!selectedMarbleTaskId && (readyTasks.length || jarredTasks.length)) {
    selectedMarbleTaskId = (readyTasks[0] || jarredTasks[0]).id;
  }

  const createMarbleRow = (task, draggable) => {
    const item = document.createElement('div');
    item.className = `marble-item ${task.id === selectedMarbleTaskId ? 'selected' : ''}`;
    if (draggable) {
      item.draggable = true;
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', task.id);
      });
    }
    const color = getTaskColor(task);
    const dateStr = task.completedAt ? new Date(task.completedAt).toLocaleDateString() : '';

    item.innerHTML = `
      <span class="marble-dot" style="background:${color.bg}"></span>
      <div class="marble-item-info">
        <div class="marble-item-title">${escapeHtml(task.title)}</div>
        <div class="marble-item-sub">${dateStr} ${task.memory ? '• Memory saved' : ''}</div>
      </div>
    `;
    item.addEventListener('click', () => {
      selectedMarbleTaskId = task.id;
      renderJarSidebar();
    });
    return item;
  };

  if (readyTasks.length === 0) {
    readyList.innerHTML = `<div class="block-sub">No newly completed tasks waiting. Complete a task in the Priority Matrix to turn it into a marble.</div>`;
  } else {
    readyTasks.forEach(t => readyList.appendChild(createMarbleRow(t, true)));
  }

  jarredTasks.forEach(t => jarredList.appendChild(createMarbleRow(t, false)));

  // Populate Editor Panel
  const editor = document.getElementById('marble-editor');
  const activeTask = state.tasks.find(t => t.id === selectedMarbleTaskId && t.completed);
  if (activeTask) {
    editor.classList.remove('hidden');
    const color = getTaskColor(activeTask);
    document.getElementById('marble-editor-dot').style.background = color.bg;
    document.getElementById('marble-editor-title').textContent = activeTask.title;
    const dStr = activeTask.completedAt ? new Date(activeTask.completedAt).toLocaleString() : 'Recently';
    document.getElementById('marble-editor-date').textContent = `Completed: ${dStr}`;
    document.getElementById('marble-memory-input').value = activeTask.memory || '';
    document.getElementById('marble-notes-input').value = activeTask.notes || '';

    const dropBtn = document.getElementById('btn-drop-marble');
    dropBtn.textContent = activeTask.inJar ? 'Remove from Jar ↑' : 'Drop into Jar ↓';
  } else {
    editor.classList.add('hidden');
  }
}

// 2D Physics & Dynamic Scaling Jar Renderer
function stepJarPhysics() {
  const canvas = document.getElementById('jar-canvas');
  if (canvas && activeSection === 'section-jar') {
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== rect.width || canvas.height !== rect.height) {
      canvas.width = rect.width;
      canvas.height = rect.height;
    }

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const jarredTasks = state.tasks.filter(t => t.completed && t.inJar);
    const count = jarredTasks.length;

    // Dynamic Jar Sizing: Grows or shrinks smoothly to accommodate marbles!
    const targetW = Math.min(canvas.width * 0.72, 160 + Math.sqrt(count) * 44);
    const targetH = Math.min(canvas.height * 0.72, 190 + Math.sqrt(count) * 48);

    jarDimensions.width += (targetW - jarDimensions.width) * 0.12;
    jarDimensions.height += (targetH - jarDimensions.height) * 0.12;
    jarDimensions.cx = canvas.width / 2;
    jarDimensions.cy = canvas.height / 2 + 10;
    jarDimensions.topY = jarDimensions.cy - jarDimensions.height / 2;
    jarDimensions.bottomY = jarDimensions.cy + jarDimensions.height / 2;

    const leftWall = jarDimensions.cx - jarDimensions.width / 2;
    const rightWall = jarDimensions.cx + jarDimensions.width / 2;
    const floorY = jarDimensions.bottomY;

    // Ensure physics bodies exist for all jarred tasks
    for (const t of jarredTasks) {
      if (!marblesPhysics.has(t.id)) {
        marblesPhysics.set(t.id, {
          x: jarDimensions.cx + (Math.random() - 0.5) * (jarDimensions.width * 0.5),
          y: floorY - 30 - Math.random() * (jarDimensions.height * 0.5),
          vx: 0,
          vy: 0,
          r: 22
        });
      }
    }

    const bodies = jarredTasks.map(t => ({ task: t, body: marblesPhysics.get(t.id) }));

    // Physics Step (Gravity + Wall Constraints + Circle Collisions)
    for (const { body } of bodies) {
      body.vy += 0.38; // Gravity
      body.vx *= 0.985;
      body.vy *= 0.985;
      body.x += body.vx;
      body.y += body.vy;

      // Floor collision
      if (body.y + body.r > floorY - 6) {
        body.y = floorY - 6 - body.r;
        body.vy = -body.vy * 0.42;
        body.vx *= 0.9;
      }
      // Left & Right Jar Walls
      if (body.x - body.r < leftWall + 6) {
        body.x = leftWall + 6 + body.r;
        body.vx = -body.vx * 0.5;
      }
      if (body.x + body.r > rightWall - 6) {
        body.x = rightWall - 6 - body.r;
        body.vx = -body.vx * 0.5;
      }
    }

    // Circle-to-Circle Collisions (3 relaxation iterations for stable stacking)
    for (let iter = 0; iter < 3; iter++) {
      for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
          const a = bodies[i].body;
          const b = bodies[j].body;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.hypot(dx, dy) || 0.01;
          const minDist = a.r + b.r + 1.5;
          if (dist < minDist) {
            const overlap = (minDist - dist) * 0.5;
            const nx = dx / dist;
            const ny = dy / dist;
            a.x -= nx * overlap;
            a.y -= ny * overlap;
            b.x += nx * overlap;
            b.y += ny * overlap;

            const rvx = b.vx - a.vx;
            const rvy = b.vy - a.vy;
            const velAlongNormal = rvx * nx + rvy * ny;
            if (velAlongNormal < 0) {
              const impulse = -(1 + 0.35) * velAlongNormal * 0.5;
              a.vx -= impulse * nx;
              a.vy -= impulse * ny;
              b.vx += impulse * nx;
              b.vy += impulse * ny;
            }
          }
        }
      }
    }

    // Draw Minimalist Glass Jar Outline
    const isLight = document.documentElement.dataset.theme === 'light';
    const neckInset = jarDimensions.width * 0.16;
    const lipY = jarDimensions.topY - 18;

    ctx.save();
    ctx.strokeStyle = isLight ? '#141413' : '#f5f5f5';
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    // Top-left rim -> neck -> shoulder -> left wall -> rounded bottom -> right wall -> shoulder -> rim
    ctx.moveTo(leftWall + neckInset - 8, lipY);
    ctx.lineTo(leftWall + neckInset, lipY);
    ctx.lineTo(leftWall + neckInset, jarDimensions.topY);
    ctx.lineTo(leftWall, jarDimensions.topY + 24);
    ctx.lineTo(leftWall, floorY - 22);
    ctx.quadraticCurveTo(leftWall, floorY, leftWall + 22, floorY);
    ctx.lineTo(rightWall - 22, floorY);
    ctx.quadraticCurveTo(rightWall, floorY, rightWall, floorY - 22);
    ctx.lineTo(rightWall, jarDimensions.topY + 24);
    ctx.lineTo(rightWall - neckInset, jarDimensions.topY);
    ctx.lineTo(rightWall - neckInset, lipY);
    ctx.lineTo(rightWall - neckInset + 8, lipY);
    ctx.stroke();

    // Subtle Jar Rim ellipse
    ctx.strokeStyle = isLight ? 'rgba(20,20,19,0.28)' : 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(leftWall + neckInset, lipY);
    ctx.lineTo(rightWall - neckInset, lipY);
    ctx.stroke();
    ctx.restore();

    // Draw Marbles inside Jar
    for (const { task, body } of bodies) {
      const color = getTaskColor(task);
      const isHovered = task.id === hoveredMarbleId;
      const isSelected = task.id === selectedMarbleTaskId;

      ctx.save();
      ctx.beginPath();
      ctx.arc(body.x, body.y, body.r, 0, Math.PI * 2);
      ctx.fillStyle = color.bg;
      ctx.fill();

      ctx.lineWidth = isHovered || isSelected ? 2.5 : 1.2;
      if (isLight) {
        ctx.strokeStyle = isHovered || isSelected ? '#141413' : 'rgba(20,20,19,0.45)';
      } else {
        ctx.strokeStyle = isHovered || isSelected ? '#ffffff' : 'rgba(255,255,255,0.75)';
      }
      ctx.stroke();

      // Minimalist specular marble shine
      ctx.beginPath();
      ctx.arc(body.x - body.r * 0.32, body.y - body.r * 0.32, body.r * 0.22, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.fill();
      ctx.restore();
    }
  }

  requestAnimationFrame(stepJarPhysics);
}

// ==================== SECTION 3: FOCUS TIMER & NOTES ====================
function initTimerWorker() {
  if (timerWorker) return timerWorker;
  try {
    const workerCode = `
      let id = null;
      self.onmessage = function(e) {
        if (e.data === 'start') {
          clearInterval(id);
          id = setInterval(() => self.postMessage('tick'), 250);
        } else if (e.data === 'stop') {
          clearInterval(id);
          id = null;
        }
      };
    `;
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    timerWorker = new Worker(URL.createObjectURL(blob));
    timerWorker.onmessage = () => {
      if (timerRunning) tickTimer();
    };
  } catch (err) {
    timerWorker = null;
  }
  return timerWorker;
}

function bindFocusSection() {
  initTimerWorker();

  // Ensure wall-clock catch-up immediately if window regains focus or visibility
  document.addEventListener('visibilitychange', () => {
    if (timerRunning) tickTimer();
  });
  window.addEventListener('focus', () => {
    if (timerRunning) tickTimer();
  });

  const select = document.getElementById('focus-task-select');
  const notesArea = document.getElementById('focus-notes-area');

  select.addEventListener('change', () => {
    selectedFocusTaskId = select.value;
    renderFocusSection();
  });

  notesArea.addEventListener('input', () => {
    const task = state.tasks.find(t => t.id === selectedFocusTaskId);
    if (task) {
      task.notes = notesArea.value;
      saveState();
    }
  });

  // Preset duration buttons
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (timerRunning) toggleTimer(false);
      document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      timerModeMinutes = Number(btn.dataset.minutes);
      timerRemainingSec = timerModeMinutes * 60;
      timerSessionElapsedSec = 0;
      updateTimerDisplay();
    });
  });

  document.getElementById('btn-timer-toggle').addEventListener('click', () => {
    toggleTimer(!timerRunning);
  });

  document.getElementById('btn-timer-reset').addEventListener('click', () => {
    toggleTimer(false);
    timerRemainingSec = timerModeMinutes * 60;
    timerSessionElapsedSec = 0;
    updateTimerDisplay();
    saveState(true);
  });

  document.getElementById('btn-focus-complete').addEventListener('click', () => {
    const task = state.tasks.find(t => t.id === selectedFocusTaskId);
    if (!task) return;
    if (timerRunning) toggleTimer(false);
    markTaskComplete(task);
    selectedMarbleTaskId = task.id;
    switchSection('section-jar');
  });
}

function requestNotificationPermissionIfNeeded() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

function syncElectronTimerStatus() {
  const totalSec = timerModeMinutes * 60;
  const progress = timerModeMinutes > 0 && totalSec > 0
    ? (totalSec - timerRemainingSec) / totalSec
    : -1;
  fetch('/api/timer-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      running: timerRunning,
      progress
    })
  }).catch(() => {});
}

function tickTimer() {
  if (!timerRunning || !timerLastTickAt) return;

  const now = Date.now();
  const deltaSec = Math.floor((now - timerLastTickAt) / 1000);
  if (deltaSec < 1) return;

  timerLastTickAt += deltaSec * 1000;

  const effectiveSec = timerModeMinutes > 0
    ? Math.min(deltaSec, timerRemainingSec)
    : deltaSec;

  timerSessionElapsedSec += effectiveSec;
  timerUnsavedSec += effectiveSec;

  if (timerModeMinutes > 0) {
    timerRemainingSec = Math.max(0, timerRemainingSec - effectiveSec);
  }

  // Accumulate elapsed real-world time directly onto the selected task
  const task = state.tasks.find(t => t.id === selectedFocusTaskId);
  if (task && effectiveSec > 0) {
    task.timeSpent = (task.timeSpent || 0) + effectiveSec;
    document.getElementById('focus-total-time').textContent = formatDuration(task.timeSpent);
    if (timerUnsavedSec >= 5) {
      timerUnsavedSec = 0;
      saveState();
    }
  }

  updateTimerDisplay();
  syncElectronTimerStatus();

  if (timerModeMinutes > 0 && timerRemainingSec === 0) {
    const completedMinutes = timerModeMinutes;
    toggleTimer(false);
    saveState(true);
    notifyTimerEnded(task, completedMinutes);
  }
}

function toggleTimer(run) {
  timerRunning = run;
  const btn = document.getElementById('btn-timer-toggle');
  const liveDot = document.getElementById('dock-timer-dot');

  if (timerRunning) {
    requestNotificationPermissionIfNeeded();

    if (timerModeMinutes > 0 && timerRemainingSec === 0) {
      timerRemainingSec = timerModeMinutes * 60;
      timerSessionElapsedSec = 0;
    }

    if (!selectedFocusTaskId && state.tasks.length > 0) {
      selectedFocusTaskId = (state.tasks.find(t => !t.completed) || state.tasks[0]).id;
      renderFocusSection();
    }

    timerLastTickAt = Date.now();
    timerUnsavedSec = 0;
    btn.textContent = 'PAUSE FOCUS';
    liveDot.classList.remove('hidden');

    if (timerWorker) timerWorker.postMessage('start');
    clearInterval(timerInterval);
    timerInterval = setInterval(tickTimer, 500);
    updateTimerDisplay();
    syncElectronTimerStatus();
  } else {
    btn.textContent = 'START FOCUS';
    liveDot.classList.add('hidden');
    timerLastTickAt = null;
    if (timerWorker) timerWorker.postMessage('stop');
    clearInterval(timerInterval);
    updateTimerDisplay();
    syncElectronTimerStatus();
    saveState(true);
  }
}

function updateTimerDisplay() {
  const displaySec = timerModeMinutes > 0 ? timerRemainingSec : timerSessionElapsedSec;
  const m = Math.floor(displaySec / 60);
  const s = displaySec % 60;
  const formatted = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  document.getElementById('timer-readout').textContent = formatted;

  const em = Math.floor(timerSessionElapsedSec / 60);
  const es = timerSessionElapsedSec % 60;
  document.getElementById('timer-session-sub').textContent =
    `Session elapsed: ${em}m ${String(es).padStart(2, '0')}s`;

  if (timerRunning) {
    const task = state.tasks.find(t => t.id === selectedFocusTaskId);
    const taskLabel = task ? task.title : 'Focus';
    document.title = `[${formatted}] ${taskLabel} — CONDUCTIVITY`;
  } else {
    document.title = 'CONDUCTIVITY';
  }
}

function playTimerChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.14);

      gain.gain.setValueAtTime(0.0001, ctx.currentTime + idx * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + idx * 0.14 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + idx * 0.14 + 0.45);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + idx * 0.14);
      osc.stop(ctx.currentTime + idx * 0.14 + 0.48);
    });
    setTimeout(() => ctx.close().catch(() => {}), 1500);
  } catch (e) {}
}

function showInAppTimerToast(task, durationMinutes) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'timer-toast';
  const taskTitle = task ? task.title : 'Focus Session';
  const canComplete = task && !task.completed;

  toast.innerHTML = `
    <div class="timer-toast-header">
      <span class="timer-toast-badge">
        <span class="timer-toast-dot"></span>
        FOCUS TIMER COMPLETE
      </span>
      <button class="btn-icon toast-close" title="Dismiss">&times;</button>
    </div>
    <div class="timer-toast-body">
      Finished <strong>${durationMinutes}m</strong> focus session on <strong>${escapeHtml(taskTitle)}</strong>.
    </div>
    <div class="timer-toast-sub">
      Total time on task: ${task ? formatDuration(task.timeSpent) : formatDuration(durationMinutes * 60)}
    </div>
    <div class="timer-toast-actions">
      ${canComplete ? '<button class="btn-primary btn-mini toast-complete">Complete &rarr; Marble</button>' : ''}
      <button class="btn-secondary btn-mini toast-view">View Timer</button>
    </div>
  `;

  const dismiss = () => {
    toast.remove();
  };

  toast.querySelector('.toast-close').addEventListener('click', dismiss);
  toast.querySelector('.toast-view').addEventListener('click', () => {
    switchSection('section-focus');
    dismiss();
  });

  const completeBtn = toast.querySelector('.toast-complete');
  if (completeBtn && task) {
    completeBtn.addEventListener('click', () => {
      markTaskComplete(task);
      selectedMarbleTaskId = task.id;
      switchSection('section-jar');
      dismiss();
    });
  }

  container.appendChild(toast);
  setTimeout(() => {
    if (toast.parentNode) toast.remove();
  }, 15000);
}

async function notifyTimerEnded(task, durationMinutes) {
  const title = 'Focus Timer Complete';
  const body = task
    ? `Finished ${durationMinutes}m focus session on "${task.title}".`
    : `Your ${durationMinutes}m focus session has finished.`;

  playTimerChime();
  showInAppTimerToast(task, durationMinutes);

  // Trigger native desktop OS notification via Electron backend first
  let handledByNative = false;
  try {
    const res = await fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        body,
        taskId: task ? task.id : null,
        durationMinutes
      })
    });
    if (res.ok) {
      const data = await res.json();
      handledByNative = Boolean(data.native);
    }
  } catch (e) {}

  // Fallback to Web Notification API when running in standalone browser mode
  if (!handledByNative && 'Notification' in window) {
    if (Notification.permission === 'granted') {
      try {
        const n = new Notification(title, { body });
        n.onclick = () => {
          window.focus();
          switchSection('section-focus');
        };
      } catch (e) {}
    }
  }
}

function renderFocusSection() {
  const select = document.getElementById('focus-task-select');
  select.innerHTML = '';

  if (state.tasks.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No tasks yet — create one in Priority Matrix';
    select.appendChild(opt);
    document.getElementById('focus-total-time').textContent = '00h 00m 00s';
    document.getElementById('focus-task-status').textContent = '—';
    document.getElementById('focus-notes-area').value = '';
    document.getElementById('focus-notes-area').disabled = true;
    return;
  }

  document.getElementById('focus-notes-area').disabled = false;

  if (!selectedFocusTaskId || !state.tasks.some(t => t.id === selectedFocusTaskId)) {
    const firstActive = state.tasks.find(t => !t.completed) || state.tasks[0];
    selectedFocusTaskId = firstActive.id;
  }

  for (const t of state.tasks) {
    const opt = document.createElement('option');
    opt.value = t.id;
    const statusTag = t.completed ? (t.inJar ? '[Marble in Jar]' : '[Completed]') : '[Active]';
    opt.textContent = `${t.title} ${statusTag}`;
    if (t.id === selectedFocusTaskId) opt.selected = true;
    select.appendChild(opt);
  }

  const activeTask = state.tasks.find(t => t.id === selectedFocusTaskId);
  if (activeTask) {
    document.getElementById('focus-total-time').textContent = formatDuration(activeTask.timeSpent);
    document.getElementById('focus-task-status').textContent =
      activeTask.completed ? (activeTask.inJar ? 'In Marble Jar' : 'Completed') : `Active (${getTaskAgeDays(activeTask).toFixed(1)}d old)`;
    document.getElementById('focus-notes-title').textContent = `NOTES: ${activeTask.title.toUpperCase()}`;
    document.getElementById('focus-notes-area').value = activeTask.notes || '';
    document.getElementById('btn-focus-complete').style.display = activeTask.completed ? 'none' : 'inline-block';
  }

  updateTimerDisplay();
}

// ==================== SHARED RENDERING ====================
function updateDockBadges() {
  const readyCount = state.tasks.filter(t => t.completed && !t.inJar).length;
  const badge = document.getElementById('dock-jar-badge');
  if (readyCount > 0) {
    badge.textContent = readyCount;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  const stickyCount = state.stickyNotes.length;
  const stickyBadge = document.getElementById('dock-stickies-badge');
  if (stickyBadge) {
    if (stickyCount > 0) {
      stickyBadge.textContent = stickyCount;
      stickyBadge.classList.remove('hidden');
    } else {
      stickyBadge.classList.add('hidden');
    }
  }
}

function renderAll() {
  renderStickies();
  renderMatrix();
  renderJarSidebar();
  renderFocusSection();
  updateDockBadges();
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

window.addEventListener('DOMContentLoaded', init);

