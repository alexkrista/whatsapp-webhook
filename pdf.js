// pdf.js (ESM)
import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function listImages(dir) {
  if (!fs.existsSync(dir)) return [];
  const exts = new Set([".jpg", ".jpeg", ".png", ".webp"]);
  return fs
    .readdirSync(dir)
    .filter((f) => exts.has(path.extname(f).toLowerCase()))
    .map((f) => path.join(dir, f))
    .sort();
}

async function fitImageToJpegBuffer(file, maxW, maxH, quality = 70) {
  const img = sharp(file).rotate();
  const meta = await img.metadata();

  const scale = Math.min(maxW / (meta.width || maxW), maxH / (meta.height || maxH), 1);
  const w = Math.floor((meta.width || maxW) * scale);
  const h = Math.floor((meta.height || maxH) * scale);

  return await img.resize(w, h, { fit: "inside" }).jpeg({ quality }).toBuffer();
}

export async function buildPdfForSiteToday({ dataDir, site, tz }) {
  const date = dayjs().tz(tz).format("YYYY-MM-DD");
  const dayDir = path.join(dataDir, site, date);
  const outDir = path.join(dataDir, site, date);
  ensureDir(outDir);

  const outPath = path.join(outDir, `Baustellenprotokoll_${site}_${date}.pdf`);
  const images = listImages(dayDir);

  // A3 landscape: 420 x 297 mm
  const doc = new PDFDocument({ size: "A3", layout: "landscape", margin: 24 });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  // Title page
  doc.fontSize(28).text("Baustellenprotokoll", { align: "left" });
  doc.moveDown(0.5);
  doc.fontSize(18).text(`Baustelle #${site}`);
  doc.fontSize(14).text(`Datum: ${date}`);
  doc.moveDown(1);
  doc.fontSize(10).fillColor("#666").text("Automatisch erstellt.");
  doc.addPage();

  // Grid: 3x2
  const cols = 3;
  const rows = 2;
  const gap = 12;

  const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const pageH = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;

  const cellW = (pageW - gap * (cols - 1)) / cols;
  const cellH = (pageH - gap * (rows - 1)) / rows;

  const captionH = 16;
  const imgMaxW = cellW;
  const imgMaxH = cellH - captionH;

  let idx = 0;
  for (const file of images) {
    const pos = idx % (cols * rows);
    if (idx > 0 && pos === 0) doc.addPage();

    const r = Math.floor(pos / cols);
    const c = pos % cols;

    const x = doc.page.margins.left + c * (cellW + gap);
    const y = doc.page.margins.top + r * (cellH + gap);

    // image
    const buf = await fitImageToJpegBuffer(file, imgMaxW, imgMaxH, 70);
    doc.image(buf, x, y, { fit: [imgMaxW, imgMaxH], align: "center", valign: "center" });

    // caption = original filename
    const base = path.basename(file);
    doc
      .fontSize(9)
      .fillColor("#000")
      .text(base, x, y + imgMaxH + 2, { width: cellW, align: "center" });

    idx++;
  }

  if (images.length === 0) {
    doc.fontSize(14).text("Keine Bilder für heute gefunden.", { align: "left" });
  }

  doc.end();

  await new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  return outPath;
}

export async function buildDailyPdfs({ dataDir, tz, mailFn }) {
  // alle Baustellenordner durchgehen und für HEUTE erzeugen, wenn es Bilder gibt
  const date = dayjs().tz(tz).format("YYYY-MM-DD");
  const sites = fs.existsSync(dataDir)
    ? fs.readdirSync(dataDir).filter((d) => /^\d+$/.test(d))
    : [];

  const done = [];
  for (const site of sites) {
    const dayDir = path.join(dataDir, site, date);
    if (!fs.existsSync(dayDir)) continue;

    const imgs = listImages(dayDir);
    if (imgs.length === 0) continue;

    const pdf = await buildPdfForSiteToday({ dataDir, site, tz });
    if (mailFn) await mailFn(site, pdf);
    done.push({ site, pdf, images: imgs.length });
  }

  return { date, count: done.length, done };
}
