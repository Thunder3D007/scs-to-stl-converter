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
      const found = walkFiber(safe(() => (el as Record<string, unknown>)[p]), 0);
      if (found) return found;
    }
    for (const c of Array.from(el.children)) stack.push(c);
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
        if (flipZ) {
          tris.push([
            n[0], n[1], n[2],
            p0[0], p0[1], p0[2],
            p2[0], p2[1], p2[2],
            p1[0], p1[1], p1[2],
          ]);
        } else {
          tris.push([
            n[0], n[1], n[2],
            p0[0], p0[1], p0[2],
            p1[0], p1[1], p1[2],
            p2[0], p2[1], p2[2],
          ]);
        }
        triCount++;
        buf.length = 0;
      }
    }
  }

  if (skipped) console.log(`Skipped ${skipped} nodes with errors`);
  if (!triCount)
    throw new Error(
      'No triangles collected \u2014 model may not have streamed yet',
    );

  // Build binary STL
  const buffer = new ArrayBuffer(84 + triCount * 50);
  const dv = new DataView(buffer);
  dv.setUint32(80, triCount, true);
  let off = 84;
  for (const t of tris) {
    for (let i = 0; i < 12; i++) {
      dv.setFloat32(off, t[i], true);
      off += 4;
    }
    dv.setUint16(off, 0, true);
    off += 2;
  }
  return { triCount, bytes: buffer };
}

/* ------------------------------------------------------------------ */
/*  Format helpers                                                     */
/* ------------------------------------------------------------------ */

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
    if (document.getElementById('hoops-bundle')) {
      // Script tag already exists; check if loaded
      const check = () => {
        if ((window as Record<string, unknown>).GcHoopsViewer) {
          setHoopsReady(true);
          addLog('HOOPS engine ready.', 'success');
        }
      };
      check();
      return;
    }
    addLog('Loading HOOPS Communicator engine...');
    const script = document.createElement('script');
    script.id = 'hoops-bundle';
    script.src = '/hoops/bundle.js';
    script.async = true;
    script.onload = () => {
      // Give the bundle a tick to initialise
      const poll = setInterval(() => {
        if ((window as Record<string, unknown>).GcHoopsViewer) {
          clearInterval(poll);
          setHoopsReady(true);
          addLog('HOOPS engine ready.', 'success');
        }
      }, 200);
      // Timeout after 30 s
      setTimeout(() => clearInterval(poll), 30_000);
    };
    script.onerror = () => addLog('Failed to load HOOPS bundle.', 'error');
    document.head.appendChild(script);
  }, [addLog]);

  /* ---------- mountAndWait ---------- */
  const mountAndWait = useCallback(
    async (fileToMount: File): Promise<Record<string, unknown>> => {
      const GcHoopsViewer = (window as Record<string, unknown>)
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

      const model =
        typeof (hwv as Record<string, unknown>).getModel === 'function'
          ? (
              hwv as { getModel: () => unknown }
            ).getModel() as Record<string, unknown>
          : (hwv as Record<string, unknown>).model;
      if (!model || typeof model.getNodeChildren !== 'function') {
        throw new Error('Model surface unrecognized');
      }

      addLog('Streaming geometry...');
      await waitFor(
        () => (modelHasGeometry(model) ? true : null),
        60000,
        'model geometry',
      );
      addLog('Geometry streamed.', 'success');

      // Enable orbit/rotate interaction — HOOPS defaults to Select mode,
      // but for a preview we want Orbit (left-click drag to rotate).
      // Operator enum: Navigate=1, Orbit=2, Pan=3, Zoom=4, Select=10
      try {
        const view = (hwv as Record<string, unknown>).view;
        const opMgr =
          (hwv as Record<string, unknown>).operatorManager ??
          (view ? (view as Record<string, unknown>).operatorManager : null);
        if (opMgr && typeof (opMgr as Record<string, unknown>).set === 'function') {
          // Replace Select (index 1) with Orbit so left-click rotates
          (opMgr as { set: (op: number, idx: number) => void }).set(2, 1);
          addLog('Orbit mode enabled.', 'success');
        } else {
          addLog('OperatorManager not found — rotation may need manual enable', 'error');
        }
      } catch (e) {
        addLog(`Could not set orbit mode: ${e}`, 'error');
      }

      // Hide all HOOPS UI overlay panels — only keep the canvas visible
      // Small delay to let HOOPS finish rendering its full DOM tree
      await sleep(500);
      hideHoopsUI(freshDiv);

      return model;
    },
    [addLog],
  );

  /* ---------- Handle file selection ---------- */
  const handleFile = useCallback(
    async (f: File) => {
      if (!f.name.toLowerCase().endsWith('.scs')) {
        addLog('Please select an .scs file.', 'error');
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
      const result = await buildStl(modelRef.current, flipZ);
      setStlResult(result);
      if (stlUrlRef.current) URL.revokeObjectURL(stlUrlRef.current);
      stlUrlRef.current = URL.createObjectURL(
        new Blob([result.bytes], { type: 'application/octet-stream' }),
      );
      addLog(
        `Conversion done! ${result.triCount.toLocaleString()} triangles, ${formatBytes(result.bytes.byteLength)}`,
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
  }, [flipZ, addLog]);

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
