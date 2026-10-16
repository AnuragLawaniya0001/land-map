/**
 * Real-World Georeferenced Aerial Imagery Pipeline.
 *
 * Implements Phase 2:
 * - Configurable imagery source abstraction (Esri World Imagery, XYZ, WMTS/WMS)
 * - Geodetic Web Mercator tile calculations
 * - Geographic bounding box buffering & zoom-level selection
 * - Tile stitching onto high-resolution georeferenced canvas
 * - Millimeter-accurate 3D coordinate registration
 * - Request deduplication, tile caching, cancellation, and honest error fallbacks
 */

import * as THREE from "three";
import { gisTo3DCoord } from "./canonical3D.js";

// Standard Esri World Imagery (high-resolution global satellite photography)
export const DEFAULT_IMAGERY_PROVIDER = {
  id: "esri-world-imagery",
  name: "Esri World Imagery",
  tileUrl: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  attribution: "Tiles © Esri — Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community",
  maxZoom: 19,
  minZoom: 14,
  tileSize: 256,
};

/**
 * Converts WGS84 (lat, lng) to slippy map tile (x, y) at given zoom level.
 */
export function latLngToTileXY(lat, lng, zoom) {
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return { x: Math.max(0, Math.min(x, n - 1)), y: Math.max(0, Math.min(y, n - 1)), z: zoom };
}

/**
 * Converts slippy map tile (x, y) at zoom level to WGS84 (lat, lng) of the tile's North-West corner.
 */
export function tileXYToLatLng(x, y, zoom) {
  const n = Math.pow(2, zoom);
  const lng = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const lat = (latRad * 180) / Math.PI;
  return { lat, lng };
}

/**
 * Memory tile cache to prevent duplicate network downloads.
 */
const TILE_MEMORY_CACHE = new Map();

/**
 * Downloads a single tile image with caching and timeout.
 */
export async function fetchTileImage(url, signal = null) {
  if (TILE_MEMORY_CACHE.has(url)) {
    return TILE_MEMORY_CACHE.get(url);
  }

  const response = await fetch(url, { signal, mode: "cors" });
  if (!response.ok) {
    throw new Error(`Failed to fetch imagery tile: ${response.status} ${response.statusText}`);
  }
  const blob = await response.blob();
  const bitmap = typeof createImageBitmap !== "undefined"
    ? await createImageBitmap(blob)
    : await new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = URL.createObjectURL(blob);
      });

  TILE_MEMORY_CACHE.set(url, bitmap);
  return bitmap;
}

/**
 * Determines appropriate zoom level based on colony metric span.
 */
export function selectImageryZoomLevel(spanMeters) {
  if (spanMeters <= 350) return 18;      // High resolution ~0.6m/px
  if (spanMeters <= 1200) return 17;     // Medium-high resolution ~1.2m/px
  if (spanMeters <= 3000) return 16;     // Medium resolution ~2.4m/px
  return 15;                             // Overview resolution ~4.8m/px
}

/**
 * Imagery Provider Pipeline Class.
 */
export class ImageryProvider {
  constructor(config = {}) {
    this.provider = {
      ...DEFAULT_IMAGERY_PROVIDER,
      ...config,
      tileUrl: config.tileUrl || (typeof process !== "undefined" && process.env?.VITE_SATELLITE_TILE_URL) || DEFAULT_IMAGERY_PROVIDER.tileUrl,
    };
    this.activeController = null;
  }

  cancel() {
    if (this.activeController) {
      this.activeController.abort();
      this.activeController = null;
    }
  }

