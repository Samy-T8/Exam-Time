"use strict";

/**
 * generate-submission-pdf.js
 * ─────────────────────────────────────────────────────────────────
 * Reads all student code files (.cpp / .c / .py) from the Exam
 * directory, generates a structured PDF, and saves it to the
 * Desktop as  student_submission_<timestamp>.pdf
 *
 * Called exclusively from the main process via IPC.
 * Returns: { success: true, pdfPath } | { success: false, error }
 * ─────────────────────────────────────────────────────────────────
 */

const fs   = require("fs");
const path = require("path");

// ── Constants ────────────────────────────────────────────────────
const CODE_EXTENSIONS   = new Set([".cpp", ".c", ".py"]);
const MAX_FILE_BYTES    = 500 * 1024;          // 500 KB per file — truncate beyond this
const MAX_TOTAL_FILES   = 50;                  // safety cap
const TRUNCATION_NOTE   = "\n\n[... File truncated — content exceeded 500 KB ...]\n";

// ── Language label map ───────────────────────────────────────────
const LANG_LABEL = { ".cpp": "C++", ".c": "C", ".py": "Python" };

// ── Helper: collect & validate code files ───────────────────────
function collectCodeFiles(examDir) {
  if (!fs.existsSync(examDir)) {
    return { files: [], warning: null };
  }

  let entries;
  try {
    entries = fs.readdirSync(examDir);
  } catch (err) {
    throw new Error(`Cannot read Exam directory: ${err.message}`);
  }

  const codeFiles = entries
    .filter(name => {
      const ext = path.extname(name).toLowerCase();
      return CODE_EXTENSIONS.has(ext);
    })
    .sort()                    // deterministic order
    .slice(0, MAX_TOTAL_FILES);

  const result = [];

  for (const name of codeFiles) {
    const filePath = path.join(examDir, name);
    const ext      = path.extname(name).toLowerCase();
    let content    = "";
    let truncated  = false;

    try {
      const stat = fs.statSync(filePath);

      if (stat.size === 0) {
        content = "(empty file)";
      } else if (stat.size > MAX_FILE_BYTES) {
        // Read only up to the limit
        const fd  = fs.openSync(filePath, "r");
        const buf = Buffer.alloc(MAX_FILE_BYTES);
        fs.readSync(fd, buf, 0, MAX_FILE_BYTES, 0);
        fs.closeSync(fd);
        content   = buf.toString("utf8") + TRUNCATION_NOTE;
        truncated = true;
      } else {
        content = fs.readFileSync(filePath, "utf8");
      }
    } catch (err) {
      content = `(Could not read file: ${err.message})`;
    }

    result.push({
      name,
      ext,
      lang:     LANG_LABEL[ext] || ext.slice(1).toUpperCase(),
      content,
      truncated,
    });
  }

  return { files: result, warning: null };
}

// ── Helper: resolve Desktop path cross-platform ──────────────────
function desktopPath(app) {
  try {
    return app.getPath("desktop");
  } catch {
    // Fallback for edge cases
    return require("os").homedir();
  }
}

// ── Helper: sanitise text for PDF (remove null bytes, normalise line endings) ──
function sanitise(text) {
  return text
    .replace(/\x00/g, "")          // strip null bytes — PDFKit chokes on them
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

// ── Main export ──────────────────────────────────────────────────
/**
 * @param {object} opts
 * @param {string} opts.examDir        – absolute path to the Exam folder
 * @param {object} opts.app            – Electron app object (for getPath)
 * @param {string} [opts.studentName]  – student's full name (from popup)
 * @param {string} [opts.enrollNo]     – student's enrollment number (from popup)
 * @param {string} [opts.pdfFilename]  – custom filename e.g. "2021CS1234_Rahul.pdf"
 * @returns {Promise<{success: boolean, pdfPath?: string, error?: string}>}
 */
async function generateSubmissionPdf({ examDir, app, studentName, enrollNo, pdfFilename }) {
  // ── 1. Collect files ─────────────────────────────────────────
  let files;
  try {
    ({ files } = collectCodeFiles(examDir));
  } catch (err) {
    return { success: false, error: err.message };
  }

  if (files.length === 0) {
    return {
      success: false,
      error:   "No code files found in the Exam folder (.cpp / .c / .py). Nothing to upload.",
    };
  }

  // ── 2. Resolve output path ───────────────────────────────────
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);                 // e.g. 2025-06-10_14-32-05

  // Use student-named filename if provided, otherwise fall back to timestamp
  const filename   = pdfFilename || `student_submission_${timestamp}.pdf`;
  const outputPath = path.join(desktopPath(app), filename);

  // ── 3. Generate PDF ──────────────────────────────────────────
  try {
    await buildPdf({ files, outputPath, timestamp, studentName, enrollNo });
  } catch (err) {
    return { success: false, error: `PDF generation failed: ${err.message}` };
  }

  return { success: true, pdfPath: outputPath };
}

