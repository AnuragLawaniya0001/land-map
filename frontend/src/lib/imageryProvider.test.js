import assert from "node:assert/strict";
import test from "node:test";
import {
  latLngToTileXY,
  tileXYToLatLng,
  selectImageryZoomLevel,
  ImageryProvider,
  DEFAULT_IMAGERY_PROVIDER,
} from "./imageryProvider.js";

test("latLngToTileXY converts WGS84 coordinates to correct slippy map tile", () => {
  // Center of New Delhi / Agra region ~27.22°N, 78.25°E
  const tile17 = latLngToTileXY(27.223, 78.254, 17);
  assert.equal(tile17.z, 17);
  assert.ok(tile17.x > 0);
  assert.ok(tile17.y > 0);

  // Round-trip check: tile coordinates should map back to within 1 tile span
  const nwCorner = tileXYToLatLng(tile17.x, tile17.y, 17);
  assert.ok(Math.abs(nwCorner.lat - 27.223) < 0.05);
  assert.ok(Math.abs(nwCorner.lng - 78.254) < 0.05);
});

test("tileXYToLatLng converts tile indices to valid WGS84 coordinates", () => {
  const coord = tileXYToLatLng(0, 0, 1);
  assert.equal(coord.lng, -180);
  assert.ok(coord.lat > 80); // Near 85° Mercator limit
});

test("selectImageryZoomLevel selects appropriate resolution based on colony span", () => {
  assert.equal(selectImageryZoomLevel(150), 18);   // Small colony (dense plots) -> high res
  assert.equal(selectImageryZoomLevel(500), 17);   // Medium colony
  assert.equal(selectImageryZoomLevel(1800), 16);  // Large development
  assert.equal(selectImageryZoomLevel(5000), 15);  // Regional overview
});

test("ImageryProvider initializes with default Esri World Imagery configuration", () => {
  const provider = new ImageryProvider();
  assert.equal(provider.provider.id, "esri-world-imagery");
  assert.ok(provider.provider.tileUrl.includes("arcgisonline.com"));
  assert.ok(provider.provider.attribution.includes("Esri"));
  assert.equal(provider.provider.maxZoom, 19);
});

test("ImageryProvider rejects non-geographic CRS when requesting aerial imagery", async () => {
  const provider = new ImageryProvider();
  await assert.rejects(
    async () => {
      await provider.loadGeoreferencedAerialMesh({
        minLng: 10,
        minLat: 10,
        maxLng: 50,
        maxLat: 50,
        cx: 30,
        cy: 30,
        crsMetadata: { crs_type: "projected_cad_local", units: "m", scale_ratio: 1 },
      });
    },
    {
      name: "Error",
      message: /Colony coordinates are in projected local units without geographic WGS84 reference/,
    }
  );
});

test("ImageryProvider cancel aborts active in-flight controller", () => {
  const provider = new ImageryProvider();
  provider.activeController = new AbortController();
  assert.equal(provider.activeController.signal.aborted, false);
  provider.cancel();
  assert.equal(provider.activeController, null);
});