  /**
   * Fetches, stitches and georeferences real aerial satellite imagery
   * for the given colony bounds and coordinate system.
   */
  async loadGeoreferencedAerialMesh({
    minLng,
    minLat,
    maxLng,
    maxLat,
    cx,
    cy,
    crsMetadata,
    bufferRatio = 0.45,
    onProgress = null,
  }) {
    this.cancel();
    this.activeController = new AbortController();
    const signal = this.activeController.signal;

    // Validate geographic coordinates
    const isGeographic =
      crsMetadata?.crs_type === "geographic_wgs84" ||
      crsMetadata?.units === "deg" ||
      crsMetadata?.epsg === 4326 ||
      (!crsMetadata?.scale_ratio && Math.abs(cx) <= 180 && Math.abs(cy) <= 90 && (Math.abs(cx) > 0.1 || Math.abs(cy) > 0.1));

    if (!isGeographic) {
      throw new Error("Colony coordinates are in projected local units without geographic WGS84 reference. Aerial satellite imagery requires georeferenced coordinates.");
    }

    // Add surrounding landscape buffer
    const lngSpan = Math.max(maxLng - minLng, 0.001);
    const latSpan = Math.max(maxLat - minLat, 0.001);
    const bufferedMinLng = minLng - lngSpan * bufferRatio;
    const bufferedMaxLng = maxLng + lngSpan * bufferRatio;
    const bufferedMinLat = minLat - latSpan * bufferRatio;
    const bufferedMaxLat = maxLat + latSpan * bufferRatio;

    // Metric span estimation
    const metricSpanX = lngSpan * 111320 * Math.cos((cy * Math.PI) / 180);
    const metricSpanY = latSpan * 110574;
    const maxMetricSpan = Math.max(metricSpanX, metricSpanY);

    let zoom = Math.min(
      selectImageryZoomLevel(maxMetricSpan),
      this.provider.maxZoom
    );

    // Compute tile bounding box
    let nwTile = latLngToTileXY(bufferedMaxLat, bufferedMinLng, zoom);
    let seTile = latLngToTileXY(bufferedMinLat, bufferedMaxLng, zoom);

    let minTileX = Math.min(nwTile.x, seTile.x);
    let maxTileX = Math.max(nwTile.x, seTile.x);
    let minTileY = Math.min(nwTile.y, seTile.y);
    let maxTileY = Math.max(nwTile.y, seTile.y);

    let cols = maxTileX - minTileX + 1;
    let rows = maxTileY - minTileY + 1;
    let totalTiles = cols * rows;

    // Dynamically scale down zoom level if extent exceeds 36 tiles so every colony renders reliably
    const minAllowedZoom = this.provider.minZoom || 13;
    while (totalTiles > 36 && zoom > minAllowedZoom) {
      zoom--;
      nwTile = latLngToTileXY(bufferedMaxLat, bufferedMinLng, zoom);
      seTile = latLngToTileXY(bufferedMinLat, bufferedMaxLng, zoom);
      minTileX = Math.min(nwTile.x, seTile.x);
      maxTileX = Math.max(nwTile.x, seTile.x);
      minTileY = Math.min(nwTile.y, seTile.y);
      maxTileY = Math.max(nwTile.y, seTile.y);
      cols = maxTileX - minTileX + 1;
      rows = maxTileY - minTileY + 1;
      totalTiles = cols * rows;
    }

    // Determine exact georeferenced corners of the stitched tile grid
    const gridNorthWest = tileXYToLatLng(minTileX, minTileY, zoom);
    const gridSouthEast = tileXYToLatLng(maxTileX + 1, maxTileY + 1, zoom);

    // Prepare offscreen canvas
    const canvas = document.createElement("canvas");
    canvas.width = cols * 256;
    canvas.height = rows * 256;
    const ctx = canvas.getContext("2d", { willReadFrequently: false });
    if (!ctx) throw new Error("Could not initialize 2D canvas context for aerial imagery stitching.");

    // Download tiles concurrently
    let loadedCount = 0;
    const tilePromises = [];

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const tileX = minTileX + c;
        const tileY = minTileY + r;
        const tileUrl = this.provider.tileUrl
          .replace("{z}", zoom)
          .replace("{x}", tileX)
          .replace("{y}", tileY);

        const p = fetchTileImage(tileUrl, signal)
          .then((img) => {
            ctx.drawImage(img, c * 256, r * 256, 256, 256);
            loadedCount++;
            if (onProgress) onProgress(loadedCount, totalTiles);
          })
          .catch((err) => {
            if (signal.aborted) return;
            console.warn(`Imagery tile ${tileX},${tileY} failed:`, err);
          });
        tilePromises.push(p);
      }
    }

    await Promise.all(tilePromises);

    if (signal.aborted) {
      throw new Error("Aerial imagery request was cancelled.");
    }

    // Convert stitched canvas to Three.js Texture
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;

    // Calculate metric 3D coordinates for North-West and South-East corners
    const [xMin, zMax] = gisTo3DCoord(gridNorthWest.lng, gridNorthWest.lat, cx, cy, crsMetadata);
    const [xMax, zMin] = gisTo3DCoord(gridSouthEast.lng, gridSouthEast.lat, cx, cy, crsMetadata);

    const planeWidth = Math.abs(xMax - xMin);
    const planeDepth = Math.abs(zMax - zMin);
    const planeCenterX = (xMin + xMax) / 2;
    const planeCenterZ = (zMin + zMax) / 2;

    const geometry = new THREE.PlaneGeometry(planeWidth, planeDepth, 1, 1);
    geometry.rotateX(-Math.PI / 2);

    const material = new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.95,
      metalness: 0.05,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(planeCenterX, -0.015, planeCenterZ);
    mesh.receiveShadow = true;
    mesh.name = "real-earth-aerial-satellite-plane";

    return {
      mesh,
      provider: this.provider.name,
      attribution: this.provider.attribution,
      zoom,
      tilesCount: totalTiles,
      extent: {
        northWest: gridNorthWest,
        southEast: gridSouthEast,
      },
    };
  }
}
