const { app, BrowserWindow, Menu, ipcMain, globalShortcut, shell, dialog } = require("electron");
const path = require("path");
const fs   = require("fs");
const { generateSubmissionPdf } = require("./generate-submission-pdf");
const { autoUpdater } = require("electron-updater");

// Paths: appRoot for reading bundled files (Monaco etc); userData for writable (Exam, .run, log, exam_env)
// In packaged app, __dirname is inside asar (read-only) — writable data MUST use userData
let sessionDir = null;
let sessionId = null;

// app updater
autoUpdater.autoDownload = false;

app.whenReady().then(() => {
  autoUpdater.checkForUpdates();
});

autoUpdater.on('checking-for-update', () => {
  console.log('Checking for update...');
});

autoUpdater.on('update-available', () => {
  console.log('Update available!');
});

autoUpdater.on('update-not-available', () => {
  console.log('No update available');
});

autoUpdater.on('error', (err) => {
  console.log('Error:', err);
});

autoUpdater.on("update-available", () => {
  dialog.showMessageBox({
    type: "info",
    title: "Update Available",
    message: "A new version is available. Do you want to update?",
    buttons: ["Yes", "No"]
  }).then(result => {
    if (result.response === 0) {
      autoUpdater.downloadUpdate();
    }
  });
});

autoUpdater.on("download-progress", (progress) => {
  console.log(`Downloading: ${progress.percent}%`);
});

autoUpdater.on("update-downloaded", () => {
  dialog.showMessageBox({
    title: "Update Ready",
    message: "Update downloaded. Restart now?",
    buttons: ["Restart", "Later"]
  }).then(result => {
    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });
});

function cleanupOldSessions(userDataPath) {
  try {
    fs.readdirSync(userDataPath).forEach(folder => {
      if (folder && folder.startsWith(".session_")) {
        try {
          fs.rmSync(path.join(userDataPath, folder), { recursive: true, force: true });
        } catch {}
      }
    });
  } catch {}
}

