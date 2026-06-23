"use client";

import React, { useState, useRef, useCallback, useMemo } from "react";
import { decompress } from "fzstd";
import { Canvas, useLoader } from "@react-three/fiber";
import { OrbitControls, Environment } from "@react-three/drei";
import * as THREE from "three";
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

interface ParsedMesh {
  positions: Float32Array;
  normals: Float32Array;
  triCount: number;
  indices: Uint32Array;
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
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ─── SCS PARSER (Direct ZSTD method) ─── */

/** Find all ZSTD frame start offsets in the data (magic: 0x28B52FFD) */
function findZstdFrames(data: Uint8Array): number[] {
  const offsets: number[] = [];
  const len = data.length - 4;
  for (let i = 0; i < len; i++) {
    if (
      data[i] === 0x28 &&
      data[i + 1] === 0xb5 &&
      data[i + 2] === 0x2f &&
      data[i + 3] === 0xfd
    ) {
      offsets.push(i);
    }
  }
  return offsets;
}

/** Parse an SCS file and extract all triangle geometry */
function parseSCS(scsData: Uint8Array, flipZ: boolean): ParsedMesh {
  const offsets = findZstdFrames(scsData);
  const allVerts: number[] = [];
  const allNormals: number[] = [];
  let totalTris = 0;

  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i];
    // Determine the end of this ZSTD frame (next frame start or end of data)
    const end = i + 1 < offsets.length ? offsets[i + 1] : scsData.length;
    const frameData = scsData.slice(start, end);

    let decompressed: Uint8Array;
    try {
      decompressed = decompress(frameData);
    } catch {
      // Not a valid ZSTD frame or decompression error — skip
      continue;
    }

    // Check for geometry frame header: 0x72000000 (little-endian)
    if (decompressed.length < 16) continue;
    if (
      decompressed[0] !== 0x72 ||
      decompressed[1] !== 0x00 ||
      decompressed[2] !== 0x00 ||
      decompressed[3] !== 0x00
    ) {
      continue;
    }

    // Skip the 12-byte geometry header, payload starts at offset 12
    // Each vertex: position(3 float32) + normal(3 float32) = 24 bytes = 6 floats
    const payload = decompressed.slice(12);
    const stride = 24; // bytes per vertex (6 floats * 4 bytes)
    const numVerts = Math.floor(payload.length / stride);
    if (numVerts < 3) continue;

    const actualSize = numVerts * stride;
    const floatView = new DataView(payload.buffer, payload.byteOffset, actualSize);

    // Validate: check that at least 30% of vertices have finite, reasonable values
    let validCount = 0;
    for (let v = 0; v < numVerts; v++) {
      const base = v * 6;
      const x = floatView.getFloat32(base * 4, true);
      const y = floatView.getFloat32((base + 1) * 4, true);
      const z = floatView.getFloat32((base + 2) * 4, true);
      if (isFinite(x) && isFinite(y) && isFinite(z) && Math.abs(x) < 500 && Math.abs(y) < 500 && Math.abs(z) < 500) {
        validCount++;
      }
    }

    if (validCount < numVerts * 0.3) continue;

    // Group into triangles: every 3 consecutive vertices = 1 triangle
    const numTris = Math.floor(numVerts / 3);
    if (numTris === 0) continue;

    for (let t = 0; t < numTris; t++) {
      let nx = 0, ny = 0, nz = 0;
      for (let v = 0; v < 3; v++) {
        const base = (t * 3 + v) * 6;
        const px = floatView.getFloat32(base * 4, true);
        const py = floatView.getFloat32((base + 1) * 4, true);
        const pz = floatView.getFloat32((base + 2) * 4, true);
        const nnx = floatView.getFloat32((base + 3) * 4, true);
        const nny = floatView.getFloat32((base + 4) * 4, true);
        const nnz = floatView.getFloat32((base + 5) * 4, true);

        allVerts.push(px, flipZ ? py : py, flipZ ? -pz : pz);
        nx += nnx;
        ny += nny;
        nz += flipZ ? -nnz : nnz;
      }
      // Face normal = average of 3 vertex normals
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      allNormals.push(nx / len, ny / len, nz / len);
      totalTris++;
    }
  }

  if (totalTris === 0) {
    throw new Error("No geometry found in SCS file. The file may be empty or use an unsupported format.");
  }

  // Build Three.js-compatible buffers
  const positions = new Float32Array(allVerts);
  const normals = new Float32Array(allNormals);
  const indices = new Uint32Array(totalTris * 3);
  for (let i = 0; i < totalTris * 3; i++) {
    indices[i] = i;
  }

  return { positions, normals, triCount: totalTris, indices };
}

