import fs from "node:fs";
import DxfParser from "dxf-parser";

const data = fs.readFileSync("../backend/tests/fixtures/layout_latlng.dxf", "utf8");
const dxf = new DxfParser().parseSync(data);
console.log("header INSUNITS:", dxf.header?.["$INSUNITS"]);
const ents = dxf.entities;
const types = {};
for (const e of ents) types[e.type] = (types[e.type] || 0) + 1;
console.log("types:", types);
console.log("first entity keys:", Object.keys(ents[0]));
console.log("sample LWPOLYLINE:", JSON.stringify({ layer: ents[0].layer, closed: ents[0].closed, shape: ents[0].shape, n: ents[0].vertices?.length, v0: ents[0].vertices?.[0], v1: ents[0].vertices?.[1] }));
const txt = ents.find((e) => e.type === "TEXT");
console.log("sample TEXT:", JSON.stringify({ layer: txt.layer, text: txt.text, startPoint: txt.startPoint, height: txt.height }));
const lwp = ents.filter((e) => e.type === "LWPOLYLINE");
console.log("lwpolyline sample layer/closed:", lwp.slice(0, 3).map((e) => ({ layer: e.layer, closed: e.closed })));
const ls = ents.find((e) => e.type === "LINE");
console.log("LINE sample:", ls ? JSON.stringify({ layer: ls.layer, v: ls.vertices }) : "none");
