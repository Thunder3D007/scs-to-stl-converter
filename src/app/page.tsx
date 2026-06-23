"use client";

import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  Upload,
  Download,
  Box,
  Settings2,
  RotateCcw,
  CheckCircle2,
  AlertCircle,
  Loader2,
  FileBox,
  Zap,
  Eye,
  FlipVertical,
} from "lucide-react";

/* ─── types ─── */
interface TriResult {
  triCount: number;
  bytes: ArrayBuffer;
}

interface ConvertLog {
  time: string;
  msg: string;
  type: "info" | "success" | "error";
}

/* ─── helpers ─── */
function logMsg(msg: string, type: ConvertLog["type"] = "info"): ConvertLog {
  return { time: new Date().toLocaleTimeString(), msg, type };
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(2)} MB`;
}

function triggerDownload(data: ArrayBuffer, name: string) {
  const blob = new Blob([data], { type: "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

/* ─── safe wrapper ─── */
function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/* ─── HOOPS detection helpers ─── */
function looksLikeViewer(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const m =
    safe(() => (v as Record<string, unknown>).model) ??
    safe(() =>
      typeof (v as Record<string, unknown>).getModel === "function"
        ? (v as Record<string, { getModel: () => unknown }>).getModel()
        : undefined
    );
  return !!(
    m &&
    typeof (m as Record<string, unknown>).getNodeChildren === "function"
  );
}

function findWebViewer(rootEl: HTMLElement): unknown {
  const seen = new WeakSet();
  function walkFiber(fiber: unknown, depth: number): unknown {
    if (!fiber || depth > 200 || seen.has(fiber as object)) return null;
    seen.add(fiber as object);
    for (const key of [
      "stateNode",
      "memoizedState",
      "memoizedProps",
      "ref",
    ] as const) {
      const v = safe(() => (fiber as Record<string, unknown>)[key]);
      if (looksLikeViewer(v)) return v;
      if (v && typeof v === "object") {
        const cur = safe(() => (v as { current?: unknown }).current);
        if (looksLikeViewer(cur)) return cur;
        let h = v as Record<string, unknown>;
        for (let i = 0; i < 80 && h; i++) {
          if (looksLikeViewer(h)) return h;
          const hc = safe(() => (h as { current?: unknown }).current);
          if (looksLikeViewer(hc)) return hc;
          for (const k of ["baseState", "memoizedState"] as const) {
            const inner = safe(() => (h as Record<string, unknown>)[k]);
            if (looksLikeViewer(inner)) return inner;
          }
          h = safe(() => (h as { next?: unknown }).next) as Record<
            string,
            unknown
          >;
        }
      }
    }
    return (
      walkFiber(
        safe(() => (fiber as { child?: unknown }).child),
        depth + 1
      ) ??
      walkFiber(
        safe(() => (fiber as { sibling?: unknown }).sibling),
        depth + 1
      )
    );
  }

  const stack = [rootEl];
  while (stack.length) {
    const el = stack.pop()!;
    const props = safe(() => Object.getOwnPropertyNames(el)) ?? [];
    for (const p of props) {
      if (
        !p.startsWith("__reactFiber") &&
        !p.startsWith("__reactInternalInstance")
      )
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
      typeof model.getAbsoluteRootNode === "function"
        ? (model.getAbsoluteRootNode as () => unknown)()
        : typeof model.getRootNode === "function"
          ? (model.getRootNode as () => unknown)()
          : null;
    const kids =
      typeof model.getNodeChildren === "function"
        ? (model.getNodeChildren as (n: unknown) => unknown[])(root)
        : [];
    return Array.isArray(kids) && kids.length > 0;
  } catch {
    return false;
  }
}

/* ─── polling ─── */
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor<T>(
  check: () => T | null,
  timeoutMs: number,
  label: string
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = check();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label} (${timeoutMs}ms)`);
}