/** Build binary STL from parsed mesh */
function buildSTL(mesh: ParsedMesh): TriResult {
  const { triCount, positions, normals: faceNormals } = mesh;
  const buffer = new ArrayBuffer(84 + triCount * 50);
  const dv = new DataView(buffer);

  // 80-byte header (null-padded)
  const header = "Binary STL - SCS Converter";
  for (let i = 0; i < 80; i++) {
    dv.setUint8(i, i < header.length ? header.charCodeAt(i) : 0);
  }

  // Triangle count at offset 80
  dv.setUint32(80, triCount, true);

  // Write triangles
  let off = 84;
  for (let t = 0; t < triCount; t++) {
    // Face normal (3 floats)
    dv.setFloat32(off, faceNormals[t * 3], true);
    dv.setFloat32(off + 4, faceNormals[t * 3 + 1], true);
    dv.setFloat32(off + 8, faceNormals[t * 3 + 2], true);
    off += 12;

    // 3 vertices
    for (let v = 0; v < 3; v++) {
      const vi = (t * 3 + v) * 3;
      dv.setFloat32(off, positions[vi], true);
      dv.setFloat32(off + 4, positions[vi + 1], true);
      dv.setFloat32(off + 8, positions[vi + 2], true);
      off += 12;
    }

    // Attribute byte count
    dv.setUint16(off, 0, true);
    off += 2;
  }

  return { triCount, bytes: buffer };
}

/* ─── 3D Preview Component ─── */
function MeshPreview({ mesh }: { mesh: ParsedMesh }) {
  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
    geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    geo.computeVertexNormals();
    return geo;
  }, [mesh]);

  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      <meshStandardMaterial
        color="#10b981"
        metalness={0.1}
        roughness={0.6}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function Scene({ mesh }: { mesh: ParsedMesh }) {
  return (
    <>
      <ambientLight intensity={0.4} />
      <directionalLight position={[5, 10, 7]} intensity={1.2} castShadow />
      <directionalLight position={[-3, -5, -5]} intensity={0.3} />
      <MeshPreview mesh={mesh} />
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.1}
        autoRotate
        autoRotateSpeed={1}
      />
      <Environment preset="studio" />
    </>
  );
}

