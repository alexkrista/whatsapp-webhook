// pdf.js (ESM)
import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import sharp from "sharp";

export async function buildPdfA3Landscape({ title, items, outPath }) {
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });

  const doc = new PDFDocument({
    size: "A3",
    layout: "landscape",
    margin: 28
  });

  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  // Titel
  doc.fontSize(20).text(title, { align: "left" });
  doc.moveDown(0.6);
  doc.fontSize(10).fillColor("#444").text(`Erstellt: ${new Date().toLocaleString()}`);
  doc.fillColor("#000");
  doc.moveDown(1);

  // Layout: 6 Fotos pro Seite (3x2)
  const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const pageH = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;

  const cols = 3;
  const rows = 2;
  const gap = 14;

  const cellW = (pageW - gap * (cols - 1)) / cols;
  const cellH = (pageH - 120 - gap * (rows - 1)) / rows; // oben Platz für Textblock

  let photoIndexOnPage = 0;

  const startNewPageIfNeeded = () => {
    if (photoIndexOnPage === 0) return;
    if (photoIndexOnPage >= 6) {
      doc.addPage();
      photoIndexOnPage = 0;
    }
  };

  // Textblock (chronologisch)
  doc.fontSize(11).text("Protokoll (Text):", { underline: true });
  doc.moveDown(0.3);
  doc.fontSize(10);
  for (const it of items) {
    if (it.type === "text") {
      doc.text(`• ${it.when}  ${it.from}: ${it.text}`);
    }
  }
  doc.moveDown(0.8);

  // Fotos
  const photos = items.filter((x) => x.type === "image");
  if (photos.length) {
    doc.fontSize(11).text("Fotos:", { underline: true });
    doc.moveDown(0.4);
  }

  for (const p of photos) {
    startNewPageIfNeeded();

    const col = photoIndexOnPage % cols;
    const row = Math.floor(photoIndexOnPage / cols);

    const x = doc.page.margins.left + col * (cellW + gap);
    const yBase = doc.y + row * (cellH + gap);

    // Bild in "contain" (nicht verzerren)
    // Wir rendern auf eine moderate Breite, damit PDF klein bleibt.
    const imgBuf = await sharp(p.filePath)
      .rotate()
      .resize({
        width: Math.floor(cellW * 1.2), // etwas Reserve
        height: Math.floor(cellH * 1.2),
        fit: "inside",
        withoutEnlargement: true
      })
      .jpeg({ quality: 72 }) // PDF klein halten
      .toBuffer();

    // Bild platzieren
    doc.image(imgBuf, x, yBase, { fit: [cellW, cellH], align: "center", valign: "center" });

    // Dateiname darunter
    doc.fontSize(8).fillColor("#333").text(p.fileName, x, yBase + cellH + 4, {
      width: cellW,
      align: "center"
    });
    doc.fillColor("#000");

    photoIndexOnPage += 1;

    // Wenn 3 Bilder in einer Reihe fertig sind, Cursor nicht verschieben lassen – wir arbeiten mit yBase.
    // Am Ende der 2 Reihen setzen wir doc.y passend.
    if (photoIndexOnPage % 6 === 0) {
      doc.moveDown(0.5);
    }
  }

  doc.end();

  await new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  return outPath;
}
