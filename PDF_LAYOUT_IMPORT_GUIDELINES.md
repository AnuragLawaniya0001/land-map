# PDF Layout Import: File Requirements

This document covers only the PDF input format and what the importer can
reliably read from it. A `.pdf` extension or a PDF classified as “vector” does
not by itself mean that individual plot geometry can be recovered.

## Recommended PDF profile

Prepare the source in CAD/GIS and export it directly as a **single-page,
native-vector PDF**:

- Keep plot boundaries as closed vector paths. A parcel must form one valid
  closed shape; neighboring parcels should share the same clean edge rather
  than contain tiny gaps, overlaps, duplicate strokes, or many disconnected
  fragments.
- Keep plot numbers as native searchable text (not scanned pixels or converted
  outlines). Use one unique number per plot and position it clearly inside that
  plot, away from shared edges. Do not duplicate labels.
- Keep dimensions and units as native searchable text. Use consistent notation
  and readable embedded fonts; avoid text converted into hundreds of tiny
  drawing paths.
- Draw roads, parks/gardens, and other common areas as their own closed vector
  shapes, separate from parcel outlines. Put searchable identifying text such
  as `ROAD`, `PARK`, or `GARDEN` inside each corresponding shape. Do not draw
  those labels over a plot. Distinct, solid fills can help visual review, but
  color alone is not a dependable semantic identifier.
- Include all intended layout content in page 1. Avoid clipping plot edges,
  excessive empty margins, title blocks that dominate the layout, unrelated
  drawings, and multi-page plans; the current extraction flow processes page
  1. The importer pads the detected PDF crop and fits the layout about 2.5%
  inside the colony envelope to leave a small visible margin at the edges.
- Keep the linework clean: join endpoints, remove duplicate/self-intersecting
  paths and isolated micro-segments, and preserve genuine angled edges and
  curves. Do not force real plots into rectangles.

Avoid screenshots, scans, “print to image,” and flattened PDFs where possible.
Raster-only PDFs have no native searchable plot text; OCR is not currently
available. Raster contour tracing can produce only heuristic, approximate
regions, not original CAD parcel geometry. A mixed or vector PDF can also fail
when parcel paths are fragmented or do not enclose individual plots.

## Road and garden requirements

Road/garden shading requires geometry and a way to identify that geometry.
For best results in the PDF, each such feature should be a separate closed
vector region, have a searchable `ROAD`, `PARK`, or `GARDEN` label located
inside it, and not contain plot numbers. These constraints improve best-effort
classification but do not guarantee it: the current PDF importer does not
preserve every CAD layer/style reliably, and labels on open linework or mixed
with other shapes may not map to the intended region. If the PDF only shows a
road or park visually without a closed, labeled region, the PDF artwork can
show that drawing, but the importer cannot promise an independently shaded
road/garden feature.

## Measured sample PDFs

The following measurements show why PDF structure alone is insufficient:

| PDF | Native content measured | Plot geometry recovered |
|---|---|---|
| `Durga_Enclave_Final_Clean.pdf` | One page, vector; page 1684 x 2384 pt, rotation 270 degrees; 17,286 vector items, 17,045 extracted lines, 108 extracted polygons, 392 native words, 66 unique plot labels. Native text includes `ROAD` and `PARK`; dimensions include values such as `50'` and `92'-6"`. | 64 individual heuristic click regions from 64 vector parcel cells; `9` and `9A` did not have confidently recovered boundaries. |
| `Shri_Ram_Vector_Clean.pdf` | One page, vector; page 3370 x 4768 pt; 692 vector items, 621 extracted lines, 27 extracted polygons, 719 native words, 110 unique plot labels. | Direct vector polygonization yielded 1 cell. High-resolution contour tracing found 54 label-associated candidates; 52 passed final geometry, visibility, and nearby-label ambiguity checks. 58 labels had no reliable individual region. |

These are results for the exact sample files and current code, not guaranteed
acceptance thresholds or proof of boundary accuracy. Shri Ram is structurally
vector but its plot paths do not provide enough closed parcel geometry. Durga
contains searchable road/park words, but that alone does not establish that
every road/garden boundary can be classified or shaded correctly.

## Check each PDF before using it

1. Confirm the PDF is one page and visually complete; check that no layout
   edges are clipped and the plot linework is legible at high zoom.
2. Select/copy a plot number and a dimension in a PDF viewer. If they cannot be
   selected as text, they are probably raster pixels or outlined paths and
   native text extraction will not recover them.
3. Confirm each plot has a closed outline and one unambiguous searchable
   number inside it. Look for broken, doubled, overlapping, or fragmented
   edges.
4. Confirm every road/park intended for independent shading has a separate
   closed outline and an identifying searchable word inside that feature.
5. Review the import diagnostics: compare unique PDF labels with individual
   detected plot regions and inspect all unmatched labels/warnings. A detected
   label is not proof that its parcel boundary was found.
6. Review the resulting map before saving inventory. Traced or polygonized PDF
   click regions are heuristic until checked; do not treat unmatched or
   ambiguous features as verified parcels.

The importer uses searchable native text and vector paths where available.
Text printed into a scanned image is not OCR'd. PDF-derived plot selections
and road/garden features can be incomplete; a visually similar PDF may behave
differently if its internal paths, labels, or fills differ.