function ensureSessionDir() {
  if (sessionDir) return sessionDir;
  const userDataPath = app.getPath("userData");
  sessionId = Date.now().toString();
  sessionDir = path.join(userDataPath, ".session_" + sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

function cleanupSessionDir() {
  if (!sessionDir) return;
  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  } catch {}
  sessionDir = null;
}

ipcMain.handle("get-app-paths", () => ({
  appRoot: app.getAppPath ? app.getAppPath() : __dirname,
  userDataPath: app.getPath("userData"),
  sessionDir: ensureSessionDir(),
}));

// ── IPC: generate-submission-pdf ─────────────────────────────────────────────
// Renderer sends: { examDir: <absolute path to Exam folder> }
// Main responds:  { success, pdfPath? } | { success: false, error }
// All heavy work (fs reads, PDFKit) runs here in the main process.
// ─────────────────────────────────────────────────────────────────────────────
ipcMain.handle("generate-submission-pdf", async (_event, { examDir, studentName, enrollNo, pdfFilename }) => {
  try {
    const result = await generateSubmissionPdf({ examDir, app, studentName, enrollNo, pdfFilename });
    // If PDF was saved successfully, open Google Classroom now.
    // Doing it here keeps the renderer handler simple.
    if (result.success) {
      shell.openExternal("https://classroom.google.com/");
    }
    return result;
  } catch (err) {
    return { success: false, error: err && err.message ? err.message : String(err) };
  }
});

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

let allowQuit = false;

function createWindow() {
  const win = new BrowserWindow({
    fullscreen: true,
    kiosk: true,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      devTools: true
    }
  });

  Menu.setApplicationMenu(null);
  win.setMenuBarVisibility(false);
  win.setKiosk(true);

  // ── Block at main-process level (before-input-event) ──────────────────────
  win.webContents.on("before-input-event", (event, input) => {
    const key = (input.key || "").toLowerCase();
    const ctrl = input.control || input.meta;
    const alt  = input.alt;
    const shift = input.shift;

    // Alt+F4
    if (alt && key === "f4")          { event.preventDefault(); return; }
    // Alt+Tab / Alt+Shift+Tab
    if (alt && key === "tab")         { event.preventDefault(); return; }
    // Ctrl+W, Ctrl+Tab, Ctrl+Shift+Tab
    if (ctrl && key === "w")          { event.preventDefault(); return; }
    if (ctrl && key === "tab")        { event.preventDefault(); return; }
    // Ctrl+Esc (Start menu)
    if (ctrl && key === "escape")     { event.preventDefault(); return; }
    // Ctrl+Alt+Del — partially catchable
    if (ctrl && alt && key === "delete") { event.preventDefault(); return; }
    // F5 reload, Ctrl+R
    if (key === "f5")                 { event.preventDefault(); return; }
    if (ctrl && key === "r")          { event.preventDefault(); return; }
    // Ctrl+T, Ctrl+N (new tab/window)
    if (ctrl && key === "t")          { event.preventDefault(); return; }
    if (ctrl && key === "n")          { event.preventDefault(); return; }
    // PrintScreen
    if (key === "printscreen")        { event.preventDefault(); return; }
    // Super/Meta/Windows key
    if (key === "meta" || key === "super" || key === "os") {
      event.preventDefault(); return;
    }
  });

  // ── Block at OS level via globalShortcut ──────────────────────────────────
  // These fire even when the window is focused and catch what before-input-event misses
  const blocked = [
    "Alt+F4",
    "Alt+Tab",
    "Alt+Shift+Tab",
    "Super+D",          // Win+D  show desktop
    "Super+E",          // Win+E  file explorer
    "Super+R",          // Win+R  run dialog
    "Super+L",          // Win+L  lock screen
    "Super+Tab",        // Win+Tab task view
    "Super+M",          // Win+M  minimise all
    "Super+Up",
    "Super+Down",
    "Super+Left",
    "Super+Right",
    "Ctrl+Escape",      // Start menu
    "Ctrl+Alt+Delete",
    "Ctrl+Shift+Escape",// Task manager
    "Ctrl+Tab",
    "Ctrl+Shift+Tab",
    "Ctrl+W",
    "Ctrl+T",
    "Ctrl+N",
    "Ctrl+R",
    "F5",
    "PrintScreen",
    "Alt+PrintScreen",
  ];

  app.on("browser-window-focus", () => {
    blocked.forEach(sc => {
      try { globalShortcut.register(sc, () => {}); } catch (_) {}
    });
  });

  app.on("browser-window-blur", (event, win) => {
    globalShortcut.unregisterAll();
    if (win && !win.isDestroyed()) {
      win.webContents.send("app-window-blur");
    }
  });

  // Register immediately on launch too
  blocked.forEach(sc => {
    try { globalShortcut.register(sc, () => {}); } catch (_) {}
  });

  // ── Prevent window close unless red X clicked ─────────────────────────────
  win.on("close", (e) => {
    if (!allowQuit) e.preventDefault();
  });

  ipcMain.on("app-quit", () => {
    allowQuit = true;
    globalShortcut.unregisterAll();

    // Read session.json — delete user data only if status is "evaluated"
    const userDataPath = app.getPath("userData");
    const sessionFile  = path.join(userDataPath, "session.json");
    let status = "running"; // safe default — do NOT delete if file missing
    try {
      if (fs.existsSync(sessionFile)) {
        const parsed = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
        if (parsed && parsed.status) status = parsed.status;
      }
    } catch {}

    if (status === "evaluated") {
      try { fs.rmSync(path.join(userDataPath, "Exam"),        { recursive: true, force: true }); } catch {}
      try { fs.rmSync(path.join(userDataPath, "inputs"),      { recursive: true, force: true }); } catch {}
      try { fs.rmSync(path.join(userDataPath, "tamper.json"), { force: true });                  } catch {}
      try { fs.rmSync(sessionFile,                            { force: true });                  } catch {}
    }
    // status === "running" → files persist, nothing deleted

    cleanupSessionDir();
    app.quit();
  });

  const appRoot = app.getAppPath ? app.getAppPath() : __dirname;
  win.loadFile(path.join(appRoot, "index.html"));

  win.webContents.once("did-finish-load", () => {
    if (!app.isPackaged) {
      win.webContents.openDevTools();
    }
  });
}

  app.whenReady().then(() => {
  // Crash-safety cleanup: remove leftover temp sessions
  // (these can exist after a crash or forced close).
  cleanupOldSessions(app.getPath("userData"));
  ensureSessionDir();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Extra safety: if the app quits without going through `app-quit`,
// still remove the session directory.
app.on("before-quit", () => cleanupSessionDir());