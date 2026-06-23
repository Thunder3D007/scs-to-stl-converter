'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Upload,
  Box,
  Download,
  RotateCcw,
  AlertCircle,
  CheckCircle2,
  Info,
  Loader2,
  FileBox,
  FlipVertical,
  Layers,
} from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface LogEntry {
  id: number;
  text: string;
  level: 'info' | 'error' | 'success';
  ts: string;
}

interface TriResult {
  triCount: number;
  bytes: ArrayBuffer;
}

/* Quality presets — target triangle ratios */
type QualityPreset = 'draft' | 'standard' | 'high' | 'original';
const QUALITY_LABELS: Record<QualityPreset, string> = {
  draft: 'Draft (~5%)',
  standard: 'Standard (~25%)',
  high: 'High (~60%)',
  original: 'Original (100%)',
};
const QUALITY_RATIOS: Record<QualityPreset, number> = {
  draft: 0.05,
  standard: 0.25,
  high: 0.60,
  original: 1.0,
};

/* ------------------------------------------------------------------ */
/*  Utility helpers                                                    */
/* ------------------------------------------------------------------ */

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor<T>(
  check: () => T | null,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = check();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label} (${timeoutMs}ms)`);
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function looksLikeViewer(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const m =
    safe(() => (v as Record<string, unknown>).model) ??
    safe(() =>
      typeof (v as Record<string, unknown>).getModel === 'function'
        ? (v as { getModel: () => unknown }).getModel()
        : undefined,
    );
  return !!(m && typeof (m as Record<string, unknown>).getNodeChildren === 'function');
}

function findWebViewer(rootEl: HTMLElement): unknown {
  const seen = new WeakSet();
  function walkFiber(fiber: unknown, depth: number): unknown {
    if (!fiber || depth > 200 || seen.has(fiber as object)) return null;
    seen.add(fiber as object);
    for (const key of [
      'stateNode',
      'memoizedState',
      'memoizedProps',
      'ref',
    ] as const) {
      const v = safe(() => (fiber as Record<string, unknown>)[key]);
      if (looksLikeViewer(v)) return v;
      if (v && typeof v === 'object') {
        const cur = safe(() => (v as { current?: unknown }).current);
        if (looksLikeViewer(cur)) return cur;
        let h = v as Record<string, unknown>;
        for (let i = 0; i < 80 && h; i++) {
          if (looksLikeViewer(h)) return h;
          const hc = safe(() => (h as { current?: unknown }).current);
          if (looksLikeViewer(hc)) return hc;
          for (const k of ['baseState', 'memoizedState'] as const) {
            const inner = safe(() => (h as Record<string, unknown>)[k]);
            if (looksLikeViewer(inner)) return inner;
          }
          h = safe(() => (h as { next?: unknown }).next) as Record<string, unknown>;
        }
      }
    }
    return (
      walkFiber(safe(() => (fiber as { child?: unknown }).child), depth + 1) ??
      walkFiber(safe(() => (fiber as { sibling?: unknown }).sibling), depth + 1)
    );
  }
  const stack = [rootEl];
  while (stack.length) {
    const el = stack.pop()!;
    const props = safe(() => Object.getOwnPropertyNames(el)) ?? [];
    for (const p of props) {
      if (!p.startsWith('__reactFiber') && !p.startsWith('__reactInternalInstance'))
        continue;
      const found = walkFiber(safe(() => (el as unknown as Record<string, unknown>)[p]), 0);
      if (found) return found;
    }
    for (const c of Array.from(el.children) as HTMLElement[]) stack.push(c);
  }
  return null;
}

function modelHasGeometry(model: Record<string, unknown>): boolean {
  try {
    const root =
      typeof model.getAbsoluteRootNode === 'function'
        ? (model.getAbsoluteRootNode as () => unknown)()
        : typeof model.getRootNode === 'function'
          ? (model.getRootNode as () => unknown)()
          : null;
    const kids =
      typeof model.getNodeChildren === 'function'
        ? (model.getNodeChildren as (n: unknown) => unknown[])(root)
        : [];
    return Array.isArray(kids) && kids.length > 0;
  } catch {
    return false;
  }
}

/**
 * Hide all HOOPS Communicator UI overlay elements so only the 3D canvas
 * remains visible. HOOPS renders measurement panels, views panel, toolbar,
 * etc. as sibling divs alongside the canvas — these push the canvas down.
 *
 * Strategy: Walk the HOOPS DOM tree level by level. At each level, find the
 * branch that contains the canvas (that's the 3D viewport) and hide all its
 * siblings (those are the UI panels). Then make the canvas branch fill the
 * entire container. Also installs a MutationObserver to catch late-loading UI.
 */
function hideHoopsUI(container: HTMLElement) {
  function doHide() {
    // Find the canvas — it's the deepest element we want to keep
    const canvas = container.querySelector('canvas');
    if (!canvas) return;

    // Walk UP from canvas to container, at each level hiding siblings
    // that don't contain the canvas (those are UI panels)
    let current: HTMLElement | null = canvas.parentElement;
    while (current && current !== container) {
      // Make this element fill its parent
      current.style.position = 'absolute';
      current.style.top = '0';
      current.style.left = '0';
      current.style.width = '100%';
      current.style.height = '100%';
      current.style.overflow = 'hidden';

      // Hide all siblings that don't contain the canvas
      const parent = current.parentElement;
      if (parent) {
        for (const sibling of Array.from(parent.children)) {
          if (sibling === current) continue;
          if (sibling instanceof HTMLElement) {
            sibling.style.display = 'none';
          }
        }
      }

      current = parent;
    }

    // Finally ensure the canvas itself fills its parent
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
  }

  // Run immediately
  doHide();

  // Also re-run whenever HOOPS adds new DOM nodes (late-loading panels)
  const observer = new MutationObserver(() => doHide());
  observer.observe(container, { childList: true, subtree: true });

  // Stop observing after 10 seconds (HOOPS UI should be fully loaded by then)
  setTimeout(() => observer.disconnect(), 10000);
}

async function buildStl(
  model: Record<string, unknown>,
  flipZ: boolean,
  addLog?: (text: string, level?: LogEntry['level']) => void,
): Promise<TriResult> {
  const root =
    typeof model.getAbsoluteRootNode === 'function'
      ? (model.getAbsoluteRootNode as () => unknown)()
      : (model.getRootNode as () => unknown)();

  // Walk ALL nodes recursively
  const nodes: unknown[] = [];
  (function walk(id: unknown) {
    nodes.push(id);
    for (const c of (
      model.getNodeChildren as (n: unknown) => unknown[]
    )(id) || [])
      walk(c);
  })(root);

  const transform = (m: number[], x: number, y: number, z: number): number[] => {
    const o = [
      m[0] * x + m[4] * y + m[8] * z + m[12],
      m[1] * x + m[5] * y + m[9] * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14],
    ];
    if (flipZ) o[2] = -o[2];
    return o;
  };

  const transformDir = (
    m: number[],
    x: number,
    y: number,
    z: number,
  ): number[] => {
    const o = [
      m[0] * x + m[4] * y + m[8] * z,
      m[1] * x + m[5] * y + m[9] * z,
      m[2] * x + m[6] * y + m[10] * z,
    ];
    if (flipZ) o[2] = -o[2];
    return o;
  };

  const tris: number[][] = [];
  let triCount = 0;
  let skipped = 0;

  // First pass: count triangles to pre-allocate the buffer
  for (const id of nodes) {
    let mesh: Record<string, unknown> | null = null;
    try {
      mesh = (await (
        model.getNodeMeshData as (id: unknown) => Promise<Record<string, unknown>>
      )(id)) as Record<string, unknown> | null;
    } catch {
      skipped++;
      continue;
    }
    if (!mesh) continue;
    const faces = mesh.faces as
      | (Iterable<{ position: number[]; normal?: number[] }> & {
          vertexCount?: number;
        })
      | undefined;
    if (!faces || !faces[Symbol.iterator] || !faces.vertexCount) continue;
    triCount += Math.floor((faces.vertexCount as number) / 3);
  }

  if (!triCount)
    throw new Error(
      'No triangles collected \u2014 model may not have streamed yet',
    );

  if (addLog) addLog(`Found ${triCount.toLocaleString()} triangles. Building STL...`);

  // Pre-allocate buffer — no intermediate arrays, write directly
  const buffer = new ArrayBuffer(84 + triCount * 50);
  const dv = new DataView(buffer);
  dv.setUint32(80, triCount, true);
  let off = 84;
  let written = 0;

  // Second pass: write triangles directly to buffer
  for (const id of nodes) {
    let mesh: Record<string, unknown> | null = null;
    try {
      mesh = (await (
        model.getNodeMeshData as (id: unknown) => Promise<Record<string, unknown>>
      )(id)) as Record<string, unknown> | null;
    } catch {
      continue;
    }
    if (!mesh) continue;
    const faces = mesh.faces as
      | (Iterable<{ position: number[]; normal?: number[] }> & {
          vertexCount?: number;
        })
      | undefined;
    if (!faces || !faces[Symbol.iterator] || !faces.vertexCount) continue;

    let matObj: unknown = null;
    try {
      if (typeof model.getNodeNetMatrix === 'function')
        matObj = (model.getNodeNetMatrix as (id: unknown) => unknown)(id);
      else if (typeof model.getNetMatrix === 'function')
        matObj = (model.getNetMatrix as (id: unknown) => unknown)(id);
      if (matObj && typeof (matObj as Promise<unknown>).then === 'function')
        matObj = await matObj;
    } catch {
      matObj = null;
    }

    let m: number[];
    if (Array.isArray(matObj) && matObj.length === 16) m = matObj;
    else if (
      matObj &&
      Array.isArray((matObj as { m?: number[] }).m) &&
      (matObj as { m?: number[] }).m!.length === 16
    )
      m = (matObj as { m: number[] }).m;
    else if (
      matObj &&
      typeof (matObj as { getElements?: () => number[] }).getElements ===
        'function'
    )
      m = (matObj as { getElements: () => number[] }).getElements();
    else m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

    const buf: { p: number[]; n: number[] | null }[] = [];
    for (const v of faces) {
      buf.push({
        p: [v.position[0], v.position[1], v.position[2]],
        n: v.normal
          ? [v.normal[0], v.normal[1], v.normal[2]]
          : null,
      });
      if (buf.length === 3) {
        const [a, b, c] = buf;
        const p0 = transform(m, a.p[0], a.p[1], a.p[2]);
        const p1 = transform(m, b.p[0], b.p[1], b.p[2]);
        const p2 = transform(m, c.p[0], c.p[1], c.p[2]);
        const n = a.n
          ? transformDir(m, a.n[0], a.n[1], a.n[2])
          : [0, 0, 0];

        let v0x = p0[0], v0y = p0[1], v0z = p0[2];
        let v1x = p1[0], v1y = p1[1], v1z = p1[2];
        let v2x = p2[0], v2y = p2[1], v2z = p2[2];

        if (flipZ) {
          // Swap v1 and v2 for correct winding
          [v1x, v2x] = [v2x, v1x];
          [v1y, v2y] = [v2y, v1y];
          [v1z, v2z] = [v2z, v1z];
          n[2] = -n[2];
          v0z = -v0z; v1z = -v1z; v2z = -v2z;
        }

        // Write directly to buffer
        dv.setFloat32(off, n[0], true); off += 4;
        dv.setFloat32(off, n[1], true); off += 4;
        dv.setFloat32(off, n[2], true); off += 4;
        dv.setFloat32(off, v0x, true); off += 4;
        dv.setFloat32(off, v0y, true); off += 4;
        dv.setFloat32(off, v0z, true); off += 4;
        dv.setFloat32(off, v1x, true); off += 4;
        dv.setFloat32(off, v1y, true); off += 4;
        dv.setFloat32(off, v1z, true); off += 4;
        dv.setFloat32(off, v2x, true); off += 4;
        dv.setFloat32(off, v2y, true); off += 4;
        dv.setFloat32(off, v2z, true); off += 4;
        dv.setUint16(off, 0, true); off += 2;
        written++;
        buf.length = 0;
      }
    }

    // Yield to browser every 100 nodes to prevent freezing
    if (written % 100 === 0) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }

  if (skipped) console.log(`Skipped ${skipped} nodes with errors`);

  // Update actual triangle count (may differ from estimate)
  dv.setUint32(80, written, true);
  const actualBuffer = written === triCount ? buffer : buffer.slice(0, 84 + written * 50);
  return { triCount: written, bytes: actualBuffer };
}

/* ------------------------------------------------------------------ */
/*  Format helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Simplify a binary STL using meshoptimizer edge-collapse.
 * Converts triangle soup → indexed mesh → simplify → binary STL.
 * Falls back to the original STL if simplification fails (OOM, etc).
 */
async function simplifyStl(
  stlBytes: ArrayBuffer,
  triCount: number,
  targetRatio: number,
  addLog: (text: string, level?: LogEntry['level']) => void,
): Promise<TriResult> {
  try {
    // Dynamic import — meshoptimizer WASM loads on demand
    const { MeshoptSimplifier } = await import('meshoptimizer');
    await MeshoptSimplifier.ready;

    addLog(`Simplifier ready. Original: ${triCount.toLocaleString()} triangles`);

    // Memory guard: for very large meshes, use simplifySloppy which
    // doesn't require vertex deduplication and uses much less memory
    const LARGE_MESH_THRESHOLD = 2_000_000; // 2M triangles
    const useSloppy = triCount > LARGE_MESH_THRESHOLD;

    // Parse binary STL → vertex positions
    const dv = new DataView(stlBytes);
    const vertexCount = triCount * 3;
    const positionArray = new Float32Array(vertexCount * 3);

    for (let i = 0; i < triCount; i++) {
      const off = 84 + i * 50;
      for (let v = 0; v < 3; v++) {
        const voff = off + 12 + v * 12;
        const idx = (i * 3 + v) * 3;
        positionArray[idx] = dv.getFloat32(voff, true);
        positionArray[idx + 1] = dv.getFloat32(voff + 4, true);
        positionArray[idx + 2] = dv.getFloat32(voff + 8, true);
      }
    }

    // Build index buffer (0, 1, 2, 3, 4, 5, ...)
    const indexArray = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) indexArray[i] = i;

    const targetIndexCount = Math.max(3, Math.floor(vertexCount * targetRatio));

    let simplifiedIndices: Uint32Array;

    if (useSloppy) {
      // simplifySloppy — uses less memory, no topological guarantees
      // but works on huge meshes that would OOM the standard path
      addLog('Using fast simplifier (large mesh mode)...');
      const [sloppyIndices] = MeshoptSimplifier.simplifySloppy(
        indexArray,
        positionArray,
        3,
        null,
        targetIndexCount,
        0.02,
      );
      simplifiedIndices = sloppyIndices;
    } else {
      // Standard simplify — better quality, needs indexed mesh
      // Compact mesh first to deduplicate vertices
      addLog('Deduplicating vertices...');
      const [remap, uniqueCount] = MeshoptSimplifier.compactMesh(indexArray);

      const compactPositions = new Float32Array(uniqueCount * 3);
      for (let i = 0; i < vertexCount; i++) {
        const srcIdx = i * 3;
        const dstIdx = remap[i] * 3;
        compactPositions[dstIdx] = positionArray[srcIdx];
        compactPositions[dstIdx + 1] = positionArray[srcIdx + 1];
        compactPositions[dstIdx + 2] = positionArray[srcIdx + 2];
      }

      // Remap indices
      const compactIndices = new Uint32Array(vertexCount);
      for (let i = 0; i < vertexCount; i++) compactIndices[i] = remap[i];

      addLog(`Indexed: ${uniqueCount.toLocaleString()} unique vertices`);

      const [stdIndices] = MeshoptSimplifier.simplify(
        compactIndices,
        compactPositions,
        3,
        targetIndexCount,
        0.02,
      );
      simplifiedIndices = stdIndices;
      // Use compactPositions for rebuild
      positionArray.set(compactPositions);
    }

    const newTriCount = simplifiedIndices.length / 3;
    addLog(`Simplified to ${newTriCount.toLocaleString()} triangles (${Math.round((newTriCount / triCount) * 100)}%)`, 'success');

    // Rebuild binary STL from simplified mesh
    const buffer = new ArrayBuffer(84 + newTriCount * 50);
    const out = new DataView(buffer);
    out.setUint32(80, newTriCount, true);

    let off = 84;
    for (let t = 0; t < newTriCount; t++) {
      const i0 = simplifiedIndices[t * 3];
      const i1 = simplifiedIndices[t * 3 + 1];
      const i2 = simplifiedIndices[t * 3 + 2];

      const p0x = positionArray[i0 * 3], p0y = positionArray[i0 * 3 + 1], p0z = positionArray[i0 * 3 + 2];
      const p1x = positionArray[i1 * 3], p1y = positionArray[i1 * 3 + 1], p1z = positionArray[i1 * 3 + 2];
      const p2x = positionArray[i2 * 3], p2y = positionArray[i2 * 3 + 1], p2z = positionArray[i2 * 3 + 2];

      // Compute face normal
      const e1x = p1x - p0x, e1y = p1y - p0y, e1z = p1z - p0z;
      const e2x = p2x - p0x, e2y = p2y - p0y, e2z = p2z - p0z;
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= len; ny /= len; nz /= len;

      out.setFloat32(off, nx, true); off += 4;
      out.setFloat32(off, ny, true); off += 4;
      out.setFloat32(off, nz, true); off += 4;
      out.setFloat32(off, p0x, true); off += 4;
      out.setFloat32(off, p0y, true); off += 4;
      out.setFloat32(off, p0z, true); off += 4;
      out.setFloat32(off, p1x, true); off += 4;
      out.setFloat32(off, p1y, true); off += 4;
      out.setFloat32(off, p1z, true); off += 4;
      out.setFloat32(off, p2x, true); off += 4;
      out.setFloat32(off, p2y, true); off += 4;
      out.setFloat32(off, p2z, true); off += 4;
      out.setUint16(off, 0, true); off += 2;
    }

    return { triCount: newTriCount, bytes: buffer };
  } catch (err) {
    // If simplification fails (OOM, etc), return the original STL
    addLog(`Simplification failed (${err instanceof Error ? err.message : String(err)}). Using original mesh.`, 'error');
    return { triCount, bytes: stlBytes };
  }
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

function ts(): string {
  return new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/* ------------------------------------------------------------------ */
/*  Main Component                                                     */
/* ------------------------------------------------------------------ */

export default function ScsToStlPage() {
  // State
  const [file, setFile] = useState<File | null>(null);
  const [flipZ, setFlipZ] = useState(true);
  const [quality, setQuality] = useState<QualityPreset>('standard');
  const [converting, setConverting] = useState(false);
  const [stlResult, setStlResult] = useState<TriResult | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [hoopsReady, setHoopsReady] = useState(false);
  const [viewerMounted, setViewerMounted] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // Refs — fileRef avoids stale closures; modelRef persists across renders
  const fileRef = useRef<File | null>(null);
  const modelRef = useRef<Record<string, unknown> | null>(null);
  const viewerContainerRef = useRef<HTMLDivElement>(null);
  const blobUrlRef = useRef<string>('');
  const logIdRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const stlUrlRef = useRef<string>('');

  // Keep fileRef in sync with file state
  useEffect(() => {
    fileRef.current = file;
  }, [file]);

  /* ---------- Logging ---------- */
  const addLog = useCallback(
    (text: string, level: LogEntry['level'] = 'info') => {
      setLogs((prev) => [
        ...prev,
        { id: ++logIdRef.current, text, level, ts: ts() },
      ]);
    },
    [],
  );

  /* ---------- Load HOOPS bundle ---------- */
  useEffect(() => {
    // The <script> tag is now in layout.tsx <head> so it starts loading
    // immediately on page load. We just need to detect when it's ready.
    const checkReady = () => {
      if ((window as unknown as Record<string, unknown>).GcHoopsViewer) {
        setHoopsReady(true);
        addLog('HOOPS engine ready.', 'success');
        return true;
      }
      return false;
    };

    // Already loaded?
    if (checkReady()) return;

    // Wait for the script to load (it's already in <head>)
    const existingScript = document.getElementById('hoops-bundle');
    if (existingScript) {
      const onLoad = () => {
        const poll = setInterval(() => {
          if (checkReady()) clearInterval(poll);
        }, 200);
        setTimeout(() => clearInterval(poll), 30_000);
      };
      existingScript.addEventListener('load', onLoad, { once: true });
    } else {
      // Fallback: create script if not in head (shouldn't happen)
      addLog('Loading HOOPS Communicator engine...');
      const script = document.createElement('script');
      script.id = 'hoops-bundle';
      script.src = '/hoops/bundle.js';
      script.async = true;
      script.onload = () => {
        const poll = setInterval(() => {
          if (checkReady()) clearInterval(poll);
        }, 200);
        setTimeout(() => clearInterval(poll), 30_000);
      };
      script.onerror = () => addLog('Failed to load HOOPS bundle.', 'error');
      document.head.appendChild(script);
    }
  }, [addLog]);

  /* ---------- mountAndWait ---------- */
  const mountAndWait = useCallback(
    async (fileToMount: File): Promise<Record<string, unknown>> => {
      const GcHoopsViewer = (window as unknown as Record<string, unknown>)
        .GcHoopsViewer as Record<string, unknown> | undefined;
      if (!GcHoopsViewer || typeof GcHoopsViewer.mountViewer !== 'function') {
        throw new Error(
          'HOOPS Viewer engine is still loading. Please wait a moment and try again.',
        );
      }

      // Create a FRESH div for HOOPS each time (prevents React conflict)
      if (viewerContainerRef.current) {
        while (viewerContainerRef.current.firstChild) {
          viewerContainerRef.current.removeChild(
            viewerContainerRef.current.firstChild,
          );
        }
      }
      const freshDiv = document.createElement('div');
      freshDiv.style.width = '100%';
      freshDiv.style.height = '100%';
      freshDiv.style.minHeight = '400px';
      freshDiv.style.position = 'relative';
      freshDiv.style.overflow = 'hidden';
      freshDiv.setAttribute('data-hoops-viewer', 'true');
      viewerContainerRef.current?.appendChild(freshDiv);

      // Inject CSS to hide HOOPS UI elements BEFORE the viewer mounts.
      // This prevents the text flash during loading.
      const styleId = 'hoops-hide-ui-style';
      let styleEl = document.getElementById(styleId) as HTMLStyleElement | null;
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = styleId;
        styleEl.textContent = `
          [data-hoops-viewer] > div > div:not(:has(canvas)):not(:has(> canvas)) {
            display: none !important;
          }
          [data-hoops-viewer] canvas {
            position: absolute !important;
            top: 0 !important;
            left: 0 !important;
            width: 100% !important;
            height: 100% !important;
          }
          [data-hoops-viewer] > div > div:has(canvas) {
            position: absolute !important;
            top: 0 !important;
            left: 0 !important;
            width: 100% !important;
            height: 100% !important;
            overflow: hidden !important;
          }
        `;
        document.head.appendChild(styleEl);
      }

      // Also start a MutationObserver to hide new HOOPS UI elements immediately
      const uiObserver = new MutationObserver(() => hideHoopsUI(freshDiv));
      uiObserver.observe(freshDiv, { childList: true, subtree: true });

      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = URL.createObjectURL(fileToMount);

      addLog('Mounting 3D viewer...');
      (GcHoopsViewer.mountViewer as (
        el: HTMLElement,
        opts: Record<string, unknown>,
      ) => void)(freshDiv, {
        file: blobUrlRef.current,
        onAction: () => {},
        onError: (e: unknown) => addLog(`Viewer error: ${e}`, 'error'),
      });

      addLog('Waiting for WebViewer...');
      const hwv = await waitFor(
        () =>
          findWebViewer(freshDiv) as Record<string, unknown> | null,
        30000,
        'WebViewer instance',
      );
      addLog('WebViewer found.', 'success');

      // Set streamCutoffScale to 0 = request ALL geometry, no low-res cutoff.
      // Without this, HOOPS may stop streaming after a low-res version.
      try {
        if (typeof (hwv as Record<string, unknown>).setStreamCutoffScale === 'function') {
          (hwv as { setStreamCutoffScale: (s: number) => Promise<void> }).setStreamCutoffScale(0);
          addLog('Full geometry streaming requested.');
        }
      } catch {
        // Non-critical
      }

      const model =
        typeof (hwv as Record<string, unknown>).getModel === 'function'
          ? (
              hwv as { getModel: () => unknown }
            ).getModel() as Record<string, unknown>
          : (hwv as Record<string, unknown>).model;
      if (!model || typeof (model as Record<string, unknown>).getNodeChildren !== 'function') {
        throw new Error('Model surface unrecognized');
      }

      // Wait for initial geometry to appear
      addLog('Streaming geometry...');
      await waitFor(
        () => (modelHasGeometry(model as Record<string, unknown>) ? true : null),
        60000,
        'model geometry',
      );

      // Wait for FULL streaming completion.
      // SCS is a progressive format — geometry loads from low-res to high-res.
      // Converting too early gives a partial STL (150MB instead of 700MB).
      // Strategy: watch the node count — when it stabilizes for 5 seconds,
      // streaming is likely complete. Also try HOOPS callbacks as a bonus.
      addLog('Waiting for full geometry download...');
      let streamComplete = false;

      try {
        // Try HOOPS callback-based detection
        let callbackFired = false;
        try {
          if (typeof (hwv as Record<string, unknown>).setCallbacks === 'function') {
            (hwv as { setCallbacks: (c: Record<string, unknown>) => void }).setCallbacks({
              streamingDeactivated: () => { callbackFired = true; },
              sceneReady: () => { callbackFired = true; },
            });
          }
        } catch {
          // Non-critical
        }

        // Poll: wait for streamingDeactivated callback OR stable node count
        const root =
          typeof (model as Record<string, unknown>).getAbsoluteRootNode === 'function'
            ? ((model as Record<string, unknown>).getAbsoluteRootNode as () => unknown)()
            : typeof (model as Record<string, unknown>).getRootNode === 'function'
              ? ((model as Record<string, unknown>).getRootNode as () => unknown)()
              : null;

        let lastNodeCount = 0;
        let stableTicks = 0;
        const startTime = Date.now();

        await new Promise<void>((resolve) => {
          const pollInterval = setInterval(() => {
            // Check HOOPS callback
            if (callbackFired) {
              clearInterval(pollInterval);
              streamComplete = true;
              addLog('Stream complete (callback).', 'success');
              resolve();
              return;
            }

            // Check model ready
            try {
              if (typeof (hwv as Record<string, unknown>).getModelReady === 'function' &&
                  (hwv as { getModelReady: () => boolean }).getModelReady()) {
                clearInterval(pollInterval);
                streamComplete = true;
                addLog('Stream complete (model ready).', 'success');
                resolve();
                return;
              }
            } catch {
              // ignore
            }

            // Check stable node count
            try {
              const kids = typeof (model as Record<string, unknown>).getNodeChildren === 'function'
                ? ((model as Record<string, unknown>).getNodeChildren as (n: unknown) => unknown[])(root)
                : [];
              const count = kids.length;
              if (count === lastNodeCount && count > 0) {
                stableTicks++;
                if (stableTicks >= 5) { // 5 seconds of stable count
                  clearInterval(pollInterval);
                  streamComplete = true;
                  addLog('Stream complete (stable).', 'success');
                  resolve();
                }
              } else {
                lastNodeCount = count;
                stableTicks = 0;
              }
            } catch {
              // ignore
            }

            // Hard timeout: 120 seconds
            if (Date.now() - startTime > 120000) {
              clearInterval(pollInterval);
              addLog('Stream timeout — using available geometry.', 'error');
              resolve();
            }
          }, 1000);
        });
      } catch {
        addLog('Stream wait error — using available geometry.', 'error');
      }

      if (streamComplete) {
        addLog('Full geometry ready for conversion.', 'success');
      }

      // Try to set Orbit operator explicitly for best rotation UX.
      // HOOPS defaults to Navigate (which already supports orbit), so this
      // is a nice-to-have — not a blocker.
      try {
        const view = (hwv as Record<string, unknown>).view;
        const opMgr =
          (hwv as Record<string, unknown>).operatorManager ??
          (view ? (view as Record<string, unknown>).operatorManager : null);
        if (opMgr && typeof (opMgr as Record<string, unknown>).set === 'function') {
          // Replace Select (index 1) with Orbit so left-click rotates
          (opMgr as { set: (op: number, idx: number) => void }).set(2, 1);
          addLog('Orbit mode enabled.', 'success');
        }
        // If operatorManager not found, Navigate mode still provides orbit
      } catch {
        // Non-critical — Navigate mode already handles rotation
      }

      // CSS + MutationObserver already handle hiding HOOPS UI from the start.
      // Just do one final cleanup pass to catch anything missed.
      hideHoopsUI(freshDiv);

      return model as Record<string, unknown>;
    },
    [addLog],
  );

  /* ---------- Handle file selection ---------- */
  const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB

  const handleFile = useCallback(
    async (f: File) => {
      if (!f.name.toLowerCase().endsWith('.scs')) {
        addLog('Please select an .scs file.', 'error');
        return;
      }
      if (f.size > MAX_FILE_SIZE) {
        addLog(`File too large (${formatBytes(f.size)}). Maximum is 500 MB.`, 'error');
        return;
      }
      if (f.size === 0) {
        addLog('File is empty.', 'error');
        return;
      }
      setFile(f);
      setStlResult(null);
      if (stlUrlRef.current) {
        URL.revokeObjectURL(stlUrlRef.current);
        stlUrlRef.current = '';
      }
      addLog(`File selected: ${f.name} (${formatBytes(f.size)})`);

      try {
        setViewerMounted(false);
        const model = await mountAndWait(f);
        modelRef.current = model;
        setViewerMounted(true);
      } catch (err) {
        addLog(
          `Mount failed: ${err instanceof Error ? err.message : String(err)}`,
          'error',
        );
      }
    },
    [addLog, mountAndWait],
  );

  /* ---------- Convert ---------- */
  const handleConvert = useCallback(async () => {
    const currentFile = fileRef.current;
    if (!currentFile) return;
    if (!modelRef.current) {
      addLog('No model loaded. Please load a file first.', 'error');
      return;
    }
    setConverting(true);
    setStlResult(null);
    addLog('Starting conversion...');

    try {
      let result = await buildStl(modelRef.current, flipZ, addLog);
      addLog(
        `Raw extraction: ${result.triCount.toLocaleString()} triangles, ${formatBytes(result.bytes.byteLength)}`,
      );

      // Apply mesh simplification if quality < original
      if (quality !== 'original') {
        const ratio = QUALITY_RATIOS[quality];
        addLog(`Simplifying to ${QUALITY_LABELS[quality]}...`);
        result = await simplifyStl(result.bytes, result.triCount, ratio, addLog);
      }

      setStlResult(result);
      if (stlUrlRef.current) URL.revokeObjectURL(stlUrlRef.current);
      stlUrlRef.current = URL.createObjectURL(
        new Blob([result.bytes], { type: 'application/octet-stream' }),
      );
      addLog(
        `Done! ${result.triCount.toLocaleString()} triangles, ${formatBytes(result.bytes.byteLength)}`,
        'success',
      );
    } catch (err) {
      addLog(
        `Conversion failed: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
    } finally {
      setConverting(false);
    }
  }, [flipZ, quality, addLog]);

  /* ---------- Download ---------- */
  const handleDownload = useCallback(() => {
    if (!stlResult || !stlUrlRef.current || !fileRef.current) return;
    const a = document.createElement('a');
    a.href = stlUrlRef.current;
    a.download = fileRef.current.name.replace(/\.scs$/i, '.stl');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    addLog('STL file downloaded.', 'success');
  }, [stlResult, addLog]);

  /* ---------- Reset ---------- */
  const handleReset = useCallback(() => {
    setFile(null);
    fileRef.current = null;
    setStlResult(null);
    setViewerMounted(false);
    modelRef.current = null;
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = '';
    }
    if (stlUrlRef.current) {
      URL.revokeObjectURL(stlUrlRef.current);
      stlUrlRef.current = '';
    }
    if (viewerContainerRef.current) {
      while (viewerContainerRef.current.firstChild) {
        viewerContainerRef.current.removeChild(
          viewerContainerRef.current.firstChild,
        );
      }
    }
    setLogs([]);
    logIdRef.current = 0;
    addLog('Reset complete.');
  }, [addLog]);

  /* ---------- Drag & Drop ---------- */
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      const f = e.dataTransfer.files?.[0];
      if (f) handleFile(f);
    },
    [handleFile],
  );

  /* ---------- Auto-scroll log ---------- */
  const logEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  /* ---------- Render ---------- */
  return (
    <div className="dark min-h-screen flex flex-col bg-[#0a0f1a] text-gray-100">
      {/* ──── Header ──── */}
      <header className="border-b border-emerald-900/40 bg-[#0d1422]/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-500/20">
            <Box className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight">
              <span className="text-emerald-400">SCS</span>
              <span className="mx-1.5 text-gray-500">&rarr;</span>
              <span className="text-teal-300">STL</span>
              <span className="text-gray-400 font-normal ml-2 text-sm">
                Converter
              </span>
            </h1>
          </div>
          <div className="ml-auto flex items-center gap-2 text-xs text-gray-500">
            {!hoopsReady && (
              <span className="flex items-center gap-1.5 text-amber-400">
                <Loader2 className="w-3 h-3 animate-spin" />
                Loading engine...
              </span>
            )}
            {hoopsReady && (
              <span className="flex items-center gap-1.5 text-emerald-400">
                <CheckCircle2 className="w-3 h-3" />
                Engine ready
              </span>
            )}
          </div>
        </div>
      </header>

      {/* ──── Main ──── */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 h-full">
          {/* ── Left Panel ── */}
          <div className="lg:col-span-2 flex flex-col gap-4">
            {/* Upload Zone */}
            <div
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`
                relative cursor-pointer rounded-xl border-2 border-dashed
                transition-all duration-200 p-6 text-center
                ${
                  dragOver
                    ? 'border-emerald-400 bg-emerald-500/10 scale-[1.01]'
                    : file
                      ? 'border-emerald-700/50 bg-emerald-950/20'
                      : 'border-gray-700 bg-gray-900/40 hover:border-emerald-600/60 hover:bg-gray-900/60'
                }
              `}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".scs"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                }}
              />
              {!file ? (
                <div className="flex flex-col items-center gap-3">
                  <div className="w-14 h-14 rounded-full bg-emerald-900/40 flex items-center justify-center">
                    <Upload className="w-7 h-7 text-emerald-400" />
                  </div>
                  <div>
                    <p className="font-medium text-gray-200">
                      Drop your .scs file here
                    </p>
                    <p className="text-sm text-gray-500 mt-1">
                      or click to browse
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <div className="w-12 h-12 rounded-full bg-emerald-900/40 flex items-center justify-center">
                    <FileBox className="w-6 h-6 text-emerald-400" />
                  </div>
                  <p className="font-semibold text-emerald-300 truncate max-w-full">
                    {file.name}
                  </p>
                  <p className="text-sm text-gray-400">
                    {formatBytes(file.size)}
                  </p>
                </div>
              )}
            </div>

            {/* Settings Card */}
            <div className="rounded-xl border border-gray-800 bg-[#111827]/80 p-4 space-y-4">
              <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
                Settings
              </h2>

              {/* Flip Z Toggle */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <FlipVertical className="w-4 h-4 text-teal-400" />
                  <div>
                    <p className="text-sm font-medium text-gray-200">
                      Flip Z-Axis
                    </p>
                    <p className="text-xs text-gray-500">
                      For slicer compatibility
                    </p>
                  </div>
                </div>
                <Switch
                  checked={flipZ}
                  onCheckedChange={setFlipZ}
                  className="data-[state=checked]:bg-emerald-600"
                />
              </div>

              {/* Quality Selector */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <Layers className="w-4 h-4 text-teal-400" />
                  <div>
                    <p className="text-sm font-medium text-gray-200">
                      Quality
                    </p>
                    <p className="text-xs text-gray-500">
                      Lower = smaller file
                    </p>
                  </div>
                </div>
                <select
                  value={quality}
                  onChange={(e) => setQuality(e.target.value as QualityPreset)}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 cursor-pointer"
                >
                  {(Object.keys(QUALITY_LABELS) as QualityPreset[]).map((q) => (
                    <option key={q} value={q}>
                      {QUALITY_LABELS[q]}
                    </option>
                  ))}
                </select>
              </div>

              {/* Quality Info */}
              <div className="rounded-lg bg-gray-900/60 p-2.5 text-xs text-gray-500 space-y-1">
                {quality === 'draft' && (
                  <>
                    <p className="text-amber-400 font-medium">Draft — ~5% of triangles</p>
                    <p>Good for: test prints, checking fit &amp; scale</p>
                  </>
                )}
                {quality === 'standard' && (
                  <>
                    <p className="text-emerald-400 font-medium">Standard — ~25% of triangles</p>
                    <p>Good for: most 3D prints, best size/quality ratio</p>
                  </>
                )}
                {quality === 'high' && (
                  <>
                    <p className="text-blue-400 font-medium">High — ~60% of triangles</p>
                    <p>Good for: detailed miniatures, visible surface detail</p>
                  </>
                )}
                {quality === 'original' && (
                  <>
                    <p className="text-purple-400 font-medium">Original — 100% lossless</p>
                    <p>Good for: archival, re-editing. File may be very large.</p>
                  </>
                )}
              </div>
            </div>

            {/* Actions Card */}
            <div className="rounded-xl border border-gray-800 bg-[#111827]/80 p-4 space-y-3">
              <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
                Actions
              </h2>
              <div className="grid grid-cols-1 gap-2.5">
                <Button
                  onClick={handleConvert}
                  disabled={!viewerMounted || converting}
                  className="w-full bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white shadow-lg shadow-emerald-500/20 disabled:opacity-50 disabled:shadow-none"
                >
                  {converting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Converting...
                    </>
                  ) : (
                    <>
                      <Box className="w-4 h-4" />
                      Convert to STL
                    </>
                  )}
                </Button>

                <Button
                  onClick={handleDownload}
                  disabled={!stlResult}
                  variant="outline"
                  className="w-full border-emerald-700/50 text-emerald-300 hover:bg-emerald-950/40 hover:text-emerald-200 disabled:opacity-40"
                >
                  <Download className="w-4 h-4" />
                  Download STL
                  {stlResult && (
                    <span className="text-xs text-gray-500 ml-1">
                      ({formatBytes(stlResult.bytes.byteLength)})
                    </span>
                  )}
                </Button>

                <Button
                  onClick={handleReset}
                  variant="ghost"
                  className="w-full text-gray-400 hover:text-gray-200 hover:bg-gray-800/60"
                >
                  <RotateCcw className="w-4 h-4" />
                  Reset
                </Button>
              </div>

              {stlResult && (
                <div className="mt-2 rounded-lg bg-emerald-950/30 border border-emerald-800/30 p-3">
                  <div className="flex items-center gap-2 text-emerald-400 text-sm font-medium">
                    <CheckCircle2 className="w-4 h-4" />
                    Conversion Complete
                  </div>
                  <p className="text-xs text-gray-400 mt-1">
                    {stlResult.triCount.toLocaleString()} triangles &middot;{' '}
                    {formatBytes(stlResult.bytes.byteLength)}
                  </p>
                </div>
              )}
            </div>

            {/* Log Panel */}
            <div className="rounded-xl border border-gray-800 bg-[#111827]/80 flex flex-col overflow-hidden flex-1 min-h-[200px]">
              <div className="px-4 py-2.5 border-b border-gray-800 flex items-center gap-2">
                <Info className="w-3.5 h-3.5 text-gray-500" />
                <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
                  Log
                </h2>
              </div>
              <ScrollArea className="flex-1 max-h-64">
                <div className="p-3 space-y-1 font-mono text-xs">
                  {logs.length === 0 && (
                    <p className="text-gray-600 italic">
                      Waiting for activity...
                    </p>
                  )}
                  {logs.map((l) => (
                    <div
                      key={l.id}
                      className={`flex gap-2 ${
                        l.level === 'error'
                          ? 'text-red-400'
                          : l.level === 'success'
                            ? 'text-emerald-400'
                            : 'text-gray-400'
                      }`}
                    >
                      <span className="text-gray-600 shrink-0">{l.ts}</span>
                      <span className="shrink-0">
                        {l.level === 'error' ? (
                          <AlertCircle className="w-3 h-3 inline" />
                        ) : l.level === 'success' ? (
                          <CheckCircle2 className="w-3 h-3 inline" />
                        ) : (
                          <Info className="w-3 h-3 inline" />
                        )}
                      </span>
                      <span className="break-all">{l.text}</span>
                    </div>
                  ))}
                  <div ref={logEndRef} />
                </div>
              </ScrollArea>
            </div>
          </div>

          {/* ── Right Panel — 3D Viewer ── */}
          <div className="lg:col-span-3 flex flex-col">
            <div className="rounded-xl border border-gray-800 bg-[#111827]/80 flex-1 flex flex-col overflow-hidden min-h-[400px]">
              <div className="px-4 py-2.5 border-b border-gray-800 flex items-center gap-2">
                <Box className="w-3.5 h-3.5 text-teal-400" />
                <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
                  3D Preview
                </h2>
                {viewerMounted && (
                  <span className="ml-auto text-xs text-emerald-400 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Live
                  </span>
                )}
              </div>
              <div className="flex-1 relative bg-[#080c14]">
                {/* React must NOT render children into this div */}
                <div
                  ref={viewerContainerRef}
                  className="absolute inset-0"
                />
                {!viewerMounted && !file && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-gray-600">
                    <Box className="w-16 h-16 opacity-20" />
                    <p className="text-sm">Upload an SCS file to preview</p>
                  </div>
                )}
                {!viewerMounted && file && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-gray-400">
                    <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
                    <p className="text-sm">Loading 3D viewer...</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* ──── Footer ──── */}
      <footer className="border-t border-gray-800/60 bg-[#0a0f1a]/80 mt-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-gray-600">
          <span>
            SCS &rarr; STL Converter &middot; Powered by HOOPS Communicator
          </span>
          <span>
            All processing happens locally in your browser. No data is uploaded.
          </span>
        </div>
      </footer>
    </div>
  );
}