/* ─── main page ─── */
export default function SCSConverter() {
  const [logs, setLogs] = useState<ConvertLog[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [converting, setConverting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [modelReady, setModelReady] = useState(false);
  const [flipZ, setFlipZ] = useState(true);
  const [result, setResult] = useState<TriResult | null>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  const blobUrlRef = useRef<string | null>(null);

  const addLog = useCallback((msg: string, type: ConvertLog["type"] = "info") => {
    setLogs((prev) => [...prev, logMsg(msg, type)]);
  }, []);

  /* ─── load HOOPS bundle ─── */
  useEffect(() => {
    if (document.getElementById("hoops-bundle")) return;
    const script = document.createElement("script");
    script.id = "hoops-bundle";
    script.src = "/hoops/bundle.js";
    script.async = true;
    document.head.appendChild(script);
  }, []);

  /* ─── mount viewer ─── */
  const mountAndWait = useCallback(async () => {
    const GcHoopsViewer = (window as Record<string, unknown>)
      .GcHoopsViewer as Record<string, unknown> | undefined;
    if (!GcHoopsViewer || typeof GcHoopsViewer.mountViewer !== "function") {
      throw new Error("HOOPS Viewer bundle did not load");
    }

    if (mountedRef.current) {
      try {
        (GcHoopsViewer.unmountViewer as () => void)();
      } catch {}
      mountedRef.current = false;
    }
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    blobUrlRef.current = URL.createObjectURL(file!);

    addLog("Loading 3D viewer...");
    (GcHoopsViewer.mountViewer as (
      el: HTMLElement,
      opts: Record<string, unknown>
    ) => void)(viewerRef.current!, {
      file: blobUrlRef.current,
      onAction: () => {},
      onError: (e: unknown) => addLog(`Viewer error: ${e}`, "error"),
    });
    mountedRef.current = true;

    addLog("Waiting for WebViewer...");
    const hwv = await waitFor(
      () => findWebViewer(viewerRef.current!) as Record<string, unknown> | null,
      20000,
      "WebViewer instance"
    );
    addLog("WebViewer found.");

    const model =
      typeof (hwv as Record<string, unknown>).getModel === "function"
        ? ((hwv as { getModel: () => unknown }).getModel() as Record<
            string,
            unknown
          >)
        : (hwv as Record<string, unknown>).model;
    if (!model || typeof model.getNodeChildren !== "function") {
      throw new Error("Model surface unrecognized");
    }

    addLog("Streaming geometry...");
    await waitFor(
      () => (modelHasGeometry(model) ? true : null),
      60000,
      "model geometry"
    );
    return model;
  }, [file, addLog]);

  /* ─── build STL ─── */
  const buildStl = useCallback(
    async (
      model: Record<string, unknown>,
      shouldFlipZ: boolean
    ): Promise<TriResult> => {
      const root =
        typeof model.getAbsoluteRootNode === "function"
          ? (model.getAbsoluteRootNode as () => unknown)()
          : (model.getRootNode as () => unknown)();
      const nodes = (model.getNodeChildren as (n: unknown) => unknown[])(root);

      const transform = (
        m: number[],
        x: number,
        y: number,
        z: number
      ): number[] => {
        const o = [
          m[0] * x + m[4] * y + m[8] * z + m[12],
          m[1] * x + m[5] * y + m[9] * z + m[13],
          m[2] * x + m[6] * y + m[10] * z + m[14],
        ];
        if (shouldFlipZ) o[2] = -o[2];
        return o;
      };

      const transformDir = (
        m: number[],
        x: number,
        y: number,
        z: number
      ): number[] => {
        const o = [
          m[0] * x + m[4] * y + m[8] * z,
          m[1] * x + m[5] * y + m[9] * z,
          m[2] * x + m[6] * y + m[10] * z,
        ];
        if (shouldFlipZ) o[2] = -o[2];
        return o;
      };

      const tris: number[][] = [];
      let triCount = 0;
      let skipped = 0;

      for (const id of nodes) {
        let mesh: Record<string, unknown> | null = null;
        try {
          mesh = (await (model.getNodeMeshData as (id: unknown) => Promise<
            Record<string, unknown>
          >)(id)) as Record<string, unknown> | null;
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
          if (typeof model.getNodeNetMatrix === "function")
            matObj = (model.getNodeNetMatrix as (id: unknown) => unknown)(id);
          else if (typeof model.getNetMatrix === "function")
            matObj = (model.getNetMatrix as (id: unknown) => unknown)(id);
          if (matObj && typeof (matObj as Promise<unknown>).then === "function")
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
            "function"
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
            if (shouldFlipZ) {
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

      if (skipped) addLog(`Skipped ${skipped} nodes with errors`, "error");
      if (!triCount) throw new Error("No triangles collected");

      /* binary STL */
      const buffer = new ArrayBuffer(84 + triCount * 50);
      const dv = new DataView(buffer);
      dv.setUint32(80, triCount, true);
      let off = 84;
      for (const t of tris) {
        for (let i = 0; i < 12; i++) dv.setFloat32(off + i * 4, t[i], true);
        off += 48;
        dv.setUint16(off, 0, true);
        off += 2;
      }

      return { triCount, bytes: buffer };
    },
    [addLog]
  );

  /* ─── file handler ─── */
  const handleFile = useCallback(
    async (f: File) => {
      if (!f.name.toLowerCase().endsWith(".scs")) {
        addLog("Please select an .scs file", "error");
        return;
      }
      setFile(f);
      setResult(null);
      setModelReady(false);
      setLogs([logMsg(`Selected: ${f.name} (${formatBytes(f.size)})`)]);
      setLoading(true);

      try {
        const model = await mountAndWait();
        addLog("Model loaded — ready to convert", "success");
        setModelReady(true);
      } catch (e) {
        addLog(
          `Preview failed: ${e instanceof Error ? e.message : String(e)}`,
          "error"
        );
      } finally {
        setLoading(false);
      }
    },
    [mountAndWait, addLog]
  );

  /* ─── convert ─── */
  const handleConvert = useCallback(async () => {
    if (!file) return;
    setConverting(true);
    setResult(null);
    addLog("Starting conversion...");

    try {
      const model = await mountAndWait();
      await sleep(750);
      addLog("Extracting mesh data...");
      const stl = await buildStl(model, flipZ);
      setResult(stl);
      addLog(
        `Built STL: ${stl.triCount.toLocaleString()} triangles, ${formatBytes(stl.bytes.byteLength)}`,
        "success"
      );
    } catch (e) {
      addLog(
        `Conversion failed: ${e instanceof Error ? e.message : String(e)}`,
        "error"
      );
    } finally {
      setConverting(false);
    }
  }, [file, flipZ, mountAndWait, buildStl, addLog]);

  /* ─── download ─── */
  const handleDownload = useCallback(() => {
    if (!result || !file) return;
    const name = file.name.replace(/\.scs$/i, "") + ".stl";
    triggerDownload(result.bytes, name);
    addLog(`Downloaded ${name}`, "success");
  }, [result, file, addLog]);

  /* ─── reset ─── */
  const handleReset = useCallback(() => {
    setFile(null);
    setResult(null);
    setModelReady(false);
    setLoading(false);
    setConverting(false);
    setLogs([]);
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    blobUrlRef.current = null;
    mountedRef.current = false;
  }, []);

  /* ─── drag & drop ─── */
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const f = e.dataTransfer.files[0];
      if (f) handleFile(f);
    },
    [handleFile]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Header */}
      <header className="border-b border-border/50 bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <Box className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">
                SCS → STL Converter
              </h1>
              <p className="text-xs text-muted-foreground">
                Powered by HOOPS Communicator Engine
              </p>
            </div>
          </div>
          {file && (
            <button
              onClick={handleReset}
              className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg border border-border hover:bg-accent transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 py-6">
        {!file ? (
          /* ─── Upload Zone ─── */
          <div className="flex items-center justify-center min-h-[70vh]">
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              className="w-full max-w-2xl"
            >
              <div
                className="border-2 border-dashed border-border rounded-2xl p-12 text-center hover:border-emerald-500/50 hover:bg-emerald-500/5 transition-all duration-300 cursor-pointer group"
                onClick={() =>
                  document.getElementById("scs-file-input")?.click()
                }
              >
                <div className="w-20 h-20 mx-auto rounded-2xl bg-gradient-to-br from-emerald-500/10 to-teal-500/10 flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                  <Upload className="w-9 h-9 text-emerald-500" />
                </div>
                <h2 className="text-xl font-semibold mb-2">
                  Drop your .scs file here
                </h2>
                <p className="text-muted-foreground text-sm mb-6">
                  or click to browse — supports HOOPS Stream Cache format
                </p>
                <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-500/10 text-emerald-600 text-sm font-medium">
                  <Zap className="w-3.5 h-3.5" />
                  100% browser-based, no upload to server
                </div>
                <input
                  id="scs-file-input"
                  type="file"
                  accept=".scs"
                  className="hidden"
                  onChange={(e) =>
                    e.target.files?.[0] && handleFile(e.target.files[0])
                  }
                />
              </div>

              {/* Features */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-8">
                {[
                  {
                    icon: Eye,
                    title: "3D Preview",
                    desc: "Visualize your model before converting",
                  },
                  {
                    icon: Zap,
                    title: "Exact Geometry",
                    desc: "Uses official HOOPS engine for perfect mesh",
                  },
                  {
                    icon: FlipVertical,
                    title: "Z-Flip Fix",
                    desc: "Automatic Z-axis correction for slicers",
                  },
                ].map((feat) => (
                  <div
                    key={feat.title}
                    className="flex items-start gap-3 p-4 rounded-xl border border-border/50 bg-card/50"
                  >
                    <feat.icon className="w-5 h-5 text-emerald-500 mt-0.5 shrink-0" />
                    <div>
                      <p className="text-sm font-medium">{feat.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {feat.desc}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          /* ─── Workspace ─── */
          <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-6 min-h-[70vh]">
            {/* Left Panel */}
            <div className="flex flex-col gap-4 order-2 lg:order-1">
              {/* File Info Card */}
              <div className="rounded-xl border border-border/50 bg-card/80 p-5">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                    <FileBox className="w-5 h-5 text-emerald-500" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm truncate">{file.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatBytes(file.size)}
                    </p>
                  </div>
                  {modelReady && (
                    <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
                  )}
                </div>

                {/* Settings */}
                <div className="space-y-3 pt-3 border-t border-border/50">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                    <Settings2 className="w-3.5 h-3.5" />
                    Settings
                  </p>
                  <label className="flex items-center gap-3 cursor-pointer group">
                    <div className="relative">
                      <input
                        type="checkbox"
                        checked={flipZ}
                        onChange={(e) => setFlipZ(e.target.checked)}
                        className="sr-only peer"
                      />
                      <div className="w-9 h-5 rounded-full bg-muted peer-checked:bg-emerald-500 transition-colors" />
                      <div className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">Flip Z Axis</p>
                      <p className="text-xs text-muted-foreground">
                        Fix Y-up → Z-up for slicers
                      </p>
                    </div>
                  </label>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-col gap-2">
                <button
                  onClick={handleConvert}
                  disabled={!modelReady || converting}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 text-white font-medium shadow-lg shadow-emerald-500/20 hover:shadow-emerald-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                >
                  {converting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Converting...
                    </>
                  ) : (
                    <>
                      <Zap className="w-4 h-4" />
                      Convert to STL
                    </>
                  )}
                </button>

                {result && (
                  <button
                    onClick={handleDownload}
                    className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border-2 border-emerald-500/30 text-emerald-600 font-medium hover:bg-emerald-500/10 transition-all"
                  >
                    <Download className="w-4 h-4" />
                    Download STL ({formatBytes(result.bytes.byteLength)})
                  </button>
                )}
              </div>

              {/* Result Card */}
              {result && (
                <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-5">
                  <div className="flex items-center gap-2 mb-3">
                    <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                    <p className="font-semibold text-emerald-600">
                      Conversion Successful
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <p className="text-muted-foreground text-xs">
                        Triangles
                      </p>
                      <p className="font-mono font-medium">
                        {result.triCount.toLocaleString()}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground text-xs">STL Size</p>
                      <p className="font-mono font-medium">
                        {formatBytes(result.bytes.byteLength)}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Log */}
              <div className="rounded-xl border border-border/50 bg-card/50 flex-1 min-h-[200px] overflow-hidden flex flex-col">
                <div className="px-4 py-2 border-b border-border/50 flex items-center justify-between">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Log
                  </p>
                  {logs.length > 0 && (
                    <button
                      onClick={() => setLogs([])}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <div className="p-3 font-mono text-xs space-y-1 overflow-y-auto max-h-[300px]">
                  {logs.length === 0 && (
                    <p className="text-muted-foreground">
                      Waiting for activity...
                    </p>
                  )}
                  {logs.map((l, i) => (
                    <div
                      key={i}
                      className={`flex gap-2 ${
                        l.type === "error"
                          ? "text-red-400"
                          : l.type === "success"
                            ? "text-emerald-400"
                            : "text-muted-foreground"
                      }`}
                    >
                      <span className="text-muted-foreground/50 shrink-0">
                        {l.time}
                      </span>
                      <span>{l.msg}</span>
                    </div>
                  ))}
                  {(loading || converting) && (
                    <div className="flex items-center gap-2 text-emerald-400">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      <span>Processing...</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Right Panel - 3D Viewer */}
            <div className="order-1 lg:order-2">
              <div className="rounded-xl border border-border/50 bg-card/50 overflow-hidden h-full min-h-[400px] relative">
                <div className="absolute top-3 left-3 z-10 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-black/60 backdrop-blur-sm text-xs text-white/80">
                  <Eye className="w-3.5 h-3.5" />
                  3D Preview
                </div>
                {!modelReady && !loading && (
                  <div className="flex items-center justify-center h-full text-muted-foreground">
                    <div className="text-center">
                      <Box className="w-12 h-12 mx-auto mb-3 opacity-20" />
                      <p className="text-sm">Preview will appear here</p>
                    </div>
                  </div>
                )}
                {loading && (
                  <div className="flex items-center justify-center h-full">
                    <div className="text-center">
                      <Loader2 className="w-8 h-8 mx-auto mb-3 animate-spin text-emerald-500" />
                      <p className="text-sm text-muted-foreground">
                        Loading 3D viewer...
                      </p>
                    </div>
                  </div>
                )}
                <div
                  ref={viewerRef}
                  className="w-full h-full"
                  style={{ minHeight: "400px" }}
                />
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-border/50 py-4 mt-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center justify-between text-xs text-muted-foreground">
          <p>
            SCS → STL Converter • HOOPS Communicator Engine
          </p>
          <p>100% client-side • No data uploaded</p>
        </div>
      </footer>
    </div>
  );
}