// ── PDF builder ──────────────────────────────────────────────────
function buildPdf({ files, outputPath, timestamp, studentName, enrollNo }) {
  return new Promise((resolve, reject) => {
    let PDFDocument;
    try {
      PDFDocument = require("pdfkit");
    } catch {
      return reject(new Error(
        'PDFKit is not installed. Run:  npm install pdfkit'
      ));
    }

    const doc = new PDFDocument({
      size:    "A4",
      margins: { top: 50, bottom: 50, left: 60, right: 60 },
      info: {
        Title:   studentName ? `${enrollNo} – ${studentName}` : "Student Code Submission",
        Author:  studentName || "Exam Kiosk",
        Subject: "Student submission generated at " + timestamp,
      },
      bufferPages: true,          // lets us add page numbers after all content
    });

    // ── Stream to disk ──────────────────────────────────────────
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    stream.on("error", reject);
    stream.on("finish", resolve);

    // ── Colours & metrics ───────────────────────────────────────
    const C = {
      bg:          "#0b0f19",
      accent:      "#7dd3fc",
      headingText: "#ffffff",
      bodyText:    "#e6e9f2",
      codeBg:      "#141929",
      codeText:    "#c9d1d9",
      divider:     "#2d3748",
      muted:       "#8892a4",
      langTag:     "#86efac",
    };

    const PAGE_W    = doc.page.width;
    const PAGE_H    = doc.page.height;
    const MARGIN_L  = 60;
    const MARGIN_R  = 60;
    const CONTENT_W = PAGE_W - MARGIN_L - MARGIN_R;

    // ── Cover page ──────────────────────────────────────────────
    // Dark background rectangle
    doc.rect(0, 0, PAGE_W, PAGE_H).fill(C.bg);

    // Top accent bar
    doc.rect(0, 0, PAGE_W, 6).fill(C.accent);

    // Centre content vertically
    const coverY = PAGE_H / 2 - 100;

    doc.fillColor(C.accent)
       .fontSize(11)
       .font("Helvetica")
       .text("STUDENT CODE SUBMISSION", MARGIN_L, coverY, {
         width: CONTENT_W, align: "center", characterSpacing: 3,
       });

    doc.moveDown(0.6);

    // Title: use student name if provided, else generic
    const coverTitle = studentName ? studentName : "Exam Submission";
    doc.fillColor(C.headingText)
       .fontSize(28)
       .font("Helvetica-Bold")
       .text(coverTitle, MARGIN_L, null, {
         width: CONTENT_W, align: "center",
       });

    // Subtitle: show enroll no under the name
    if (enrollNo) {
      doc.moveDown(0.25);
      doc.fillColor(C.accent)
         .fontSize(13)
         .font("Helvetica")
         .text(enrollNo, MARGIN_L, null, {
           width: CONTENT_W, align: "center", characterSpacing: 1,
         });
    }

    doc.moveDown(0.5);

    // Divider line
    const divX = MARGIN_L + CONTENT_W * 0.25;
    doc.moveTo(divX, doc.y)
       .lineTo(divX + CONTENT_W * 0.5, doc.y)
       .strokeColor(C.accent)
       .lineWidth(1)
       .stroke();

    doc.moveDown(0.9);

    // ── Student info card ──────────────────────────────────────
    if (studentName || enrollNo) {
      const cardW = CONTENT_W * 0.62;
      const cardX = MARGIN_L + (CONTENT_W - cardW) / 2;
      const cardY = doc.y;
      const cardH = 72;

      doc.roundedRect(cardX, cardY, cardW, cardH, 10).fill(C.codeBg);
      // Left accent stripe
      doc.roundedRect(cardX, cardY, 4, cardH, 2).fill(C.accent);

      // Name row
      doc.fillColor(C.muted)
         .fontSize(9)
         .font("Helvetica")
         .text("STUDENT NAME", cardX + 18, cardY + 12, { width: cardW - 24 });
      doc.fillColor(C.headingText)
         .fontSize(15)
         .font("Helvetica-Bold")
         .text(studentName || "—", cardX + 18, cardY + 24, { width: cardW - 24 });

      // Enroll row
      doc.fillColor(C.muted)
         .fontSize(9)
         .font("Helvetica")
         .text("ENROLLMENT NO.", cardX + 18, cardY + 46, { width: cardW - 24 });
      doc.fillColor(C.accent)
         .fontSize(11)
         .font("Helvetica-Bold")
         .text(enrollNo || "—", cardX + 18, cardY + 57, { width: cardW - 24 });

      // Advance cursor past the card using a phantom text call at the right Y
      doc.text("", MARGIN_L, cardY + cardH + 14, { width: CONTENT_W });
    }

    doc.moveDown(0.5);

    doc.fillColor(C.muted)
       .fontSize(11)
       .font("Helvetica")
       .text(`Generated: ${new Date().toLocaleString()}`, MARGIN_L, null, {
         width: CONTENT_W, align: "center",
       });

    doc.moveDown(0.4);

    doc.fillColor(C.muted)
       .text(`Files included: ${files.length}`, MARGIN_L, null, {
         width: CONTENT_W, align: "center",
       });

    // File index on cover
    doc.moveDown(1.2);
    const indexStartX = MARGIN_L + CONTENT_W * 0.2;
    const indexW      = CONTENT_W * 0.6;

    // Index box background
    doc.roundedRect(indexStartX, doc.y, indexW, files.length * 22 + 20, 8)
       .fill(C.codeBg);

    let iy = doc.y + 10;
    files.forEach((f, i) => {
      doc.fillColor(C.accent)
         .fontSize(10)
         .font("Helvetica-Bold")
         .text(`${String(i + 1).padStart(2, "0")}. `, indexStartX + 14, iy, {
           continued: true, width: indexW - 28,
         })
         .fillColor(C.bodyText)
         .font("Helvetica")
         .text(f.name, { continued: true })
         .fillColor(C.langTag)
         .text(`  [${f.lang}]`);
      iy += 22;
    });

    // Bottom accent bar on cover
    doc.rect(0, PAGE_H - 6, PAGE_W, 6).fill(C.accent);

    // ── File pages ──────────────────────────────────────────────
    files.forEach((file, fileIndex) => {
      doc.addPage();

      // Dark background
      doc.rect(0, 0, PAGE_W, PAGE_H).fill(C.bg);

      // Top accent bar
      doc.rect(0, 0, PAGE_W, 4).fill(C.accent);

      let y = 50;

      // ── File header card ──────────────────────────────────────
      const headerH = 62;
      doc.roundedRect(MARGIN_L, y, CONTENT_W, headerH, 10)
         .fill(C.codeBg);

      // Left accent stripe inside header
      doc.roundedRect(MARGIN_L, y, 4, headerH, 2).fill(C.accent);

      // File number badge
      const badgeText = `${fileIndex + 1}/${files.length}`;
      doc.fillColor(C.accent)
         .fontSize(9)
         .font("Helvetica-Bold")
         .text(badgeText, MARGIN_L + 16, y + 10, { width: 60 });

      // Filename
      doc.fillColor(C.headingText)
         .fontSize(16)
         .font("Helvetica-Bold")
         .text(file.name, MARGIN_L + 16, y + 22, {
           width: CONTENT_W - 100,
         });

      // Language tag (top right of header)
      const tagW = 60;
      doc.roundedRect(MARGIN_L + CONTENT_W - tagW - 12, y + 18, tagW, 22, 5)
         .fill("#1a3a2a");
      doc.fillColor(C.langTag)
         .fontSize(10)
         .font("Helvetica-Bold")
         .text(file.lang, MARGIN_L + CONTENT_W - tagW - 12, y + 24, {
           width: tagW, align: "center",
         });

      y += headerH + 14;

      // ── Code block ───────────────────────────────────────────
      const lines       = sanitise(file.content).split("\n");
      const LINE_H      = 14;
      const CODE_FONT_S = 8.5;
      const PAD_V       = 14;
      const PAD_H       = 14;
      const LINE_NUM_W  = 30;

      // Estimate how many lines fit on this page from current y
      function remainingLines(currentY) {
        return Math.floor((PAGE_H - currentY - 50 - PAD_V * 2) / LINE_H);
      }

      let lineIdx = 0;

      while (lineIdx < lines.length) {
        const linesThisPage = Math.max(1, remainingLines(y));
        const chunk         = lines.slice(lineIdx, lineIdx + linesThisPage);
        const blockH        = chunk.length * LINE_H + PAD_V * 2;

        // Code block background
        doc.roundedRect(MARGIN_L, y, CONTENT_W, blockH, 8).fill(C.codeBg);

        // Line numbers gutter — slightly lighter strip
        doc.rect(MARGIN_L, y, LINE_NUM_W + PAD_H, blockH).fill("#1a2030");
        // Re-round just the left corners to match the outer rect
        doc.roundedRect(MARGIN_L, y, LINE_NUM_W + PAD_H, blockH, 8).fill("#1a2030");
        // Overlay right side of gutter square (cancel right rounding)
        doc.rect(MARGIN_L + LINE_NUM_W, y, PAD_H, blockH).fill("#1a2030");

        // Render lines
        chunk.forEach((line, i) => {
          const lineY    = y + PAD_V + i * LINE_H;
          const globalLN = lineIdx + i + 1;

          // Line number
          doc.fillColor(C.muted)
             .fontSize(CODE_FONT_S - 0.5)
             .font("Courier")
             .text(String(globalLN), MARGIN_L + 4, lineY, {
               width: LINE_NUM_W, align: "right", lineBreak: false,
             });

          // Code text — clamp to content width, no auto-wrap (monospace integrity)
          doc.fillColor(C.codeText)
             .fontSize(CODE_FONT_S)
             .font("Courier")
             .text(line, MARGIN_L + LINE_NUM_W + PAD_H + 4, lineY, {
               width:      CONTENT_W - LINE_NUM_W - PAD_H - 8,
               lineBreak:  false,
               ellipsis:   true,
             });
        });

        lineIdx += chunk.length;
        y += blockH + 8;

        // If more lines remain, start a new page
        if (lineIdx < lines.length) {
          doc.addPage();
          doc.rect(0, 0, PAGE_W, PAGE_H).fill(C.bg);
          doc.rect(0, 0, PAGE_W, 4).fill(C.accent);
          y = 50;

          // Continuation header (smaller)
          const contH = 36;
          doc.roundedRect(MARGIN_L, y, CONTENT_W, contH, 8).fill(C.codeBg);
          doc.roundedRect(MARGIN_L, y, 4, contH, 2).fill(C.accent);
          doc.fillColor(C.muted)
             .fontSize(9)
             .font("Helvetica")
             .text(`${file.name}  (continued)`, MARGIN_L + 14, y + 12, {
               width: CONTENT_W - 20,
             });
          y += contH + 10;
        }
      }

      // Truncation warning banner
      if (file.truncated) {
        doc.roundedRect(MARGIN_L, y, CONTENT_W, 28, 6).fill("#3b1f00");
        doc.fillColor("#f6ad55")
           .fontSize(9)
           .font("Helvetica-Bold")
           .text(
             "⚠  File was truncated — content exceeded 500 KB limit",
             MARGIN_L + 10, y + 9,
             { width: CONTENT_W - 20 }
           );
        y += 36;
      }
    });

    // ── Page numbers (added after all pages are buffered) ────────
    const totalPages = doc.bufferedPageRange().count;
    for (let i = 0; i < totalPages; i++) {
      doc.switchToPage(i);
      // Skip cover page (page 0)
      if (i === 0) continue;
      doc.fillColor(C.muted)
         .fontSize(8)
         .font("Helvetica")
         .text(
           `Page ${i + 1} of ${totalPages}`,
           MARGIN_L,
           PAGE_H - 34,
           { width: CONTENT_W, align: "center" }
         );
    }

    doc.flushPages();
    doc.end();
  });
}

module.exports = { generateSubmissionPdf };