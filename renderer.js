// Bootstrap: get paths from main process (required for packaged app — writable data must use userData)
(async function init() {
  const nodeRequire = window.nodeRequire;
  const fs = nodeRequire("fs");
  const path = nodeRequire("path");
  const { ipcRenderer } = nodeRequire("electron");
  const { appRoot, userDataPath, sessionDir } = await ipcRenderer.invoke("get-app-paths");

  // ── session.json init ──
  try {
    const sessionFile = path.join(userDataPath, "session.json");
    if (!fs.existsSync(sessionFile)) {
      fs.writeFileSync(sessionFile, JSON.stringify({ status: "running" }, null, 2), "utf8");
    } else {
      // Set evaluate button color based on persisted status
      const saved = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
      if (saved && saved.status === "evaluated") {
        const btn = document.getElementById("evaluateBtn");
        btn.classList.add("evaluated");
        btn.textContent = "✓ Evaluated";
      }
    }
  } catch {}

  const input = document.getElementById("pdfInput");
  const uploadBtn = document.getElementById("uploadBtn");
  const saveBtn = document.getElementById("saveNbBtn");
  const frame = document.getElementById("pdfFrame");
  const status = document.getElementById("nbStatus");
  const langSelect = document.getElementById("langSelect");

  let currentPdfUrl = null;
  let currentPdfName = null; // tracks PDF filename for evaluation modal

  // ── PDF persistence helpers ──
  const pdfDir      = path.join(userDataPath, "pdf");
  const pdfSavePath = path.join(pdfDir, "exam.pdf");
  const pdfMetaPath = path.join(pdfDir, "exam_meta.json");

  function loadSavedPdf() {
    try {
      if (!fs.existsSync(pdfSavePath)) return false;
      const meta = fs.existsSync(pdfMetaPath)
        ? JSON.parse(fs.readFileSync(pdfMetaPath, "utf8"))
        : {};
      const bytes = fs.readFileSync(pdfSavePath);
      const blob  = new Blob([bytes], { type: "application/pdf" });
      if (currentPdfUrl) URL.revokeObjectURL(currentPdfUrl);
      currentPdfUrl  = URL.createObjectURL(blob);
      currentPdfName = meta.name || "exam.pdf";
      frame.src = currentPdfUrl;
      setPdfStatus(currentPdfName);
      // Hide upload controls — PDF already loaded
      uploadBtn.style.display = "none";
      input.style.display     = "none";
      swStart();
      return true;
    } catch (e) {
      console.error("Failed to restore saved PDF:", e);
      return false;
    }
  }

  // ════════════════════════════════════════════
  //  ① STOPWATCH  — starts immediately on load
  // ════════════════════════════════════════════
  const swEl = document.getElementById("stopwatch");
  let swSeconds = 0;
  let swInterval = null;

  function swFormat(s) {
    const h = String(Math.floor(s / 3600)).padStart(2, "0");
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const sec = String(s % 60).padStart(2, "0");
    return `${h}:${m}:${sec}`;
  }

  function swStart() {
    if (swInterval) return;
    swInterval = setInterval(() => {
      swSeconds++;
      swEl.textContent = swFormat(swSeconds);
    }, 1000);
  }

  function swStop() {
    clearInterval(swInterval);
    swInterval = null;
  }

  function swReset() {
    swStop();
    swSeconds = 0;
    swEl.textContent = swFormat(0);
  }

  // Stopwatch starts only after PDF is uploaded

  // ════════════════════════════════════════════
  //  ② CLOSE BUTTON — confirm dialog + cleanup
  // ════════════════════════════════════════════
  const exitOverlay = document.getElementById("exitOverlay");

  // Show dialog when red X clicked
  document.getElementById("closeBtn").addEventListener("click", () => {
    exitOverlay.classList.add("show");
  });

  // Cancel — just close the dialog
  document.getElementById("exitCancelBtn").addEventListener("click", () => {
    exitOverlay.classList.remove("show");
    swStart(); // resume stopwatch if it was running
  });

  // Confirm — delete saved files then quit
  document.getElementById("exitConfirmBtn").addEventListener("click", () => {
    swStop();
    // Renderer does NOT delete files — main.js handles cleanup based on session.json status
    ipcRenderer.send("app-quit");
  });

  // Stop stopwatch on unload (app closed any other way)
  window.addEventListener("beforeunload", () => {
    swStop();
    if (currentPdfUrl) URL.revokeObjectURL(currentPdfUrl);
  });

  // ════════════════════════════════════════════
  //  ③ ANTICHEAT — block dangerous key combos
  // ════════════════════════════════════════════
  const flash = document.getElementById("blockFlash");

  function showFlash() {
    flash.style.display = "block";
    flash.style.animation = "none";
    // Force reflow then re-apply animation
    void flash.offsetWidth;
    flash.style.animation = "flashFade 0.4s ease forwards";
    setTimeout(() => { flash.style.display = "none"; }, 420);
  }

  function block(e) {
    e.preventDefault();
    e.stopPropagation();
    showFlash();
    logEvent(`BLOCKED key: ${e.key} (ctrl:${e.ctrlKey} alt:${e.altKey} meta:${e.metaKey} shift:${e.shiftKey})`);
    return false;
  }

  window.addEventListener("keydown", (e) => {
    const k = e.key;
    const ctrl  = e.ctrlKey  || e.metaKey;   // Ctrl or Cmd
    const alt   = e.altKey;
    const shift = e.shiftKey;

    // ── Windows system shortcuts ──
    if (k === "F4"  && alt)              return block(e); // Alt+F4
    if (k === "d"   && ctrl && !alt)     return block(e); // Win+D (show desktop) — note: Win key can't be fully blocked in browser but we cover Ctrl+D too
    if (k === "D"   && ctrl && !alt)     return block(e);

    // ── Tab switching / window switching ──
    if (k === "Tab" && alt)              return block(e); // Alt+Tab
    if (k === "Tab" && ctrl)             return block(e); // Ctrl+Tab (browser tab switch)
    if (k === "Tab" && ctrl && shift)    return block(e); // Ctrl+Shift+Tab
    if (k === "Escape" && ctrl)          return block(e); // Ctrl+Esc (Start menu)

    // ── Task manager / system tools ──
    if (k === "Escape" && ctrl && shift) return block(e); // Ctrl+Shift+Esc
    if (k === "Delete" && ctrl && alt)   return block(e); // Ctrl+Alt+Del (partially)

    // ── Print screen / screen capture ──
    if (k === "PrintScreen")             return block(e);

    // ── Browser/app navigation ──
    if (k === "F5" && !ctrl)             return block(e); // F5 reload
    if (k === "r"  && ctrl)              return block(e); // Ctrl+R reload
    if (k === "F11")                     return block(e); // Fullscreen toggle
    if (k === "l"  && ctrl)              return block(e); // Ctrl+L (address bar)
    if (k === "t"  && ctrl)              return block(e); // Ctrl+T (new tab)
    if (k === "w"  && ctrl)              return block(e); // Ctrl+W (close tab)
    if (k === "n"  && ctrl)              return block(e); // Ctrl+N (new window)
    if (k === "F4" && ctrl)              return block(e); // Ctrl+F4

    // ── Meta/Super key (Windows key) ──
    if (k === "Meta")                    return block(e);
    if (k === "OS")                      return block(e); // Some browsers report it as OS
  }, true); // capture phase — intercepts before Monaco/other handlers

  function setStatus(text) {
    status.textContent = text; // notebook toolbar status
  }

  function setPdfStatus(text) {
    document.getElementById("status").textContent = text;
  }

  // ── Saved Files List ──
  const fileListEl = document.getElementById("fileList");
  const inputFileEl = document.getElementById("inputFile");
  const uploadInputBtn = document.getElementById("uploadInputBtn");

  function refreshFileList() {
    const examDir  = path.join(userDataPath, "Exam"); // FIX: persistent storage
    const inputDir = path.join(userDataPath, "inputs");
    try { fs.mkdirSync(examDir, { recursive: true }); } catch {}
    try { fs.mkdirSync(inputDir, { recursive: true }); } catch {}

    let solutionFiles = [];
    try {
      solutionFiles = fs.readdirSync(examDir)
        .filter(f => /^solution_\d+\.(cpp|c|py)$/i.test(f))
        .sort((a, b) => {
          const na = Number((/^solution_(\d+)/i.exec(a) || [])[1] || 0);
          const nb = Number((/^solution_(\d+)/i.exec(b) || [])[1] || 0);
          return na - nb;
        });
    } catch {}

    let inputFiles = [];
    try {
      inputFiles = fs.readdirSync(inputDir)
      .filter(f => /\.(csv|txt)$/i.test(f))
        .sort((a, b) => {
          const na = Number((/^input_(\d+)/i.exec(a) || [])[1] || 0);
          const nb = Number((/^input_(\d+)/i.exec(b) || [])[1] || 0);
          return na - nb;
        });
    } catch {}

    if (solutionFiles.length === 0 && inputFiles.length === 0) {
      fileListEl.innerHTML = `<span style="font-size:11px;opacity:0.4;padding:4px 6px;display:block;">No saved files yet</span>`;
      return;
    }

    const solutionButtons = solutionFiles.map(f =>
      `<button class="fileItem" type="button" data-file="${encodeURIComponent(f)}">${f}</button>`
    );

    // Uploaded inputs are read-only (no deletion/editing). Show them but disable click.
    const inputButtons = inputFiles.map(f =>
      `<button class="fileItem" type="button" data-file="${encodeURIComponent(f)}" data-kind="input" disabled>inputs/${f}</button>`
    );

    fileListEl.innerHTML = [...solutionButtons, ...inputButtons].join("");
  }

  fileListEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-file]");
    if (!btn) return;
    // Uploaded inputs are read-only; clicking should not load/edit them.
    if (btn.getAttribute("data-kind") === "input") {
      setStatus("Uploaded input files are read-only.");
      return;
    }
    const dir = path.join(userDataPath, "Exam"); // FIX: persistent storage
    const filename = decodeURIComponent(btn.getAttribute("data-file"));
    const ext = filename.split(".").pop().toLowerCase();
    try {
      const content = fs.readFileSync(path.join(dir, filename), "utf8");
      if (ext === "cpp") {
        langSelect.value = "cpp";
        applyLang("cpp");
        if (cppEditor) cppEditor.setValue(content);
        setCppStatus("Opened: " + filename);
      } else if (ext === "c") {
        langSelect.value = "c";
        applyLang("c");
        if (cEditor) cEditor.setValue(content);
        setCStatus("Opened: " + filename);
      } else {
        langSelect.value = "py";
        applyLang("py");
        // Load into a new cell
        if (cells.length > 0) cells[0].editor.setValue(content);
        setStatus("Opened: " + filename);
      }
    } catch { setStatus("Open failed"); }
  });

  uploadBtn.addEventListener("click", () => input.click());

  // ─────────────────────────────────────────────
  //  Input file upload (CSV/TXT → userDataPath/inputs)
  // ─────────────────────────────────────────────
  const MAX_INPUT_FILES = 3;
  const MAX_INPUT_BYTES = 50 * 1024 * 1024; // 50 MB
  const allowedInputExts = [".csv", ".txt"];
  let inputUploadCount = 0;

  uploadInputBtn.addEventListener("click", () => {
    // File dialog opening can blur the window and trigger "tab change" tamper detection.
    // Reuse the same grace window as the PDF upload flow.
    ignoreNextBlur(5000);
    inputFileEl.value = "";
    inputFileEl.click();
  });

  inputFileEl.addEventListener("change", async () => {
    const file = inputFileEl.files && inputFileEl.files[0];
    if (!file) return;

    const ext = (path.extname(file.name) || "").toLowerCase();
    if (!allowedInputExts.includes(ext)) {
      alert("Only .csv and .txt files are allowed.");
      inputFileEl.value = "";
      return;
    }

    if (file.size > MAX_INPUT_BYTES) {
      alert("File is too large. Maximum allowed size is 50 MB.");
      inputFileEl.value = "";
      return;
    }

    const inputDir = path.join(userDataPath, "inputs"); // FIX: persistent storage
    try { fs.mkdirSync(inputDir, { recursive: true }); } catch {}

    // Compute occupied "slots" for input_1..input_3.
    // A slot is occupied if either input_<n>.csv OR input_<n>.txt exists.
    try {
      const indices = new Set(
        fs.readdirSync(inputDir)
          .filter(f => /\.(csv|txt)$/i.test(f))
          .map(f => {
            const m = /^input_(\d+)\.(csv|txt)$/i.exec(f);
            return m ? m[1] : null;
          })
          .filter(Boolean)
      );
      inputUploadCount = indices.size;
    } catch {
      inputUploadCount = 0;
    }
    if (inputUploadCount >= MAX_INPUT_FILES) {
      alert("Maximum of 3 input files per session.");
      inputFileEl.value = "";
      return;
    }

    // Find first available index 1..MAX_INPUT_FILES that doesn't already exist.
    const existingFiles = fs.readdirSync(inputDir)
      .filter(f => /\.(csv|txt)$/i.test(f));

    if (existingFiles.length >= MAX_INPUT_FILES) {
      alert("Maximum of 3 input files per session.");
      inputFileEl.value = "";
      return;
    }

    // prevent duplicate overwrite
    let fileName = file.name;
    let base = path.parse(fileName).name;
    let extension = path.extname(fileName);

    let counter = 1;
    while (fs.existsSync(path.join(inputDir, fileName))) {
      fileName = `${base}(${counter})${extension}`;
      counter++;
    }

    const destPath = path.join(inputDir, fileName);
    try {
      // Do not rely on `file.path` (not always available in renderer).
      // Write bytes directly from the File API.
      const ab = await file.arrayBuffer();
      fs.writeFileSync(destPath, Buffer.from(ab));
      inputUploadCount++;
      console.log("[UPLOAD]", fileName);
      if (typeof logEvent === "function") {
        logEvent(`[UPLOAD] ${fileName} (original: ${file.name})`);
      }
    } catch (e) {
      console.error("Failed to save uploaded input file:", e);
      alert("Failed to save uploaded file.");
    } finally {
      // Refresh list so newly uploaded inputs appear.
      refreshFileList();
      inputFileEl.value = "";
    }
  });

  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.type !== "application/pdf") {
      setPdfStatus("Please select a PDF");
      input.value = "";
      return;
    }

    // Persist PDF to disk so it survives app restarts
    try {
      fs.mkdirSync(pdfDir, { recursive: true });
      const ab = await file.arrayBuffer();
      fs.writeFileSync(pdfSavePath, Buffer.from(ab));
      fs.writeFileSync(pdfMetaPath, JSON.stringify({ name: file.name }), "utf8");
    } catch (e) {
      console.error("Failed to save PDF:", e);
    }

    if (currentPdfUrl) URL.revokeObjectURL(currentPdfUrl);
    currentPdfUrl  = URL.createObjectURL(file);
    currentPdfName = file.name;
    frame.src = currentPdfUrl;
    setPdfStatus(file.name);
    swStart(); // start stopwatch on PDF upload
    // Hide upload controls permanently
    uploadBtn.style.display = "none";
    input.style.display     = "none";
  });

  const logFile = path.join(sessionDir, "log.txt");
  function logEvent(message) {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    try {
      fs.appendFileSync(logFile, line, "utf8");
    } catch {}
  }
  window.addEventListener("blur", () => logEvent("Window lost focus (blur)"));

  // ════════════════════════════════════════════
  //  TAB-SWITCH / MINIMISE COUNTER
  // ════════════════════════════════════════════
  let tamperCount = 0;

  // Load persisted tamperCount (tracking only — not shown in UI until evaluation)
  try {
    const tamperFile = path.join(userDataPath, "tamper.json");
    if (fs.existsSync(tamperFile)) {
      const saved = JSON.parse(fs.readFileSync(tamperFile, "utf8"));
      if (typeof saved.count === "number" && saved.count > 0) {
        tamperCount = saved.count;
      }
    }
  } catch { 
    tamperCount = 0; 
    let appJustStarted = true;
    setTimeout(() => {
      appJustStarted = false;
    }, 2000); 
  }

  function recordTamper(reason) {
    tamperCount++;
    logEvent(`TAMPER #${tamperCount}: ${reason}`);
    try {
      fs.writeFileSync(path.join(userDataPath, "tamper.json"), JSON.stringify({ count: tamperCount }), "utf8");
    } catch {}
  }

  // Returns true when session is evaluated — all anti-cheat tracking must stop.
  function isAntiCheatFrozen() {
    try {
      const sf = path.join(userDataPath, "session.json");
      if (!fs.existsSync(sf)) return false;
      const s = JSON.parse(fs.readFileSync(sf, "utf8"));
      return s && s.status === "evaluated";
    } catch {
      return false;
    }
  }

  // ── Strategy ──
  // IPC from main (browser-window-blur) → fires when window loses focus
  //   regardless of PDF/editor/background. PRIMARY detector.
  // visibilitychange → fallback when page becomes hidden (e.g. minimise).
  // Debounce avoids double-counting when both fire for the same action.
  // Do NOT ignore for PDF — that caused missed counts when focus was on PDF.

  let lastTamperRecordedAt = 0;
  let appJustStarted = true;

  setTimeout(() => {
    appJustStarted = false;
  }, 2000); 
  const TAMPER_DEBOUNCE_MS = 150;
  function maybeRecordTamper(reason) {
    const now = Date.now();
    if (now - lastTamperRecordedAt < TAMPER_DEBOUNCE_MS) return;
    lastTamperRecordedAt = now;
    recordTamper(reason);
  }

  // Grace flag — suppress blur only when file dialog opens (Upload PDF)
  let ignoringBlur = false;
  function ignoreNextBlur(ms) {
    ignoringBlur = true;
    setTimeout(() => { ignoringBlur = false; }, ms);
  }

  uploadBtn.addEventListener("click", () => ignoreNextBlur(5000));

  // PRIMARY: IPC from main — works when PDF iframe, editor, or background has focus
  ipcRenderer.on("app-window-blur", () => {
    if (isAntiCheatFrozen()) return;
    if (ignoringBlur) return;
    maybeRecordTamper("Window lost focus — tab switch / minimise / Win+D");
    startAwayTimer();
  });

  // FALLBACK: visibilitychange — e.g. when window is minimised
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (isAntiCheatFrozen()) return;
      maybeRecordTamper("Window hidden — tab switch / minimise / Win+D");
      startAwayTimer();
    } else {
      stopAwayTimer();
    }
  });

  // Return detection — user switches back to the app
  window.addEventListener("focus", () => {
    if (isAntiCheatFrozen()) return;
    stopAwayTimer();
  });

  // ════════════════════════════════════════════
  //  AWAY TIMER
  // ════════════════════════════════════════════
  let isAway        = false;
  let awayStartTime = null;
  let totalAwayTime = 0; // accumulated seconds

  // Load persisted away time — survives app restarts until evaluated
  try {
    const awayFile = path.join(userDataPath, "away.json");
    if (fs.existsSync(awayFile)) {
      const saved = JSON.parse(fs.readFileSync(awayFile, "utf8"));
      if (typeof saved.totalAwayTime === "number") {
        totalAwayTime = saved.totalAwayTime;
      }
    }
  } catch { totalAwayTime = 0; }

  function saveAwayTime() {
    try {
      fs.writeFileSync(
        path.join(userDataPath, "away.json"),
        JSON.stringify({ totalAwayTime }),
        "utf8"
      );
    } catch {}
  }

  function startAwayTimer() {
    if (isAway) return; // already away — don't double-count
    isAway = true;
    awayStartTime = Date.now();
  }

  function stopAwayTimer() {
    if (!isAway) return; // wasn't away — nothing to stop
    isAway = false;
    if (awayStartTime !== null) {
      totalAwayTime += Math.floor((Date.now() - awayStartTime) / 1000);
      awayStartTime = null;
      saveAwayTime(); // persist immediately after each away stint
    }
  }

  // Edge case: app closed while user is away — flush pending away time
  window.addEventListener("beforeunload", () => {
    stopAwayTimer();
  });

  // ════════════════════════════════════════════
  //  PYTHON NOTEBOOK ENGINE
  // ════════════════════════════════════════════
  const { exec, spawn } = nodeRequire("child_process");

  function execCmdWithTimeout(cmd, cwd, timeoutMs) {
    return new Promise((resolve) => {
      exec(cmd, { cwd, windowsHide: true, timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 },
        (error, stdout, stderr) => resolve({
          code: error && typeof error.code === "number" ? error.code : 0,
          error, stdout: stdout || "", stderr: stderr || ""
        })
      );
    });
  }

  const pythonEnvDir  = path.join(sessionDir, "exam_env");
  const pythonEnvMarker = path.join(pythonEnvDir, "pyvenv.cfg");
  const pythonExe = process.platform === "win32"
    ? path.join(pythonEnvDir, "Scripts", "python.exe")
    : path.join(pythonEnvDir, "bin", "python");
  const pipExe = process.platform === "win32"
    ? path.join(pythonEnvDir, "Scripts", "pip.exe")
    : path.join(pythonEnvDir, "bin", "pip");

  // ── Shared kernel state file (simulate persistent namespace) ──
  // We prepend all previous cell code so variables are shared.
  let cellHistory = []; // array of { id, code } in execution order

  async function ensurePythonEnv(outputFn) {
    if (fs.existsSync(pythonEnvMarker) && fs.existsSync(pythonExe)) return true;
    outputFn("> Setting up Python environment (first run, please wait)...\n");
    const venv = await execCmdWithTimeout(`python -m venv exam_env`, sessionDir, 5 * 60 * 1000);
    if (venv.stdout) outputFn(venv.stdout);
    if (venv.stderr) outputFn(venv.stderr);
    if (venv.error)  return false;
    const pipUp = await execCmdWithTimeout(`"${pythonExe}" -m pip install --upgrade pip`, sessionDir, 5 * 60 * 1000);
    if (pipUp.error) return false;
    const deps = await execCmdWithTimeout(`"${pythonExe}" -m pip install numpy pandas`, sessionDir, 10 * 60 * 1000);
    if (deps.stdout) outputFn(deps.stdout);
    return fs.existsSync(pythonEnvMarker) && fs.existsSync(pythonExe);
  }

  // ── pip detection ──
  function isPipCommand(code) {
    return /^\s*pip\s+\w/i.test(code) || /^\s*!pip\s+\w/i.test(code);
  }

  function normalizePipArgs(raw) {
    const s = raw.trim().replace(/^!/, "");
    if (/[&|;><`]/.test(s) || /\r|\n/.test(s)) return { ok: false, reason: "Blocked characters" };
    let args = s;
    if (/^pip(\.exe)?\s+/i.test(args)) args = args.replace(/^pip(\.exe)?\s+/i, "");
    else if (/^python\s+-m\s+pip\s+/i.test(args)) args = args.replace(/^python\s+-m\s+pip\s+/i, "");
    else return { ok: false, reason: "Only pip commands allowed" };
    if (/\b(rm|del|erase|format|shutdown|reboot|powershell|cmd|curl|wget)\b/i.test(args))
      return { ok: false, reason: "Blocked keyword" };
    const sub = (args.split(/\s+/)[0] || "").toLowerCase();
    if (!new Set(["install","uninstall","list","show","freeze","check","download"]).has(sub))
      return { ok: false, reason: "Blocked pip subcommand" };
    return { ok: true, args };
  }

  // ── Run pip in a cell ──
  async function runPipCell(code, outputFn, doneFn) {
    const parsed = normalizePipArgs(code);
    if (!parsed.ok) { outputFn(`Blocked: ${parsed.reason}\n`); doneFn(1); return; }
    outputFn(`> pip ${parsed.args}\n`);
    const ok = await ensurePythonEnv(outputFn);
    if (!ok) { outputFn("Python env setup failed.\n"); doneFn(1); return; }
    const args = parsed.args.split(/\s+/).filter(Boolean);
    const p = spawn(pipExe, args, { cwd: sessionDir, windowsHide: true });
    p.stdout.on("data", d => outputFn(String(d)));
    p.stderr.on("data", d => outputFn(String(d)));
    p.on("close", code => doneFn(code));
  }

  // ── Run Python cell (with shared state via prepended history) ──
  async function runPythonCell(cellId, code, outputFn, doneFn) {
    const ok = await ensurePythonEnv(outputFn);
    if (!ok) { outputFn("Python env setup failed.\n"); doneFn(1); return; }

    const runDir = path.join(sessionDir, ".run");
    fs.mkdirSync(runDir, { recursive: true });

    // Build full script: all prior cells + this cell
    // Use exec() trick so each cell runs in same namespace cumulatively
    const priorCode = cellHistory
      .filter(h => h.id !== cellId)
      .map(h => h.code)
      .join("\n");
    const fullCode = priorCode ? priorCode + "\n" + code : code;

    const pyFile = path.join(runDir, `cell_${cellId}.py`);
    fs.writeFileSync(pyFile, fullCode, "utf8");

    const p = spawn(pythonExe, [pyFile], { cwd: userDataPath, windowsHide: true });
    p.stdout.on("data", d => outputFn(String(d)));
    p.stderr.on("data", d => outputFn(String(d)));
    p.on("close", exitCode => doneFn(exitCode));

    // Store/update this cell's code in history immediately
    const idx = cellHistory.findIndex(h => h.id === cellId);
    if (idx >= 0) cellHistory[idx].code = code;
    else cellHistory.push({ id: cellId, code });
  }

  // ════════════════════════════════════════════
  //  NOTEBOOK UI — cells with Monaco editors
  // ════════════════════════════════════════════
  let cellCounter = 0;
  let execCounter = 0; // execution order number
  const cells = [];    // { id, editor, outputEl, numEl }
  const notebookArea = document.getElementById("notebookArea");

  function createCell(initialCode) {
    cellCounter++;
    const id = cellCounter;
    const cellEl = document.createElement("div");
    cellEl.className = "nb-cell";
    cellEl.dataset.id = id;

    cellEl.innerHTML = `
      <div class="nb-cell-header">
        <span class="nb-cell-num" id="cellnum-${id}">[ ]</span>
        <button class="nb-run-btn" id="runbtn-${id}" title="Run cell (Shift+Enter)">▶ Run</button>
        <button class="nb-del-btn" title="Delete cell">✕</button>
      </div>
      <div class="nb-editor-wrap" id="edwrap-${id}" style="height:100px"></div>
      <div class="nb-output" id="output-${id}"></div>`;

    notebookArea.appendChild(cellEl);

    // Monaco editor for this cell
    const edWrap = document.getElementById(`edwrap-${id}`);
    const monacoEd = monaco.editor.create(edWrap, {
      value: initialCode || "",
      language: "python",
      theme: "vs-dark",
      minimap: { enabled: false },
      automaticLayout: false,
      scrollBeyondLastLine: false,
      lineNumbers: "on",
      fontSize: 13,
      wordWrap: "on",
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      scrollbar: { vertical: "hidden", horizontal: "hidden" },
      lineDecorationsWidth: 4,
    });

    // Auto-grow editor to fit content
    function fitEditorHeight() {
      const lineH = monacoEd.getOption(monaco.editor.EditorOption.lineHeight);
      const lines = monacoEd.getModel().getLineCount();
      const h = Math.max(60, Math.min(lines * lineH + 20, 400));
      edWrap.style.height = h + "px";
      monacoEd.layout();
    }
    monacoEd.onDidChangeModelContent(fitEditorHeight);
    fitEditorHeight();

    // Shift+Enter to run
    monacoEd.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => {
      runCell(id);
    });

    const outputEl = document.getElementById(`output-${id}`);
    const numEl    = document.getElementById(`cellnum-${id}`);
    const runBtn   = document.getElementById(`runbtn-${id}`);

    // Run button
    runBtn.addEventListener("click", () => runCell(id));

    // Delete button
    cellEl.querySelector(".nb-del-btn").addEventListener("click", () => {
      if (cells.length <= 1) return; // keep at least one cell
      const idx = cells.findIndex(c => c.id === id);
      if (idx >= 0) {
        cells.splice(idx, 1);
        cellHistory = cellHistory.filter(h => h.id !== id);
      }
      monacoEd.dispose();
      cellEl.remove();
      renumberCells();
    });

    cells.push({ id, editor: monacoEd, outputEl, numEl, runBtn });
    renumberCells();
    monacoEd.focus();
    return id;
  }

  function renumberCells() {
    cells.forEach((c, i) => {
      c.cellEl = document.querySelector(`.nb-cell[data-id="${c.id}"]`);
    });
  }

  async function runCell(id) {
    const cell = cells.find(c => c.id === id);
    if (!cell) return;
    const code = cell.editor.getValue().trim();
    if (!code) return;

    execCounter++;
    const execNum = execCounter;
    const runToken = Symbol("cell_run");
    cell._activeRunToken = runToken;
    cell.numEl.textContent = `[*]`;
    cell.runBtn.classList.add("running");
    cell.runBtn.textContent = "● Running";
    cell.outputEl.textContent = "Running...\n";
    cell.outputEl.className = "nb-output";
    let outputBuffer = "";

    const outputFn = (text) => {
      // Ignore output from older runs if user re-runs while still executing.
      if (cell._activeRunToken !== runToken) return;
      outputBuffer += text;
      cell.outputEl.textContent = outputBuffer;
      cell.outputEl.classList.add("has-content");
      cell.outputEl.scrollTop = cell.outputEl.scrollHeight;
    };

    const doneFn = (exitCode) => {
      // Ignore done from older runs if user re-runs while still executing.
      if (cell._activeRunToken !== runToken) return;
      cell.numEl.textContent = `[${execNum}]`;
      cell.runBtn.classList.remove("running");
      cell.runBtn.textContent = "▶ Run";
      if (exitCode !== 0) cell.outputEl.classList.add("error");
      setStatus(exitCode === 0 ? "Done" : "Error");
    };

    setStatus("Running...");

    if (isPipCommand(code)) {
      cell.outputEl.classList.add("pip-out");
      await runPipCell(code, outputFn, doneFn);
    } else {
      await runPythonCell(id, code, outputFn, doneFn);
    }
  }

  async function runAllCells() {
    setStatus("Running all cells...");
    for (const cell of cells) {
      await new Promise(resolve => {
        let runToken = null;
        const origDone = (exitCode) => {
          const c = cells.find(c => c.id === cell.id);
          if (c) {
            // Ignore done updates if user re-runs this same cell while still executing.
            if (c._activeRunToken !== runToken) return;
            c.numEl.textContent = `[${execCounter}]`;
            c.runBtn.classList.remove("running");
            c.runBtn.textContent = "▶ Run";
            if (exitCode !== 0) c.outputEl.classList.add("error");
          }
          resolve();
        };
        const code = cell.editor.getValue().trim();
        if (!code) { resolve(); return; }
        execCounter++;
        const execNum = execCounter;
        runToken = Symbol("cell_run");
        cell._activeRunToken = runToken;
        cell.numEl.textContent = "[*]";
        cell.runBtn.classList.add("running");
        cell.runBtn.textContent = "● Running";
        cell.outputEl.textContent = "Running...\n";
        cell.outputEl.className = "nb-output";
        let outputBuffer = "";
        const outputFn = t => {
          if (cell._activeRunToken !== runToken) return;
          outputBuffer += t;
          cell.outputEl.textContent = outputBuffer;
          cell.outputEl.classList.add("has-content");
          cell.outputEl.scrollTop = cell.outputEl.scrollHeight;
        };
        if (isPipCommand(code)) {
          cell.outputEl.classList.add("pip-out");
          runPipCell(code, outputFn, origDone);
        } else {
          runPythonCell(cell.id, code, outputFn, origDone);
        }
      });
    }
    setStatus("All cells done");
  }

  function restartKernel() {
    cellHistory = [];
    execCounter = 0;
    cells.forEach(c => {
      // Cancel/ignore any in-flight output from previous runs.
      c._activeRunToken = Symbol("cancel");
      c.numEl.textContent = "[ ]";
      c.outputEl.textContent = "";
      c.outputEl.className = "nb-output";
    });
    setStatus("Kernel restarted");
  }

  // ── Save notebook as .py file ──
  function saveNotebook() {
    const outDir = path.join(userDataPath, "Exam"); // FIX: persistent storage
    fs.mkdirSync(outDir, { recursive: true });
    let max = 0;
    try {
      fs.readdirSync(outDir).forEach(f => {
        const m = /^solution_(\d+)/i.exec(f);
        if (m) max = Math.max(max, Number(m[1]));
      });
    } catch {}
    const filename = `solution_${max + 1}.py`;
    const content = cells.map((c, i) =>
      `# ── Cell ${i + 1} ──\n` + c.editor.getValue()
    ).join("\n\n");
    fs.writeFileSync(path.join(outDir, filename), content, "utf8");
    setStatus("Saved: Exam/" + filename);
    refreshFileList();
  }

  // ── Toolbar buttons ──
  document.getElementById("addCellBtn").addEventListener("click", () => createCell(""));
  document.getElementById("runAllBtn").addEventListener("click",  runAllCells);
  document.getElementById("restartBtn").addEventListener("click", restartKernel);
  saveBtn.addEventListener("click", saveNotebook);

  // ── Language switcher ──
  function applyLang(lang) {
    const cppMode = document.getElementById("cppMode");
    const cMode   = document.getElementById("cMode");
    const pyMode  = document.getElementById("pyMode");
    const sqlMode = document.getElementById("sqlMode");
    cppMode.style.display = lang === "cpp" ? "flex" : "none";
    cMode.style.display   = lang === "c"   ? "flex" : "none";
    pyMode.style.display  = lang === "py"  ? "flex" : "none";
    sqlMode.style.display = lang === "sql" ? "flex" : "none";
    if (lang === "cpp" && cppEditor) cppEditor.layout();
    if (lang === "c"   && cEditor)   cEditor.layout();
    if (lang === "py")  cells.forEach(c => c.editor.layout());
    if (lang === "sql" && sqlEditor) sqlEditor.layout();
  }

  langSelect.addEventListener("change", () => applyLang(langSelect.value));

  // ════════════════════════════════════════════
  //  COMPILED LANGUAGE CONFIG
  //  Extend here to add new compiled languages.
  // ════════════════════════════════════════════
  const COMPILED_LANG_CONFIG = {
    cpp: {
      srcFile:    "temp.cpp",
      exeFile:    process.platform === "win32" ? "temp.exe" : "temp",
      compileCmd: (src, exe) => `g++ ${src} -o ${exe} -pthread`,
      monacoLang: "cpp",
      label:      "C++",
    },
    c: {
      srcFile:    "main.c",
      exeFile:    process.platform === "win32" ? "main.exe" : "main",
      compileCmd: (src, exe) => `gcc ${src} -o ${exe}`,
      monacoLang: "c",
      label:      "C",
    },
  };

  // ════════════════════════════════════════════
  //  SHARED KILL HELPER
  //  On Windows, .kill() only kills the wrapper
  //  shell — taskkill /F /T kills the whole tree.
  // ════════════════════════════════════════════
  function killProcess(proc) {
    if (!proc) return;
    try {
      if (process.platform === "win32") {
        const { exec: execKill } = nodeRequire("child_process");
        execKill(`taskkill /F /T /PID ${proc.pid}`, { windowsHide: true }, () => {});
      } else {
        proc.kill("SIGKILL");
      }
    } catch (_) {}
  }

  // ════════════════════════════════════════════
  //  SHARED BUFFERED OUTPUT HELPER
  //  Batches rapid stdout bursts into one DOM
  //  write per animation frame (~60fps max).
  //  Caps total output to prevent RAM exhaustion.
  // ════════════════════════════════════════════
  const MAX_OUTPUT_CHARS = 200_000; // ~200 KB cap per run

  function makeBufferedAppend(getEl) {
    let buffer = "";
    let rafPending = false;
    let totalChars = 0;
    let capped = false;

    function flush() {
      rafPending = false;
      if (!buffer) return;
      const el = getEl();
      const chunk = buffer;
      buffer = "";
      el.textContent += chunk;
      el.scrollTop = el.scrollHeight;
    }

    function append(text) {
      if (capped) return;
      totalChars += text.length;
      if (totalChars > MAX_OUTPUT_CHARS) {
        buffer += "\n\n[Output truncated — too much output. Use Stop to kill the program.]\n";
        capped = true;
        if (!rafPending) { rafPending = true; requestAnimationFrame(flush); }
        return;
      }
      buffer += text;
      if (!rafPending) { rafPending = true; requestAnimationFrame(flush); }
    }

    function reset() { buffer = ""; rafPending = false; totalChars = 0; capped = false; }
    return { append, reset };
  }

  // ════════════════════════════════════════════
  //  C++ ENGINE
  // ════════════════════════════════════════════
  let cppEditor = null;
  const cppConsoleEl = document.getElementById("cppConsole");
  const cppStatusEl  = document.getElementById("cppStatus");

  function setCppStatus(t) { cppStatusEl.textContent = t; }
  function setCppConsole(t) { cppConsoleEl.textContent = t; cppConsoleEl.scrollTop = cppConsoleEl.scrollHeight; }

  const cppOut = makeBufferedAppend(() => cppConsoleEl);
  function appendCppConsole(t) { cppOut.append(t); }

  let cppRunProcess = null;
  const killCppBtn = document.getElementById("killCppBtn");

  function setCppRunning(isRunning) {
    document.getElementById("runCppBtn").style.display = isRunning ? "none" : "";
    killCppBtn.style.display = isRunning ? "" : "none";
  }

  killCppBtn.addEventListener("click", () => {
    if (cppRunProcess) {
      killProcess(cppRunProcess);
      cppRunProcess = null;
      cppOut.append("\n[Killed by user]\n");
      setCppStatus("Killed");
      setCppRunning(false);
    }
  });

  document.getElementById("runCppBtn").addEventListener("click", async () => {
    if (!cppEditor) return;
    const { exec: execNode, spawn } = nodeRequire("child_process");
    const runDir = path.join(sessionDir, ".run");
    fs.mkdirSync(runDir, { recursive: true });

    const code = cppEditor.getValue();
    const stdinVal = document.getElementById("stdinBox").value || "";
    const cppFile = path.join(runDir, "temp.cpp");
    const exeFile = path.join(runDir, process.platform === "win32" ? "temp.exe" : "temp");

    fs.writeFileSync(cppFile, code, "utf8");
    cppOut.reset();
    setCppConsole("> g++ temp.cpp -o temp\n");
    setCppStatus("Compiling...");

    const compile = await new Promise(res => {
      execNode(`g++ temp.cpp -o ${process.platform === "win32" ? "temp.exe" : "temp"} -pthread`,
        { cwd: runDir, windowsHide: true, timeout: 30000 },
        (err, stdout, stderr) => res({ err, stdout, stderr })
      );
    });

    if (compile.stdout) appendCppConsole(compile.stdout);
    if (compile.stderr) appendCppConsole(compile.stderr);
    if (compile.err) { setCppStatus("Compile error"); return; }

    appendCppConsole("\n> running...\n");
    setCppStatus("Running...");
    setCppRunning(true);

    const p = spawn(exeFile, [], { cwd: userDataPath, windowsHide: true });
    cppRunProcess = p;
    p.stdout.on("data", d => appendCppConsole(String(d)));
    p.stderr.on("data", d => appendCppConsole(String(d)));
    p.on("close", code => {
      cppRunProcess = null;
      setCppRunning(false);
      setCppStatus(code === 0 ? "Done ✓" : "Runtime error");
    });
    if (stdinVal) p.stdin.write(stdinVal);
    p.stdin.end();
  });

  document.getElementById("saveCppBtn").addEventListener("click", () => {
    if (!cppEditor) return;
    const outDir = path.join(userDataPath, "Exam"); // FIX: persistent storage
    fs.mkdirSync(outDir, { recursive: true });
    let max = 0;
    try { fs.readdirSync(outDir).forEach(f => { const m = /^solution_(\d+)/i.exec(f); if (m) max = Math.max(max, Number(m[1])); }); } catch {}
    const filename = `solution_${max + 1}.cpp`;
    fs.writeFileSync(path.join(outDir, filename), cppEditor.getValue(), "utf8");
    setCppStatus("Saved: Exam/" + filename);
    refreshFileList();
  });

  // ════════════════════════════════════════════
  //  C ENGINE  (gcc — shares UI pattern with C++)
  // ════════════════════════════════════════════
  let cEditor = null;
  const cConsoleEl = document.getElementById("cConsole");
  const cStatusEl  = document.getElementById("cStatus");

  function setCStatus(t)  { cStatusEl.textContent = t; }
  function setCConsole(t) { cConsoleEl.textContent = t; cConsoleEl.scrollTop = cConsoleEl.scrollHeight; }

  const cOut = makeBufferedAppend(() => cConsoleEl);
  function appendCConsole(t) { cOut.append(t); }

  let cRunProcess = null;
  const killCBtn = document.getElementById("killCBtn");

  function setCRunning(isRunning) {
    document.getElementById("runCBtn").style.display = isRunning ? "none" : "";
    killCBtn.style.display = isRunning ? "" : "none";
  }

  killCBtn.addEventListener("click", () => {
    if (cRunProcess) {
      killProcess(cRunProcess);
      cRunProcess = null;
      cOut.append("\n[Killed by user]\n");
      setCStatus("Killed");
      setCRunning(false);
    }
  });

  document.getElementById("runCBtn").addEventListener("click", async () => {
    if (!cEditor) return;
    const cfg    = COMPILED_LANG_CONFIG.c;
    const runDir = path.join(sessionDir, ".run");
    fs.mkdirSync(runDir, { recursive: true });

    const code     = cEditor.getValue();
    const stdinVal = document.getElementById("stdinBoxC").value || "";
    const srcPath  = path.join(runDir, cfg.srcFile);
    const exePath  = path.join(runDir, cfg.exeFile);

    fs.writeFileSync(srcPath, code, "utf8");
    cOut.reset();
    setCConsole(`> gcc ${cfg.srcFile} -o ${cfg.exeFile}\n`);
    setCStatus("Compiling...");

    const compile = await new Promise(res => {
      const { exec: execNode } = nodeRequire("child_process");
      execNode(
        cfg.compileCmd(cfg.srcFile, cfg.exeFile),
        { cwd: runDir, windowsHide: true, timeout: 30000 },
        (err, stdout, stderr) => res({ err, stdout, stderr })
      );
    });

    if (compile.stdout) appendCConsole(compile.stdout);
    if (compile.stderr) appendCConsole(compile.stderr);
    if (compile.err) { setCStatus("Compile error"); return; }

    appendCConsole("\n> running...\n");
    setCStatus("Running...");
    setCRunning(true);

    const { spawn: spawnC } = nodeRequire("child_process");
    const p = spawnC(exePath, [], { cwd: userDataPath, windowsHide: true });
    cRunProcess = p;
    p.stdout.on("data", d => appendCConsole(String(d)));
    p.stderr.on("data", d => appendCConsole(String(d)));
    p.on("close", code => {
      cRunProcess = null;
      setCRunning(false);
      setCStatus(code === 0 ? "Done ✓" : "Runtime error");
    });
    if (stdinVal) p.stdin.write(stdinVal);
    p.stdin.end();
  });

  document.getElementById("saveCBtn").addEventListener("click", () => {
    if (!cEditor) return;
    const outDir = path.join(userDataPath, "Exam");
    fs.mkdirSync(outDir, { recursive: true });
    let max = 0;
    try {
      fs.readdirSync(outDir).forEach(f => {
        const m = /^solution_(\d+)/i.exec(f);
        if (m) max = Math.max(max, Number(m[1]));
      });
    } catch {}
    const filename = `solution_${max + 1}.c`;
    fs.writeFileSync(path.join(outDir, filename), cEditor.getValue(), "utf8");
    setCStatus("Saved: Exam/" + filename);
    refreshFileList();
  });

  // ════════════════════════════════════════════
  //  SQL ENGINE  (better-sqlite3 — sync API)
  // ════════════════════════════════════════════
  let sqlEditor = null;
  let sqlDb = null;
  const sqlResultsEl = document.getElementById("sqlResults");
  const sqlStatusEl  = document.getElementById("sqlStatus");

  function setSqlStatus(t) { sqlStatusEl.textContent = t; }

  function initSqlDb() {
    try {
      const Database = nodeRequire("better-sqlite3");
      const dbPath = path.join(sessionDir, ".run", "exam.db");
      try { fs.mkdirSync(path.join(sessionDir, ".run"), { recursive: true }); } catch {}
      sqlDb = new Database(dbPath);

      // Create default tables with sample data
      sqlDb.exec(`
        CREATE TABLE IF NOT EXISTS students (
          id      INTEGER PRIMARY KEY AUTOINCREMENT,
          name    TEXT    NOT NULL,
          grade   INTEGER,
          subject TEXT
        );
        CREATE TABLE IF NOT EXISTS scores (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          student_id INTEGER REFERENCES students(id),
          score      REAL,
          exam_date  TEXT
        );
      `);

      // Seed only if empty
      const count = sqlDb.prepare("SELECT COUNT(*) as n FROM students").get().n;
      if (count === 0) {
        sqlDb.exec(`
          INSERT INTO students (name, grade, subject) VALUES
            ('Alice',   10, 'Math'),
            ('Bob',     11, 'Science'),
            ('Charlie', 10, 'Math'),
            ('Diana',   12, 'English'),
            ('Evan',    11, 'Science');
          INSERT INTO scores (student_id, score, exam_date) VALUES
            (1, 92.5, '2024-01-15'),
            (2, 88.0, '2024-01-15'),
            (3, 75.5, '2024-01-15'),
            (4, 95.0, '2024-01-15'),
            (5, 83.0, '2024-01-15');
        `);
      }
      setSqlStatus("DB ready ✓");
    } catch (e) {
      setSqlStatus("DB error: " + e.message);
      sqlResultsEl.innerHTML = `<div class="sql-error">Could not load better-sqlite3.\nRun: npm install better-sqlite3\n\n${e.message}</div>`;
    }
  }

  function renderSqlResults(rows, info) {
    if (!rows || rows.length === 0) {
      sqlResultsEl.innerHTML = `<div class="sql-ok">${info || "Query executed. No rows returned."}</div>`;
      return;
    }
    const cols = Object.keys(rows[0]);
    const ths  = cols.map(c => `<th>${escHtml(c)}</th>`).join("");
    const trs  = rows.map(row =>
      `<tr>${cols.map(c => `<td>${escHtml(String(row[c] ?? "NULL"))}</td>`).join("")}</tr>`
    ).join("");
    sqlResultsEl.innerHTML =
      `<div class="sql-ok" style="margin-bottom:6px;">${rows.length} row${rows.length !== 1 ? "s" : ""}</div>` +
      `<table class="sql-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
  }

  function escHtml(s) {
    return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  function runSqlQuery() {
    if (!sqlDb) { setSqlStatus("DB not ready"); return; }
    const query = sqlEditor ? sqlEditor.getValue().trim() : "";
    if (!query) return;

    setSqlStatus("Running…");
    try {
      // Support multiple statements — split on semicolons, run each
      const stmts = query.split(";").map(s => s.trim()).filter(Boolean);
      let lastRows = null;
      let lastInfo = "";
      for (const stmt of stmts) {
        const upper = stmt.toUpperCase().trimStart();
        if (upper.startsWith("SELECT") || upper.startsWith("PRAGMA") || upper.startsWith("WITH")) {
          lastRows = sqlDb.prepare(stmt).all();
          lastInfo = "";
        } else {
          const info = sqlDb.prepare(stmt).run();
          lastRows = null;
          lastInfo = `OK — ${info.changes} row(s) affected. Last insert ID: ${info.lastInsertRowid}`;
        }
      }
      renderSqlResults(lastRows, lastInfo);
      setSqlStatus("Done ✓");
    } catch (e) {
      sqlResultsEl.innerHTML = `<div class="sql-error">Error: ${escHtml(e.message)}</div>`;
      setSqlStatus("Error");
    }
  }

  function resetSqlDb() {
    try {
      if (sqlDb) { sqlDb.close(); sqlDb = null; }
      const dbPath = path.join(sessionDir, ".run", "exam.db");
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      sqlResultsEl.innerHTML = `<span style="opacity:0.35;">DB reset. Run a query to begin.</span>`;
      initSqlDb();
    } catch (e) { setSqlStatus("Reset failed: " + e.message); }
  }

  document.getElementById("runSqlBtn").addEventListener("click",   runSqlQuery);
  document.getElementById("clearSqlBtn").addEventListener("click", () => {
    sqlResultsEl.innerHTML = `<span style="opacity:0.35;">Cleared.</span>`;
    setSqlStatus("");
  });
  document.getElementById("resetSqlBtn").addEventListener("click", resetSqlDb);

  // ── Monaco setup ──
  const { pathToFileURL } = nodeRequire("url");
  const isPackaged = (typeof appRoot === "string" && appRoot.includes("app.asar"));
  const vsPath = isPackaged
    ? path.join(process.resourcesPath, "monaco-editor", "min", "vs")
    : path.join(appRoot, "node_modules", "monaco-editor", "min", "vs");

  // Debug: verify runtime paths in the packaged EXE.
  console.log("[Monaco] appRoot:", appRoot);
  console.log("[Monaco] isPackaged:", isPackaged);
  console.log("[Monaco] resourcesPath:", process && process.resourcesPath);
  const vsUrl  = pathToFileURL(vsPath).toString();
  const workerMainFsPath = path.join(vsPath, "base", "worker", "workerMain.js");
  const workerMainUrl = pathToFileURL(workerMainFsPath).toString();

  const loaderFsPath = path.join(vsPath, "loader.js");
  const monacoCssFsPath = path.join(vsPath, "editor", "editor.main.css");

  console.log("[Monaco] vsPath:", vsPath);
  console.log("[Monaco] loader.js fs exists:", fs.existsSync(loaderFsPath), loaderFsPath);
  console.log("[Monaco] editor.main.css fs exists:", fs.existsSync(monacoCssFsPath), monacoCssFsPath);
  console.log("[Monaco] workerMain.js fs exists:", fs.existsSync(workerMainFsPath), workerMainFsPath);

  // Ensure Monaco CSS is loaded from unpacked files (needed in packaged EXE).
  const monacoCssUrl = pathToFileURL(monacoCssFsPath).toString();
  const monacoCssEl = document.getElementById("monaco-editor-css") || (() => {
    const l = document.createElement("link");
    l.id = "monaco-editor-css";
    l.rel = "stylesheet";
    document.head.appendChild(l);
    return l;
  })();
  monacoCssEl.href = monacoCssUrl;

  // Monaco's AMD loader must be loaded before `require.config(...)`.
  const monacoLoaderUrl = pathToFileURL(path.join(vsPath, "loader.js")).toString();
  async function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = (e) => reject(e);
      document.head.appendChild(s);
    });
  }
  try {
    if (!(window.require && typeof window.require.config === "function")) {
      console.log("[Monaco] Loading loader.js:", monacoLoaderUrl);
      await loadScript(monacoLoaderUrl);
    }
    console.log("[Monaco] Monaco AMD require loaded:", !!window.require, typeof window.require?.config);
  } catch (e) {
    console.error("[Monaco] Failed to load Monaco loader.js:", e);
    setStatus("Monaco loader failed: " + (e && (e.message || e.toString())));
    throw e;
  }

  // Monaco calls this to create the worker script URL.
  // We log once so we can verify it is pointing to `app.asar.unpacked` via file://.
  let monacoWorkerDebugLogged = false;
  window.MonacoEnvironment = {
    getWorkerUrl() {
      const code = `self.MonacoEnvironment={baseUrl:"${vsUrl}/"};importScripts("${workerMainUrl}");`;
      if (!monacoWorkerDebugLogged) {
        monacoWorkerDebugLogged = true;
        console.log("[Monaco] getWorkerUrl():", { vsUrl, workerMainUrl });
      }
      return `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;
    }
  };

  try {
    require.config({ paths: { vs: vsUrl }, preferScriptTags: true });
  } catch (e) {
    console.error("[Monaco] require.config failed:", e);
    setStatus("Monaco require.config failed: " + (e && (e.message || e.toString())));
    throw e;
  }

  require(["vs/editor/editor.main"], () => {
    // Init C++ editor
    cppEditor = monaco.editor.create(document.getElementById("cppEditor"), {
      value: `#include <iostream>\nusing namespace std;\n\nint main() {\n    cout << "Hello, World!" << endl;\n    return 0;\n}`,
      language: "cpp",
      theme: "vs-dark",
      minimap: { enabled: false },
      automaticLayout: true,
      fontSize: 13,
    });

    // Init C editor
    cEditor = monaco.editor.create(document.getElementById("cEditor"), {
      value: `#include <stdio.h>\n\nint main() {\n    printf("Hello, World!\\n");\n    return 0;\n}`,
      language: "c",
      theme: "vs-dark",
      minimap: { enabled: false },
      automaticLayout: true,
      fontSize: 13,
    });

    // Init SQL editor
    sqlEditor = monaco.editor.create(document.getElementById("sqlEditor"), {
      value: `-- Default tables: students, scores\n-- Try: SELECT * FROM students;\n\nSELECT s.name, s.subject, sc.score\nFROM students s\nJOIN scores sc ON sc.student_id = s.id\nORDER BY sc.score DESC;`,
      language: "sql",
      theme: "vs-dark",
      minimap: { enabled: false },
      automaticLayout: true,
      fontSize: 13,
      lineNumbers: "on",
      wordWrap: "on",
    });

    // Shift+Enter runs the SQL query
    sqlEditor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, runSqlQuery);

    // Init SQLite DB
    initSqlDb();

    // Create first Python cell
    createCell('# Welcome! pip install works here too.\n# e.g.: pip install requests\nprint("Hello from notebook!")');

    // Apply initial language (default C++)
    applyLang(langSelect.value);
    refreshFileList();
    // Restore persisted PDF if one was uploaded in a previous session
    loadSavedPdf();
    setStatus("Ready");
    initPanelSizes();
    layoutAllEditors();
    // Ensure we capture the final container width after kiosk/fullscreen settles.
    requestAnimationFrame(() => {
      initPanelSizes();
      layoutAllEditors();
    });
  }, err => setStatus("Monaco failed: " + (err && (err.message || err.toString()))));

  // ════════════════════════════════════════════
  //  Resizable Panels
  // ════════════════════════════════════════════
  const MIN_PANEL_W = 220;

  function initPanelSizes() {
    const content  = document.getElementById("contentArea");
    const pdfPanel = document.getElementById("pdfPanel");
    const edPanel  = document.getElementById("editorPanel");
    const totalW   = content.clientWidth - document.getElementById("dividerCol").offsetWidth - 8;
    const half     = Math.floor(totalW / 2);
    pdfPanel.style.width = half + "px";
    edPanel.style.width  = (totalW - half) + "px";
  }

  // ── Horizontal divider (PDF ↔ Notebook) ──
  (function () {
    const divider  = document.getElementById("dividerCol");
    const content  = document.getElementById("contentArea");
    const pdfPanel = document.getElementById("pdfPanel");
    const edPanel  = document.getElementById("editorPanel");
    let dragging = false, startX = 0, startPdfW = 0, startEdW = 0;

    divider.addEventListener("mousedown", (e) => {
      dragging  = true;
      startX    = e.clientX;
      startPdfW = pdfPanel.offsetWidth;
      startEdW  = edPanel.offsetWidth;
      divider.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx      = e.clientX - startX;
      const newPdfW = startPdfW + dx;
      const newEdW  = startEdW  - dx;
      if (newPdfW < MIN_PANEL_W || newEdW < MIN_PANEL_W) return;
      pdfPanel.style.width = newPdfW + "px";
      edPanel.style.width  = newEdW  + "px";
      layoutAllEditors();
    });

    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      divider.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      layoutAllEditors();
    });
  })();

  function layoutAllEditors() {
    if (cppEditor) cppEditor.layout();
    if (cEditor)   cEditor.layout();
    if (sqlEditor) sqlEditor.layout();
    cells.forEach(c => c.editor.layout());
  }

  // Re-init on window resize
  window.addEventListener("resize", () => {
    // If the divider is being dragged, don't overwrite the user sizing.
    try {
      if (document.body && document.body.style && document.body.style.cursor === "col-resize") return;
    } catch (_) {}
    initPanelSizes();
    layoutAllEditors();
  });

  // ════════════════════════════════════════════
  //  EVALUATION MODAL
  // ════════════════════════════════════════════
  function swFormatEval(s) {
    const h = String(Math.floor(s / 3600)).padStart(2, "0");
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const sec = String(s % 60).padStart(2, "0");
    return `${h}:${m}:${sec}`;
  }

  function openEvaluationModal() {
    // Read session status
    let sessionStatus = "running";
    try {
      const sf = path.join(userDataPath, "session.json");
      if (fs.existsSync(sf)) {
        const p = JSON.parse(fs.readFileSync(sf, "utf8"));
        if (p && p.status) sessionStatus = p.status;
      }
    } catch {}

    const isEvaluated = sessionStatus === "evaluated";

    // Update evaluate button color in top bar
    const evalBtn = document.getElementById("evaluateBtn");
    if (isEvaluated) {
      evalBtn.classList.add("evaluated");
      evalBtn.textContent = "✓ Evaluated";
    } else {
      evalBtn.classList.remove("evaluated");
      evalBtn.textContent = "Evaluate";
    }

    // Header badge
    const badge = document.getElementById("evalStatusBadge");
    if (isEvaluated) {
      badge.textContent = "✅ Evaluated";
      badge.classList.add("evaluated");
    } else {
      badge.textContent = "🟡 Running";
      badge.classList.remove("evaluated");
    }

    // Stats
    document.getElementById("evalStatSwitches").textContent = tamperCount;
    document.getElementById("evalStatStatus").textContent   = isEvaluated ? "Evaluated" : "Running";
    document.getElementById("evalStatStatus").style.color   = isEvaluated ? "#86efac" : "#f6ad55";

    // Away time — snapshot current away duration if user is away right now
    const currentAwayExtra = isAway && awayStartTime
      ? Math.floor((Date.now() - awayStartTime) / 1000)
      : 0;
    document.getElementById("evalStatAwayTime").textContent = swFormatEval(totalAwayTime + currentAwayExtra);

    // Mark button state
    const markBtn = document.getElementById("markEvaluatedBtn");
    if (isEvaluated) {
      markBtn.textContent = "✓ Evaluated";
      markBtn.disabled = true;
      markBtn.style.background = "linear-gradient(135deg, #1a3a2a, #0f2018)";
    } else {
      markBtn.textContent = "✓ Mark as Evaluated";
      markBtn.disabled = false;
      markBtn.style.background = "";
    }

    // Show/hide Upload to Classroom — only visible once session is evaluated
    document.getElementById("uploadClassroomBtn")
      .classList.toggle("visible", isEvaluated);

    // Uploaded files
    const evalFileList = document.getElementById("evalFileList");
    const fileItems = [];
    if (currentPdfName) fileItems.push({ icon: "📄", name: currentPdfName, size: "" });
    try {
      const inputDir = path.join(userDataPath, "inputs");
      if (fs.existsSync(inputDir)) {
        fs.readdirSync(inputDir)
          .filter(f => /\.(csv|txt)$/i.test(f))
          .sort((a, b) => a.localeCompare(b))
          .forEach(f => {
            let size = "";
            try {
              const bytes = fs.statSync(path.join(inputDir, f)).size;
              size = bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes/1024).toFixed(1)} KB` : `${(bytes/1048576).toFixed(1)} MB`;
            } catch {}
            fileItems.push({ icon: f.endsWith(".csv") ? "📊" : "📃", name: f, size });
          });
      }
    } catch {}

    document.getElementById("evalStatUploads").textContent = fileItems.length;
    evalFileList.innerHTML = fileItems.length === 0
      ? `<div class="eval-empty-note">No files uploaded during this session.</div>`
      : fileItems.map(f => `<div class="eval-file-item"><span class="eval-file-icon">${f.icon}</span><span class="eval-file-name" title="${f.name}">${f.name}</span>${f.size ? `<span class="eval-file-size">${f.size}</span>` : ""}</div>`).join("");

    document.getElementById("evaluationModal").classList.add("show");
  }

  document.getElementById("evaluateBtn").addEventListener("click", openEvaluationModal);

  document.getElementById("closeEvalBtn").addEventListener("click", () => {
    document.getElementById("evaluationModal").classList.remove("show");
  });

  document.getElementById("markEvaluatedBtn").addEventListener("click", () => {
    try {
      const sf = path.join(userDataPath, "session.json");
      const cur = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, "utf8")) : {};
      fs.writeFileSync(sf, JSON.stringify({ ...cur, status: "evaluated" }, null, 2), "utf8");
    } catch {}

    // Delete tamper.json so count resets on next session
    try {
      const tamperFile = path.join(userDataPath, "tamper.json");
      if (fs.existsSync(tamperFile)) fs.unlinkSync(tamperFile);
    } catch {}
    tamperCount = 0;

    // Delete away.json so away time resets on next session
    try {
      const awayFile = path.join(userDataPath, "away.json");
      if (fs.existsSync(awayFile)) fs.unlinkSync(awayFile);
    } catch {}
    totalAwayTime = 0;

    logEvent("SESSION MARKED AS EVALUATED");

    // ── Remove persisted PDF and restore upload button ──
    try {
      if (fs.existsSync(pdfSavePath)) fs.unlinkSync(pdfSavePath);
    } catch {}
    try {
      if (fs.existsSync(pdfMetaPath)) fs.unlinkSync(pdfMetaPath);
    } catch {}
    // Revoke blob URL and clear the iframe
    if (currentPdfUrl) { URL.revokeObjectURL(currentPdfUrl); currentPdfUrl = null; }
    currentPdfName = null;
    frame.src = "";
    setPdfStatus("No PDF loaded");
    // Show the upload button again
    uploadBtn.style.display = "";
    input.style.display     = "";

    document.getElementById("evaluationModal").classList.remove("show");
    openEvaluationModal();
  });

  document.getElementById("evaluationModal").addEventListener("click", (e) => {
    if (e.target === document.getElementById("evaluationModal"))
      document.getElementById("evaluationModal").classList.remove("show");
  });

  // ── Upload to Classroom ──────────────────────────────────────────────────
  // 1. Opens a student-info popup to collect name + enroll no.
  // 2. Passes that info to the main process for PDF naming & title.
  // Main process also calls shell.openExternal after a successful save.
  // ─────────────────────────────────────────────────────────────────────
  (function () {
    const btn          = document.getElementById("uploadClassroomBtn");
    const modal        = document.getElementById("studentInfoModal");
    const nameInput    = document.getElementById("studentNameInput");
    const enrollInput  = document.getElementById("studentEnrollInput");
    const confirmBtn   = document.getElementById("studentInfoConfirmBtn");
    const cancelBtn    = document.getElementById("studentInfoCancelBtn");

    // Enable confirm only when both fields are non-empty
    function validateFields() {
      const ok = nameInput.value.trim().length > 0 && enrollInput.value.trim().length > 0;
      confirmBtn.disabled = !ok;
    }
    nameInput.addEventListener("input", validateFields);
    enrollInput.addEventListener("input", validateFields);

    // Allow pressing Enter in either field to submit when valid
    [nameInput, enrollInput].forEach(inp => {
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !confirmBtn.disabled) confirmBtn.click();
      });
    });

    // Open popup on button click
    btn.addEventListener("click", () => {
      nameInput.value   = "";
      enrollInput.value = "";
      confirmBtn.disabled  = true;
      confirmBtn.textContent = "Generate & Upload";
      // Clear any previous error message
      const errBox = document.getElementById("studentInfoError");
      if (errBox) errBox.style.display = "none";
      modal.classList.add("show");
      setTimeout(() => nameInput.focus(), 80);
    });

    // Cancel — close popup, do nothing
    cancelBtn.addEventListener("click", () => {
      modal.classList.remove("show");
    });

    // Close on backdrop click
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.classList.remove("show");
    });

    // Confirm — generate PDF with student info
    confirmBtn.addEventListener("click", async () => {
      const studentName  = nameInput.value.trim();
      const enrollNo     = enrollInput.value.trim();

      // Build a safe filename: EnrollNo_Name.pdf  (spaces → underscores)
      const safeName     = studentName.replace(/\s+/g, "_").replace(/[^\w\-]/g, "");
      const safeEnroll   = enrollNo.replace(/[^\w\-]/g, "");
      const pdfFilename  = `${safeEnroll}_${safeName}.pdf`;

      // ── Lock the form while the IPC call is in-flight ──
      // Do NOT close the modal yet — keep it open so the user can retry on failure.
      confirmBtn.disabled  = true;
      cancelBtn.disabled   = true;
      nameInput.disabled   = true;
      enrollInput.disabled = true;
      confirmBtn.textContent = "⏳ Generating…";

      let result;
      try {
        result = await ipcRenderer.invoke("generate-submission-pdf", {
          examDir:      path.join(userDataPath, "Exam"),
          studentName,
          enrollNo,
          pdfFilename,
        });
      } catch (err) {
        result = { success: false, error: err && err.message ? err.message : String(err) };
      }

      // ── Always unlock the form first ──
      nameInput.disabled   = false;
      enrollInput.disabled = false;
      cancelBtn.disabled   = false;
      confirmBtn.textContent = "Generate & Upload";

      if (result.success) {
        // Close modal only on success
        modal.classList.remove("show");
        btn.disabled    = true;
        btn.textContent = "✅ PDF Saved — Opening Classroom…";
        logEvent("SUBMISSION PDF saved: " + result.pdfPath);
        setTimeout(() => {
          btn.disabled    = false;
          btn.textContent = "🎓 Upload to Classroom";
        }, 4000);
      } else {
        // Keep modal open — re-enable confirm so they can fix & retry
        confirmBtn.disabled = false;
        // Show a non-blocking error inside the modal instead of a freezing alert()
        let errBox = document.getElementById("studentInfoError");
        if (!errBox) {
          errBox = document.createElement("div");
          errBox.id = "studentInfoError";
          errBox.style.cssText = [
            "margin: 0 24px 12px",
            "padding: 10px 13px",
            "border-radius: 9px",
            "font-size: 12px",
            "line-height: 1.5",
            "color: #fca5a5",
            "background: rgba(239,68,68,0.10)",
            "border: 1px solid rgba(239,68,68,0.28)",
          ].join(";");
          // Insert before the footer
          const footer = document.querySelector(".student-dialog-footer");
          footer.parentNode.insertBefore(errBox, footer);
        }
        errBox.textContent = "⚠ " + (result.error || "Unknown error — please try again.");
        errBox.style.display = "block";
        logEvent("SUBMISSION PDF error: " + result.error);
      }
    });
  }());

  // ── Editor vertical resize handles ──────────────────────────────────────
  // Each handle drags to resize the editor wrap above it.
  // For C++ and C the wrap uses flex:1, so we switch it to a fixed px height.
  // For SQL the wrap already has a fixed px height.
  function makeEditorResizable(handleEl, wrapEl, minH = 80, maxH = 1200) {
    let dragging = false;
    let startY = 0;
    let startH = 0;

    handleEl.addEventListener("mousedown", (e) => {
      e.preventDefault();
      dragging = true;
      startY = e.clientY;
      startH = wrapEl.getBoundingClientRect().height;
      handleEl.classList.add("dragging");

      // Freeze the wrap at its current pixel height so flex doesn't fight us
      wrapEl.style.flex    = "none";
      wrapEl.style.height  = startH + "px";

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup",   onUp);
    });

    function onMove(e) {
      if (!dragging) return;
      const delta  = e.clientY - startY;
      const newH   = Math.min(maxH, Math.max(minH, startH + delta));
      wrapEl.style.height = newH + "px";

      // Tell Monaco to re-layout
      if (wrapEl._monacoEditor) {
        wrapEl._monacoEditor.layout();
      }
    }

    function onUp() {
      dragging = false;
      handleEl.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup",   onUp);
    }
  }

  // Wire up each editor — we attach the Monaco instance reference once editors are ready.
  // The handles themselves work purely on DOM height; Monaco picks it up via ResizeObserver too.
  makeEditorResizable(
    document.getElementById("cppEditorResizeHandle"),
    document.getElementById("cppEditorWrap")
  );
  makeEditorResizable(
    document.getElementById("cEditorResizeHandle"),
    document.getElementById("cEditorWrap")
  );
  makeEditorResizable(
    document.getElementById("sqlEditorResizeHandle"),
    document.getElementById("sqlEditorWrap"),
    60, 800
  );
  // ────────────────────────────────────────────────────────────────────────

  })();

const pdfInput = document.getElementById("pdfInput");
const pdfFrame = document.getElementById("pdfFrame");
const placeholder = document.getElementById("pdfPlaceholder");

pdfInput.addEventListener("change", () => {
  const file = pdfInput.files[0];
  if (!file) return;

  const url = URL.createObjectURL(file);
  pdfFrame.src = url;

  // Hide placeholder
  placeholder.classList.add("hidden");
});