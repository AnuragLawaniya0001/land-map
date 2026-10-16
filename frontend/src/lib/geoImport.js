function isPolygonGeometry(geometry) {
  if (!geometry) return false;
  if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") return true;
  return geometry.type === "GeometryCollection" &&
    Array.isArray(geometry.geometries) &&
    geometry.geometries.some(isPolygonGeometry);
}

function normalizedProperty(properties, names) {
  const entries = new Map(Object.entries(properties || {}).map(([key, value]) => [
    key.toLowerCase().replace(/[^a-z0-9]/g, ""),
    value,
  ]));
  for (const name of names) {
    const value = entries.get(name.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function normalizedPlotNumber(value) {
  const match = /^(?:plot\s*(?:no\.?)?\s*)?([A-Z]{0,2}[-/ ]?\d{1,4}[A-Z]?)$/i.exec(String(value || "").trim());
  return match ? match[1].toUpperCase().replace(/[-/ ]/g, "") : "";
}

function isPdfFillArtifact(properties) {
  return /^pdf\s+filled\s+geometry(?:\s+\d+)?$/i.test(
    normalizedProperty(properties, ["name", "label"]),
  );
}

function isSiteBoundary(properties, isOnlyPolygon = false) {
  if (isOnlyPolygon) return true;
  const markers = [
    ...["feature_type", "boundary_type", "role", "layer", "category", "class", "type"]
      .map((name) => normalizedProperty(properties, [name])),
    normalizedProperty(properties, ["name", "label"]),
  ].map((value) => value.toLowerCase().replace(/[^a-z]/g, ""));
  return markers.some((value) =>
    /(?:site|colony|land|property|parcel|layout).*(?:boundar|outline|perimeter|extent|compound)|(?:boundar|outline|perimeter|extent|compound).*(?:site|colony|land|property|parcel|layout)/.test(value)
  );
}

export async function inspectGeoJsonPlotFile(file) {
  if (!file) return { polygonCount: 0, boundaryCount: 0, numberedPointCount: 0, error: null };
  const fileName = (file.name || "").toLowerCase();
  if (fileName.endsWith(".kml") || fileName.endsWith(".xml")) {
    return { polygonCount: 0, boundaryCount: 1, numberedPointCount: 0, error: null, isKml: true };
  }

  let text = "";
  try {
    text = await file.text();
  } catch {
    return { polygonCount: 0, boundaryCount: 0, numberedPointCount: 0, error: "Unable to read file." };
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("<?xml") || trimmed.startsWith("<kml") || trimmed.includes("<Placemark")) {
    return { polygonCount: 0, boundaryCount: 1, numberedPointCount: 0, error: null, isKml: true };
  }

  let collection;
  try {
    collection = JSON.parse(text);
  } catch {
    return { polygonCount: 0, boundaryCount: 0, numberedPointCount: 0, error: "This file is not valid GeoJSON JSON." };
  }

  const features = collection.type === "FeatureCollection"
    ? collection.features
    : collection.type === "Feature"
      ? [collection]
      : [];
  if (!Array.isArray(features) || features.length === 0) {
    return { polygonCount: 0, boundaryCount: 0, numberedPointCount: 0, error: "This GeoJSON has no features." };
  }

  const polygonFeatures = features.filter((feature) => feature && isPolygonGeometry(feature?.geometry));
  const isSingle = polygonFeatures.length === 1;
  const boundaryCount = polygonFeatures.filter((feature) =>
    isSiteBoundary(feature.properties, isSingle)
  ).length || (polygonFeatures.length > 0 ? 1 : 0);

  const polygonCount = polygonFeatures.filter((feature) => {
    if (!feature) return false;
    const properties = feature.properties || {};
    const kind = `${normalizedProperty(properties, ["layer", "category", "type", "class", "feature_type"])} ${normalizedProperty(properties, ["name", "label"])}`.toLowerCase();
    const plotNumber = normalizedPlotNumber(normalizedProperty(properties, ["plot_number", "plot_no", "lot_number", "lot_no", "number", "name", "label"]));
    if (isSiteBoundary(properties, isSingle) || isPdfFillArtifact(properties) || /road|street|park|garden|green|open\s*space/i.test(kind)) return false;
    return Boolean(plotNumber) || !/boundar|outline|perimeter/i.test(kind);
  }).length;

  const numberedPointCount = new Set(features
    .filter((feature) => feature?.geometry?.type === "Point")
    .map((feature) => normalizedPlotNumber(
      normalizedProperty(feature.properties, ["plot_number", "plot_no", "lot_number", "lot_no", "number", "name", "label"]),
    ))
    .filter(Boolean)).size;

  return { polygonCount, boundaryCount, numberedPointCount, error: null };
}
