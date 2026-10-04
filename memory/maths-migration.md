---
name: maths-migration
description: bitmaps uses @isopodlabs/maths vectors (migrated 2026-09-28); webview/matrix.ts is only the OpenSCAD/bitmaps-specific layer
metadata:
  type: project
---
Since 2026-09-28 all vector/matrix code uses `@isopodlabs/maths` (vector, quaternion, linear). `webview/matrix.ts` keeps only what maths lacks: OpenSCAD's degree-based affine transforms (`rotation`, `rotationAxis`, `mirroring`, `scaling`, `translation` → `float3x4`), zero-safe `normalize`, `isConformal`, `expand2/3`, `orthonormalizeCubeBasis`. Transforms are affine `float3x4` (multmatrix's 4th row is ignored, as OpenSCAD does). Webviews load maths through the ImportMap in `webviewPage` (BitmapViewer.tsx).

Gotchas:
- Anything crossing postMessage loses prototypes: type such fields `vec<number, E3>` and rebuild with `float3(...)` on receipt (see sdf.ts MessageIn).
- JS tests must pass `float3(...)`, not `{x,y,z}`, to evalSdf.
- The mesher is sensitive at sharp edges: a vertex exactly on an edge picks a face by a last-bit tie in the union, so tiny rounding changes can move vertices of an open mesh (Advanced/animation.scad volume 194.1 vs 188.5 after the migration; fields identical to 4e-15).

**Why:** the user wanted one shared, fast vector library instead of per-project copies.
**How to apply:** don't reintroduce plain-object vector helpers; add missing general ops to maths instead.
