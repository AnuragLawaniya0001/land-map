import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import storage, {
  initStorage,
  putObject,
  getObject,
  exists,
  deleteObject,
  safeJoin,
  sanitizeFilename,
  buildStorageKey,
  validatePdfBuffer,
  createTempFile,
  deleteTempFile,
} from "../storage.js";
import { config } from "../config.js";

describe("Unified Storage Interface Unit Tests", () => {
  before(async () => {
    await initStorage();
  });

  it("should sanitize unsafe filenames cleanly", () => {
    assert.equal(sanitizeFilename("my_document.pdf"), "my_document.pdf");
    assert.ok(!sanitizeFilename("../../../etc/passwd").includes(".."));
    assert.equal(sanitizeFilename("file\0with\nnulls.pdf"), "filewith_nulls.pdf");

    assert.equal(sanitizeFilename("test space & special!.pdf"), "test_space___special_.pdf");
    assert.equal(sanitizeFilename(""), "file");
  });


  it("should prevent path traversal attempts via safeJoin", () => {
    const root = path.resolve("./storage");
    
    // Valid relative path
    const valid = safeJoin(root, "users/admin1/colonies/colony1/file.pdf");
    assert.ok(valid.startsWith(root));

    // Path traversal escapes
    assert.throws(() => safeJoin(root, "../../../etc/passwd"), /Path traversal restriction violated/);
    assert.throws(() => safeJoin(root, "subfolder/../../outside.txt"), /Path traversal restriction violated/);
    assert.throws(() => safeJoin(root, "file\0.pdf"), /Null bytes detected/);
    assert.throws(() => safeJoin(root, null), /Key must be a non-empty string/);
  });

  it("should construct structured storage keys for various categories", () => {
    const regKey = buildStorageKey({
      userId: "usr123",
      colonyId: "col456",
      category: "registry",
      plotId: "plt789",
      filename: "deed.pdf",
      version: 2,
      docId: "doc-uuid-1",
    });
    assert.equal(regKey, "users/usr123/colonies/col456/registry/plt789/v2-doc-uuid-1-deed.pdf");

    const pdfKey = buildStorageKey({
      userId: "usr123",
      colonyId: "col456",
      category: "source_pdf",
      filename: "layout.pdf",
      docId: "doc-uuid-2",
    });
    assert.equal(pdfKey, "users/usr123/colonies/col456/source/pdf/doc-uuid-2-layout.pdf");

    const geoKey = buildStorageKey({
      userId: "usr123",
      colonyId: "col456",
      category: "geojson",
      filename: "colony.geojson",
      docId: "doc-uuid-3",
    });
    assert.equal(geoKey, "users/usr123/colonies/col456/generated/geojson/doc-uuid-3-colony.geojson");
  });

  it("should validate PDF buffer signatures (%PDF header)", () => {
    const validPdf = Buffer.from("%PDF-1.4 sample content");
    const invalidPdf = Buffer.from("NOT_A_PDF_FILE");
    const emptyBuf = Buffer.alloc(0);

    assert.equal(validatePdfBuffer(validPdf), true);
    assert.equal(validatePdfBuffer(invalidPdf), false);
    assert.equal(validatePdfBuffer(emptyBuf), false);
    assert.equal(validatePdfBuffer(null), false);
  });

  it("should perform local putObject, exists, getObject, and deleteObject flow", async () => {
    const testKey = "test-tenant/registry/v1-sample.txt";
    const testContent = Buffer.from("Hello LiveMap Storage Test");

    // 1. Upload
    const putRes = await putObject(testKey, testContent, "text/plain");
    assert.equal(putRes.path, testKey);

    // 2. Exists
    const isEx = await exists(testKey);
    assert.equal(isEx, true);

    // 3. Download
    const getRes = await getObject(testKey);
    assert.equal(getRes.content.toString(), "Hello LiveMap Storage Test");
    assert.equal(getRes.mime, "text/plain");

    // 4. Delete
    const delRes = await deleteObject(testKey);
    assert.equal(delRes.deleted, true);

    // 5. Verify deleted
    const isExAfter = await exists(testKey);
    assert.equal(isExAfter, false);
  });

  it("should handle temporary file creation and cleanup cleanly", async () => {
    const tempContent = Buffer.from("Temporary GIS Linework Data");
    const tmpPath = await createTempFile(tempContent, ".dxf");

    assert.ok(fsSync.existsSync(tmpPath));
    assert.ok(tmpPath.endsWith(".dxf"));

    const read = await fs.readFile(tmpPath);
    assert.equal(read.toString(), "Temporary GIS Linework Data");

    await deleteTempFile(tmpPath);
    assert.equal(fsSync.existsSync(tmpPath), false);
  });
});
