import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import PDFDocument from "pdfkit";
import sharp from "sharp";

const IMG_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function isImageFile(name) {
  return IMG_EXTS.has(path.extname(name).toLowerCase());
}

function sortByFilename(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

async function listImages(dayDir) {
  try {
    const files = await fsp.readdir(dayDir);
    return files.filter(isImageFile).sort(sortByFilename).map((f) => path.join(dayDir, f));
  } catch {
    return [];
  }
}

async function readLogLines(dayDir) {
  const logPath = path.join(dayDir, "log.jsonl");
  try {
    const txt = await fsp.readFile(logPath, "utf8");
    return txt
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Bild verkleinern + als JPEG in moderater Qualität (PDF klein halten)
async function toPdfJpegBuffer(filePath, maxW, maxH) {
  const img = sharp(filePath).rotate();
  const meta = await img.metadata();
  const w = meta.width || maxW;
  const h = meta.height || maxH;
  const scale = Math.min(maxW / w, maxH / h, 1);
  const nw = Math.max(1, Math.floor(w * scale));
  const nh = Math.max(1, Math.floor(h * scale));
  return await img
    .resize(nw, nh, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 72 })
    .toBuffer();
}

export async function buildDailyPdf({
  dataDir,
  code,
  day,          // "YYYY-MM-DD"
  outPath,
}) {
  const dayDir = path.join(dataDir, code, day);
  await fsp.mkdir(path.dirname(outPath), { recursive: true });

  const logLines = await readLogLines(dayDir);
  const images = await listImages(dayDir);

  const doc = new PDFDocument({ size: "A3", layout: "landscape", margin: 24 });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  // Deckblatt
  doc.fontSize(28).text("Baustellenprotokoll", { align: "left" });
  doc.moveDown(0.5);
  doc.fontSize(18).text(`Baustelle #${code}`);
  doc.fontSize(14).text(`Datum: ${day}`);
  doc.moveDown(1);
  doc.fontSize(10).fillColor("#666").text("Automatisch erstellt.");
  doc.fillColor("#000");

  // Textblock
  doc.moveDown(1);
  doc.fontSize(12).text("Protokoll (Text):", { underline: true });
  doc.moveDown(0.4);
  doc.fontSize(10);

  const texts = logLines.filter((x) => x.type === "text" && x.text);
  if (texts.length === 0) {
    doc.text("— (keine Textnachrichten) —");
  } else {
    for (const t of texts) {
      const time = t.timestamp ? new Date(Number(t.timestamp) * 1000).toLocaleTimeString() : "";
      doc.text(`• ${time}  ${t.from}: ${t.text}`);
    }
  }

  // Fotos
  doc.addPage();
  doc.fontSize(12).text("Fotos:", { underline: true });
  doc.moveDown(0.5);

  const cols = 3;
  const rows = 2;
  const gap = 14;

  const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const pageH = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;

  const cellW = (pageW - gap * (cols - 1)) / cols;
  const cellH = (pageH - gap * (rows - 1)) / rows;

  const captionH = 16;
  const imgMaxW = cellW;
  const imgMaxH = cellH - captionH;

  let i = 0;
  for (const imgPath of images) {
    const pos = i % (cols * rows);
    if (i > 0 && pos === 0) {
      doc.addPage();
      doc.fontSize(12).text("Fotos (Fortsetzung):", { underline: true });
      doc.moveDown(0.5);
    }

    const r = Math.floor(pos / cols);
    const c = pos % cols;

    const x = doc.page.margins.left + c * (cellW + gap);
    const y = doc.y + r * (cellH + gap);

    const buf = await toPdfJpegBuffer(imgPath, imgMaxW, imgMaxH);
    doc.image(buf, x, y, { fit: [imgMaxW, imgMaxH], align: "center", valign: "center" });

    const base = path.basename(imgPath);
    doc.fontSize(9).fillColor("#000").text(base, x, y + imgMaxH + 2, {
      width: cellW,
      align: "center",
    });

    i++;
  }

  if (images.length === 0) {
    doc.fontSize(12).text("— (keine Fotos) —");
  }

  doc.end();

  await new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  return { outPath, imageCount: images.length, textCount: texts.length };
}
