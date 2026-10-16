import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.resolve("node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs")).href;

const data = new Uint8Array(fs.readFileSync("../backend/tests/fixtures/layout_geo.pdf"));
const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
console.log("pages:", doc.numPages);
const page = await doc.getPage(1);
console.log("viewport:", JSON.stringify(page.getViewport({ scale: 1 })));

const opList = await page.getOperatorList();
const OPS = pdfjs.OPS;
const nameOf = {};
for (const [k, v] of Object.entries(OPS)) nameOf[v] = k;
console.log("total ops:", opList.fnArray.length);
const hist = {};
for (const fn of opList.fnArray) hist[nameOf[fn]] = (hist[nameOf[fn]] || 0) + 1;
console.log("op histogram:", hist);

for (let i = 0; i < opList.fnArray.length && i < 400; i++) {
  const fn = opList.fnArray[i];
  const n = nameOf[fn];
  if (["constructPath", "fill", "stroke", "fillStroke", "eoFill", "setFillRGBColor", "setStrokeRGBColor", "setFillGray", "setStrokeGray", "transform", "save", "restore", "setLineWidth", "setDash", "paintFormXObjectBegin", "paintFormXObjectEnd"].includes(n)) {
    const a = opList.argsArray[i];
    const brief = JSON.stringify(a).slice(0, 200);
    console.log(i, n, brief);
  }
  if (i > 60) break;
}

const tc = await page.getTextContent();
console.log("text items:", tc.items.length);
for (const it of tc.items.slice(0, 5)) {
  console.log("TEXT ITEM:", JSON.stringify({ str: it.str, transform: it.transform, width: it.width, height: it.height, fontName: it.fontName }));
}