/* ─── main page ─── */
export default function SCSConverter() {
  const [logs, setLogs] = useState<ConvertLog[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [converting, setConverting] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [mesh, setMesh] = useState<ParsedMesh | null>(null);
  const [flipZ, setFlipZ] = useState(true);
  const [result, setResult] = useState<TriResult | null>(null);

  const addLog = useCallback((msg: string, type: ConvertLog["type"] = "info") => {
    setLogs((prev) => [...prev, logMsg(msg, type)]);
  }, []);

  /* ─── file handler ─── */
  const handleFile = useCallback(
    async (f: File) => {
      if (!f.name.toLowerCase().endsWith(".scs")) {
        addLog("Please select an .scs file", "error");
        return;
      }

      setFile(f);
      setResult(null);
      setMesh(null);
      setLogs([logMsg(`Selected: ${f.name} (${formatBytes(f.size)})`)]);
      setParsing(true);

      try {
        addLog("Reading file...");
        const buffer = await f.arrayBuffer();
        const data = new Uint8Array(buffer);
        addLog(`File loaded: ${formatBytes(data.length)} — scanning ZSTD frames...`);

        const parsed = parseSCS(data, flipZ);
        setMesh(parsed);
        addLog(
          `Parsed: ${parsed.triCount.toLocaleString()} triangles, ${(parsed.positions.length / 3).toLocaleString()} vertices`,
          "success"
        );
      } catch (e) {
        addLog(
          `Parse failed: ${e instanceof Error ? e.message : String(e)}`,
          "error"
        );
      } finally {
        setParsing(false);
      }
    },
    [flipZ, addLog]
  );

  /* ─── re-parse when flipZ changes ─── */
  const handleReparse = useCallback(async () => {
    if (!file) return;
    setResult(null);
    setParsing(true);
    addLog(`Re-parsing with Z-flip ${flipZ ? "ON" : "OFF"}...`);

    try {
      const buffer = await file.arrayBuffer();
      const data = new Uint8Array(buffer);
      const parsed = parseSCS(data, flipZ);
      setMesh(parsed);
      addLog(
        `Re-parsed: ${parsed.triCount.toLocaleString()} triangles`,
        "success"
      );
    } catch (e) {
      addLog(
        `Re-parse failed: ${e instanceof Error ? e.message : String(e)}`,
        "error"
      );
    } finally {
      setParsing(false);
    }
  }, [file, flipZ, addLog]);

  /* ─── convert ─── */
  const handleConvert = useCallback(async () => {
    if (!mesh) return;
    setConverting(true);
    addLog("Building binary STL...");

    try {
      // Use setTimeout to let the UI update before heavy computation
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      const stl = buildSTL(mesh);
      setResult(stl);
      addLog(
        `STL ready: ${stl.triCount.toLocaleString()} triangles, ${formatBytes(stl.bytes.byteLength)}`,
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
  }, [mesh, addLog]);

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
    setMesh(null);
    setParsing(false);
    setConverting(false);
    setLogs([]);
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
                Direct ZSTD decompression — no server upload
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
                    title: "Direct ZSTD",
                    desc: "No HOOPS engine — pure JS decompression",
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
                  {mesh && (
                    <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
                  )}
                </div>

                {/* Stats */}
                {mesh && (
                  <div className="grid grid-cols-2 gap-3 mb-4">
                    <div>
                      <p className="text-muted-foreground text-xs">Triangles</p>
                      <p className="font-mono font-medium text-sm">
                        {mesh.triCount.toLocaleString()}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground text-xs">Vertices</p>
                      <p className="font-mono font-medium text-sm">
                        {(mesh.positions.length / 3).toLocaleString()}
                      </p>
                    </div>
                  </div>
                )}

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
                  <button
                    onClick={handleReparse}
                    disabled={!mesh || parsing}
                    className="w-full text-xs py-1.5 rounded-lg border border-border hover:bg-accent disabled:opacity-40 transition-colors"
                  >
                    Apply & Re-parse
                  </button>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-col gap-2">
                <button
                  onClick={handleConvert}
                  disabled={!mesh || converting}
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
                  {(parsing || converting) && (
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
                {!mesh && !parsing && (
                  <div className="flex items-center justify-center h-full text-muted-foreground">
                    <div className="text-center">
                      <Box className="w-12 h-12 mx-auto mb-3 opacity-20" />
                      <p className="text-sm">Preview will appear here</p>
                    </div>
                  </div>
                )}
                {parsing && (
                  <div className="flex items-center justify-center h-full">
                    <div className="text-center">
                      <Loader2 className="w-8 h-8 mx-auto mb-3 animate-spin text-emerald-500" />
                      <p className="text-sm text-muted-foreground">
                        Parsing SCS file...
                      </p>
                    </div>
                  </div>
                )}
                {mesh && !parsing && (
                  <div className="w-full h-full" style={{ minHeight: "400px" }}>
                    <Canvas
                      camera={{ position: [50, 50, 50], fov: 50 }}
                      style={{ width: "100%", height: "100%", minHeight: "400px" }}
                    >
                      <Scene mesh={mesh} />
                    </Canvas>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-border/50 py-4 mt-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center justify-between text-xs text-muted-foreground">
          <p>
            SCS → STL Converter • Direct ZSTD Decompression
          </p>
          <p>100% client-side • No data uploaded</p>
        </div>
      </footer>
    </div>
  );
}
