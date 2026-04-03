const { app, BrowserWindow, Menu, ipcMain, globalShortcut, shell, dialog } = require("electron");
const path = require("path");
const fs   = require("fs");
const { generateSubmissionPdf } = require("./generate-submission-pdf");
const { autoUpdater } = require("electron-updater");

// Paths: appRoot for reading bundled files (Monaco etc); userData for writable (Exam, .run, log, exam_env)
// In packaged app, __dirname is inside asar (read-only) — writable data MUST use userData
let sessionDir = null;
let sessionId = null;

// ── Bundled MinGW compiler paths ──────────────────────────────────────────────
// Dev:        <project-root>/compiler/mingw/bin/
// Packaged:   <install>/resources/compiler/mingw/bin/   (via extraResources)
function getMingwBin() {
  const base = app.isPackaged ? process.resourcesPath : __dirname;
  return path.join(base, "compiler", "mingw", "bin");
}
function getGppPath() { return path.join(getMingwBin(), "g++.exe"); }
function getGccPath() { return path.join(getMingwBin(), "gcc.exe"); }

// Inject MinGW bin into PATH so:
//   1. The compiler itself can find its own tools (cc1plus, as, ld...)
//   2. The compiled .exe can find runtime DLLs (libstdc++-6.dll etc.)
function mingwEnv() {
  const mingwBin = getMingwBin();
  const systemPath = process.env.PATH || process.env.Path || "";
  return { ...process.env, PATH: mingwBin + path.delimiter + systemPath };
}
// ─────────────────────────────────────────────────────────────────────────────

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

// ── IPC: get-mingw-bin ───────────────────────────────────────────────────────
// Renderer needs this to inject MinGW bin into PATH when spawning compiled exe,
// so runtime DLLs (libstdc++-6.dll, libgcc_s_seh-1.dll, winpthread-1.dll) resolve.
// ─────────────────────────────────────────────────────────────────────────────
ipcMain.handle("get-mingw-bin", () => getMingwBin());

// ── IPC: compile-cpp ─────────────────────────────────────────────────────────
// Renderer sends: { runDir, srcFile, exeFile }   (srcFile/exeFile = bare names)
// Main responds:  { stdout, stderr, err }
// ─────────────────────────────────────────────────────────────────────────────
ipcMain.handle("compile-cpp", (_event, { runDir, srcFile, exeFile }) => {
  return new Promise(resolve => {
    const gpp = getGppPath();
    if (!fs.existsSync(gpp)) {
      return resolve({ err: `Compiler not found at: ${gpp}`, stdout: "", stderr: "" });
    }
    require("child_process").exec(
      `"${gpp}" "${srcFile}" -o "${exeFile}" -pthread`,
      { cwd: runDir, windowsHide: true, timeout: 30000, env: mingwEnv() },
      (err, stdout, stderr) => resolve({
        err: err ? err.message : null,
        stdout: stdout || "",
        stderr: stderr || "",
      })
    );
  });
});

// ── IPC: compile-c ───────────────────────────────────────────────────────────
ipcMain.handle("compile-c", (_event, { runDir, srcFile, exeFile }) => {
  return new Promise(resolve => {
    const gcc = getGccPath();
    if (!fs.existsSync(gcc)) {
      return resolve({ err: `Compiler not found at: ${gcc}`, stdout: "", stderr: "" });
    }
    require("child_process").exec(
      `"${gcc}" "${srcFile}" -o "${exeFile}"`,
      { cwd: runDir, windowsHide: true, timeout: 30000, env: mingwEnv() },
      (err, stdout, stderr) => resolve({
        err: err ? err.message : null,
        stdout: stdout || "",
        stderr: stderr || "",
      })
    );
  });
});

// ── IPC: generate-submission-pdf ─────────────────────────────────────────────
ipcMain.handle("generate-submission-pdf", async (_event, { examDir, studentName, enrollNo, pdfFilename }) => {
  try {
    const result = await generateSubmissionPdf({ examDir, app, studentName, enrollNo, pdfFilename });
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

  win.webContents.on("before-input-event", (event, input) => {
    const key = (input.key || "").toLowerCase();
    const ctrl = input.control || input.meta;
    const alt  = input.alt;
    const shift = input.shift;

    if (alt && key === "f4")          { event.preventDefault(); return; }
    if (alt && key === "tab")         { event.preventDefault(); return; }
    if (ctrl && key === "w")          { event.preventDefault(); return; }
    if (ctrl && key === "tab")        { event.preventDefault(); return; }
    if (ctrl && key === "escape")     { event.preventDefault(); return; }
    if (ctrl && alt && key === "delete") { event.preventDefault(); return; }
    if (key === "f5")                 { event.preventDefault(); return; }
    if (ctrl && key === "r")          { event.preventDefault(); return; }
    if (ctrl && key === "t")          { event.preventDefault(); return; }
    if (ctrl && key === "n")          { event.preventDefault(); return; }
    if (key === "printscreen")        { event.preventDefault(); return; }
    if (key === "meta" || key === "super" || key === "os") {
      event.preventDefault(); return;
    }
  });

  const blocked = [
    "Alt+F4", "Alt+Tab", "Alt+Shift+Tab",
    "Super+D", "Super+E", "Super+R", "Super+L", "Super+Tab", "Super+M",
    "Super+Up", "Super+Down", "Super+Left", "Super+Right",
    "Ctrl+Escape", "Ctrl+Alt+Delete", "Ctrl+Shift+Escape",
    "Ctrl+Tab", "Ctrl+Shift+Tab", "Ctrl+W", "Ctrl+T", "Ctrl+N", "Ctrl+R",
    "F5", "PrintScreen", "Alt+PrintScreen",
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

  blocked.forEach(sc => {
    try { globalShortcut.register(sc, () => {}); } catch (_) {}
  });

  win.on("close", (e) => {
    if (!allowQuit) e.preventDefault();
  });

  ipcMain.on("app-quit", () => {
    allowQuit = true;
    globalShortcut.unregisterAll();

    const userDataPath = app.getPath("userData");
    const sessionFile  = path.join(userDataPath, "session.json");
    let status = "running";
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

app.on("before-quit", () => cleanupSessionDir());