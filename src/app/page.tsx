"use client";

import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import FFT from "fft.js";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
// KaTeX CSS moved to globals.css to avoid bundling it with this page chunk

import type { Layout, Config, Data } from "plotly.js";
const Plot = dynamic(async () => {
  const Plotly = (await import("plotly.js-cartesian-dist-min")).default;
  const createPlotComponent = (await import("react-plotly.js/factory")).default as (
    plotly: unknown
  ) => React.ComponentType<{
    data: Data[];
    layout?: Partial<Layout> & { paper_bgcolor?: string; plot_bgcolor?: string };
    config?: Partial<Config> & { responsive?: boolean };
    style?: React.CSSProperties;
    useResizeHandler?: boolean;
    onRelayout?: (event: unknown) => void;
  }>;
  return createPlotComponent(Plotly);
}, { ssr: false, loading: () => <div className="text-sm text-muted-foreground">Loading charts…</div> });

// Lazy-load KaTeX only when needed
const BlockMath = dynamic(async () => {
  const mod = await import("react-katex");
  return { default: mod.BlockMath };
}, { ssr: false, loading: () => <div className="text-sm text-muted-foreground">Loading formula…</div> });

// Plotly-like notifier helper (matches .plotly-notifier styles in globals.css)
function showPlotlyNotifier(message: string, timeoutMs: number = 4000): void {
  if (typeof document === "undefined") return;
  const container = document.createElement("div");
  container.className = "plotly-notifier";
  container.style.opacity = "0"; // Start transparent for fade-in

  const fadeOutAndRemove = () => {
    container.style.opacity = "0";
    // Wait for transition to finish before removing
    setTimeout(() => {
      if (container.parentNode) {
        container.remove();
      }
    }, 300); // Should be > transition duration (0.2s)
  };

  const close = document.createElement("button");
  close.className = "notifier-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Close notification");
  close.title = "Close";
  close.onclick = fadeOutAndRemove;

  const note = document.createElement("div");
  note.className = "notifier-note";
  note.textContent = message;

  container.appendChild(close);
  container.appendChild(note);
  container.setAttribute("role", "status");
  container.setAttribute("aria-live", "polite");
  document.body.appendChild(container);

  // Fade in
  requestAnimationFrame(() => {
    container.style.opacity = "0.95";
  });

  window.setTimeout(fadeOutAndRemove, timeoutMs);
}

type ColumnKey =
  | "AccX(g)"
  | "AccY(g)"
  | "AccZ(g)"
  | "AsX(°/s)"
  | "AsY(°/s)"
  | "AsZ(°/s)"
  | "AngleX(°)"
  | "AngleY(°)"
  | "AngleZ(°)";

const COLUMN_KEYS: ColumnKey[] = [
  "AccX(g)",
  "AccY(g)",
  "AccZ(g)",
  "AsX(°/s)",
  "AsY(°/s)",
  "AsZ(°/s)",
  "AngleX(°)",
  "AngleY(°)",
  "AngleZ(°)",
];

type ParsedRow = { time: number } & Partial<Record<ColumnKey, number>>;

function parseTxtFile(file: File): Promise<ParsedRow[]> {
  return import("papaparse").then(({ default: Papa }) =>
    new Promise((resolve, reject) => {
      Papa.parse<Record<string, string | number>>(file, {
        header: true,
        delimiter: "\t",
        skipEmptyLines: true,
        dynamicTyping: (field) => COLUMN_KEYS.includes(field as ColumnKey),
        complete: (results) => {
          try {
            const data: ParsedRow[] = [];
            for (const row of results.data) {
              const timeStr = String(row["time"] ?? "");
              if (!timeStr) continue;
              const parsed = new Date(timeStr.replace(/\.(\d{1,3})$/, ".$1")).getTime();
              if (Number.isNaN(parsed)) continue;
              const out: ParsedRow = { time: parsed };
              for (const key of COLUMN_KEYS) {
                const v = row[key];
                const num = typeof v === "number" ? v : v != null && v !== "" ? Number(v) : NaN;
                if (Number.isFinite(num)) {
                  out[key] = num;
                }
              }
              data.push(out);
            }
            // Sort by monotonic time ascending and drop duplicate timestamps
            data.sort((a, b) => a.time - b.time);
            const dedup: ParsedRow[] = [];
            let lastT = Number.NEGATIVE_INFINITY;
            for (const r of data) {
              if (r.time === lastT) continue;
              dedup.push(r);
              lastT = r.time;
            }
            resolve(dedup);
          } catch (e) {
            reject(e);
          }
        },
        error: (err) => reject(err),
      });
    })
  );
}

function estimateSamplingHz(rows: ParsedRow[]): number | null {
  if (rows.length < 2) return null;
  const deltas: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const dt = rows[i].time - rows[i - 1].time;
    if (dt > 0) deltas.push(dt);
  }
  if (deltas.length === 0) return null;
  // Use median to be robust to outliers
  deltas.sort((a, b) => a - b);
  const mid = Math.floor(deltas.length / 2);
  const medianMs = deltas.length % 2 ? deltas[mid] : (deltas[mid - 1] + deltas[mid]) / 2;
  return 1000 / medianMs;
}

function computeFftWithPhase(acc: number[], sampleHz: number) {
  const N = acc.length;
  const pow2 = 1 << Math.ceil(Math.log2(Math.max(2, N)));

  const f = new FFT(pow2);
  const complexInput = f.createComplexArray();
  // Copy signal into the real part of the complex array
  for (let i = 0; i < N; i++) {
    complexInput[i * 2] = acc[i];
  }

  const complexOutput = f.createComplexArray();
  f.transform(complexOutput, complexInput);

  const freqs: number[] = [];
  const mags: number[] = [];
  const phases: number[] = [];
  const half = pow2 / 2;

  for (let k = 0; k <= half; k++) {
    const re = complexOutput[k * 2];
    const im = complexOutput[k * 2 + 1];
    
    const mag = Math.hypot(re, im);
    const f = (k * sampleHz) / pow2;
    
    freqs.push(f);
    mags.push(mag);
    phases.push(Math.atan2(im, re));
  }

  return { freqs, mags, phases, fftSize: pow2 } as ComplexSpectrum & { fftSize: number };
}

type Spectrum = { freqs: number[]; mags: number[] };
type ComplexSpectrum = { freqs: number[]; mags: number[]; phases: number[]; fftSize?: number };

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const arr = [...values].sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}



// Baseline smoothing removed; slider visually excludes low frequencies instead

type Peak = { index: number; freq: number; mag: number; residual: number };

function detectPeaksIgnoringNoiseFloor(spectrum: Spectrum, fminHz: number): Peak[] {
  const { freqs, mags } = spectrum;
  const n = Math.min(freqs.length, mags.length);
  if (n < 5) return [];
  // Robust threshold on raw magnitudes, above fminHz only
  const magsIn: number[] = [];
  for (let i = 0; i < n; i++) if (freqs[i] >= fminHz) magsIn.push(mags[i]);
  if (magsIn.length < 5) return [];
  const med = median(magsIn);
  const absDev = magsIn.map((v) => Math.abs(v - med));
  const mad = Math.max(1e-12, median(absDev));
  const threshold = med + 3 * mad;

  const peaks: Peak[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (freqs[i] < fminHz) continue;
    const val = mags[i];
    if (val > threshold && val > mags[i - 1] && val > mags[i + 1]) {
      peaks.push({ index: i, freq: freqs[i], mag: val, residual: val - threshold });
    }
  }
  peaks.sort((a, b) => b.residual - a.residual);
  return peaks;
}

// Removed fundamental estimation; we simply pick spectral peaks

function getHarmonicFrequencies(spectrum: Spectrum, fminHz: number): number[] {
  // Return peak frequencies above fmin, strongest first
  const peaks = detectPeaksIgnoringNoiseFloor(spectrum, fminHz)
    .filter((p) => p.freq >= fminHz)
    .sort((a, b) => b.mag - a.mag);
  const freqsDesc = peaks.map((p) => p.freq);
  // Deduplicate near-equal neighbors
  const dedup: number[] = [];
  for (const f of freqsDesc) {
    if (dedup.length === 0 || Math.abs(f - dedup[dedup.length - 1]) > 1e-6) dedup.push(f);
  }
  return dedup;
}

function buildVerticalLineTraces(spectrum: Spectrum, lineFreqs: number[], yMaxOverride?: number): Data[] {
  if (!spectrum || lineFreqs.length === 0) return [];
  const yMaxRaw = spectrum.mags.reduce((m, v) => (v > m ? v : m), 0);
  const yMax = yMaxOverride ?? yMaxRaw;
  return lineFreqs.map((freq) => ({
    x: [freq, freq],
    y: [0, yMax],
    type: "scatter",
    mode: "lines",
    line: { color: "#ef4444", width: 1.5, dash: "dot" },
    hoverinfo: "skip",
    showlegend: false,
  } as Data));
}

export default function Home() {
  const [rows, setRows] = useState<ParsedRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<ColumnKey>("AccX(g)");
  const [harmonicsCount, setHarmonicsCount] = useState<number>(0);
  const [fminHz, setFminHz] = useState<number>(0);
  const [showOriginal, setShowOriginal] = useState<boolean>(true);
  const [showReconstructed, setShowReconstructed] = useState<boolean>(true);
  const legendTipShownRef = useRef<boolean>(false);
  const hasZoomedRef = useRef<boolean>(false);
  const zoomTipTimerRef = useRef<NodeJS.Timeout | null>(null);
  const zoomTipShownRef = useRef<boolean>(false);
  const isDefaultFileRef = useRef<boolean>(true);

  useEffect(() => {
    // Warm up the KaTeX module in the background so the first render is instant.
    // Use requestIdleCallback when available to avoid competing with critical work.
    let cancelled = false;
    const preload = () => {
      // Dynamic import matches the specifier used by BlockMath above, so it reuses the cache.
      import("react-katex").catch(() => {});
    };
    const requestIdle: ((cb: () => void) => number) | null =
      typeof window !== "undefined" && typeof (window as unknown as { requestIdleCallback?: (cb: IdleRequestCallback) => number }).requestIdleCallback === "function"
        ? (cb) => (window as unknown as { requestIdleCallback: (cb: IdleRequestCallback) => number }).requestIdleCallback(() => cb())
        : null;
    if (requestIdle) {
      requestIdle(() => { if (!cancelled) preload(); });
    } else {
      const t = setTimeout(() => { if (!cancelled) preload(); }, 300);
      return () => { cancelled = true; clearTimeout(t); };
    }
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (harmonicsCount === 1 && !legendTipShownRef.current) {
      legendTipShownRef.current = true;
      showPlotlyNotifier("Click legend entries to show/hide traces");
    }
  }, [harmonicsCount]);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    try {
      const parsed = await parseTxtFile(file);
      if (!parsed.length) {
        setError("No valid rows parsed. Ensure the file is tab-delimited with header including AccX(g).");
        setRows(null);
        return;
      }
      setRows(parsed);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg || "Failed to parse file");
      setRows(null);
    }
  }, []);

  useEffect(() => {
    const loadDefaultFile = async () => {
      try {
        const res = await fetch("/example.txt");
        if (!res.ok) throw new Error("Example file not found in public/example.txt");
        const blob = await res.blob();
        await handleFile(new File([blob], "example.txt", { type: "text/plain" }));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        // Don't show an error if the file just doesn't exist, it's optional.
        if (!/not found/i.test(msg)) {
          setError(msg || "Failed to load example file");
        }
      }
    };
    if (!rows) {
      loadDefaultFile();
    }
  }, [handleFile, rows]);

  useEffect(() => {
    if (!rows || zoomTipShownRef.current) return;

    if (zoomTipTimerRef.current) {
      clearTimeout(zoomTipTimerRef.current);
    }
    hasZoomedRef.current = false;

    const timeout = isDefaultFileRef.current ? 10000 : 3000;

    zoomTipTimerRef.current = setTimeout(() => {
      if (!hasZoomedRef.current) {
        showPlotlyNotifier("Tip: Click and drag on the plot to zoom in.");
        zoomTipShownRef.current = true;
      }
    }, timeout);

    return () => {
      if (zoomTipTimerRef.current) {
        clearTimeout(zoomTipTimerRef.current);
      }
    };
  }, [rows]);

  const onPlotRelayout = useCallback(() => {
    hasZoomedRef.current = true;
    if (zoomTipTimerRef.current) {
      clearTimeout(zoomTipTimerRef.current);
    }
  }, []);

  const sampleHz = useMemo(() => (rows ? estimateSamplingHz(rows) : null), [rows]);
  const relTimesSec = useMemo(() => {
    if (!rows?.length) return [] as number[];
    // Time-normalize to 0, enforce monotonic increasing relative time
    const t0 = rows[0].time;
    const rel: number[] = new Array(rows.length);
    let prev = 0;
    for (let i = 0; i < rows.length; i++) {
      const t = (rows[i].time - t0) / 1000;
      prev = i === 0 ? 0 : Math.max(prev, t);
      rel[i] = prev;
    }
    return rel;
  }, [rows]);
  const series = useMemo(() => rows?.map((r) => r[selectedKey] ?? NaN) ?? [], [rows, selectedKey]);

  const spectrum = useMemo(() => {
    if (!rows || !sampleHz || !Number.isFinite(sampleHz)) return null;
    const clean = series.filter((v) => Number.isFinite(v)) as number[];
    if (clean.length < 4) return null;

    // FFT on the raw values, assuming uniform sampling at estimated sampleHz.
    // This matches the simple approach from the Python example, removing detrending, resampling and windowing.
    return computeFftWithPhase(clean, sampleHz);
  }, [series, sampleHz]);

  const harmonicFreqs = useMemo<number[]>(() => {
    if (!spectrum) return [];
    return getHarmonicFrequencies(spectrum, fminHz);
  }, [spectrum, fminHz]);

  const harmonicInfo = useMemo(() => {
    if (!spectrum || harmonicsCount === 0) return [];
    const info: { freq: number; mag: number; phase: number, amp: number }[] = [];
    const chosenFreqs = harmonicFreqs.slice(0, harmonicsCount);
    const phases = (spectrum as ComplexSpectrum).phases ?? [];
    const Nfft = (spectrum as ComplexSpectrum).fftSize ?? 1;

    for (const f of chosenFreqs) {
      let idx = 0;
      let best = Infinity;
      for (let i = 0; i < spectrum.freqs.length; i++) {
        const d = Math.abs(spectrum.freqs[i] - f);
        if (d < best) {
          best = d;
          idx = i;
        }
      }
      const mag = spectrum.mags[idx];
      const coherentGain = 1.0; // Rectangular window
      const amp = idx === 0 ? mag / Nfft : (2 * mag) / (Nfft * coherentGain);

      info.push({
        freq: f,
        mag: mag,
        phase: phases[idx] ?? 0,
        amp: amp,
      });
    }
    return info;
  }, [spectrum, harmonicsCount, harmonicFreqs]);

  const equation = useMemo(() => {
    if (harmonicInfo.length === 0) return "";
    const terms = harmonicInfo.map(info => {
      const amp = info.amp.toFixed(4);
      const freq = info.freq.toFixed(4);
      const phase = info.phase.toFixed(4);
      const sign = info.phase >= 0 ? "+" : "-";
      return `${amp} \\cos(2 \\pi \\cdot ${freq} t ${sign} ${Math.abs(info.phase).toFixed(4)})`;
    });
    return `y(t) = ${terms.join(" + ")}`;
  }, [harmonicInfo]);

  const fftData = useMemo<Data[]>(() => {
    if (!spectrum) return [];
    const base: Data = {
      x: spectrum.freqs,
      y: spectrum.mags, // Plot raw magnitudes, no normalization
      type: "scatter",
      mode: "lines",
      line: { color: "#60a5fa" },
      hovertemplate: "%{x:.2f} Hz, %{y:.4f}<extra></extra>",
    };
    const maxY = Math.max(...(base.y as number[]), 1e-6);
    const extras = buildVerticalLineTraces(spectrum, harmonicFreqs.slice(0, harmonicsCount), maxY);
    return [base, ...extras];
  }, [spectrum, harmonicFreqs, harmonicsCount]);

  const reconstructed = useMemo<Data | null>(() => {
    if (!spectrum || !rows || !sampleHz) return null;
    const time = relTimesSec;
    if (!time.length) return null;
    const nyq = (sampleHz ?? 1) / 2;
    const chosenFreqs = harmonicFreqs.slice(0, Math.min(harmonicsCount, harmonicFreqs.length)).filter((f) => f >= fminHz && f <= nyq);
    if (chosenFreqs.length === 0) return null;
    
    // Get the actual FFT data that was computed
    const phases = (spectrum as ComplexSpectrum).phases ?? [];
    const Nfft = (spectrum as ComplexSpectrum).fftSize ?? spectrum.freqs.length * 2;
    
    // Reconstruct from FFT directly
    const yRecon = new Array<number>(time.length).fill(0);
    
    for (const f of chosenFreqs) {
      // Find nearest FFT bin index
      let idx = 0;
      let best = Infinity;
      for (let i = 0; i < spectrum.freqs.length; i++) {
        const d = Math.abs(spectrum.freqs[i] - f);
        if (d < best) { best = d; idx = i; }
      }
      
      // Get magnitude from FFT (already scaled by 1/N in the FFT display)
      const mag = spectrum.mags[idx];
      
      // For a real signal, the amplitude of a sinusoidal component is:
      // - 2 * |FFT[k]| / N for k > 0 (positive frequencies)
      // - |FFT[0]| / N for DC component
      // But since we applied Hann window, we need to compensate for coherent gain
      const coherentGain = 1.0; // Rectangular window (no window) coherent gain
      const amp = idx === 0 ? mag / Nfft / coherentGain : 2 * mag / Nfft / coherentGain;
      
      // Get phase from FFT
      const phi = phases[idx] ?? 0;
      
      // Reconstruct the sinusoidal component
      const w = 2 * Math.PI * f;
      for (let i = 0; i < time.length; i++) {
        yRecon[i] += amp * Math.cos(w * time[i] + phi);
      }
    }
    
    // Add back the mean that was removed during detrending
    const meanOrig = series.reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0) / series.length;
    for (let i = 0; i < yRecon.length; i++) yRecon[i] += meanOrig;
    
    return {
      x: rows.map((r) => r.time),
      y: yRecon,
      type: "scatter",
      mode: "lines",
      line: { color: "#f59e0b" },
      hovertemplate: "%{x:.3f} s, %{y:.4f}<extra></extra>",
      name: "reconstructed",
    } as Data;
  }, [spectrum, rows, sampleHz, relTimesSec, harmonicFreqs, harmonicsCount, fminHz, series]);

  return (
    <div className="min-h-screen p-6 md:p-10">
      <div className="mx-auto max-w-6xl w-full space-y-6">
        <div className="flex items-baseline">
          <h1 className="text-4xl font-bold tracking-tight">FFTBot</h1>
          <p className="ml-4 text-lg text-muted-foreground">by Mark</p>
        </div>
        <Card>
          {/* <CardHeader>
            <CardTitle>Time Series and FFT</CardTitle>
          </CardHeader> */}
          <CardContent>
            <div className="grid gap-4 md:grid-cols-[1fr_auto_auto] md:items-end">
              <div className="space-y-2">
                <Label htmlFor="file">Upload .txt (tab-delimited)</Label>
                <Input
                  id="file"
                  type="file"
                  accept=".txt,.tsv,text/plain"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) {
                      isDefaultFileRef.current = false;
                      handleFile(f);
                    }
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label id="column-select-label">Select column</Label>
                <Select value={selectedKey} onValueChange={(v) => setSelectedKey(v as ColumnKey)}>
                  <SelectTrigger className="w-[220px]" aria-labelledby="column-select-label" aria-label="Select column">
                    <SelectValue placeholder="Column" />
                  </SelectTrigger>
                  <SelectContent>
                    {COLUMN_KEYS.map((key) => (
                      <SelectItem key={key} value={key}>
                        {key}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => setHarmonicsCount((c) => c + 1)}
                  disabled={!spectrum}
                  title="Add one harmonic line"
                  aria-label="Add harmonic"
                >
                  Add Harmonic
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => setHarmonicsCount((c) => Math.max(0, c - 1))}
                  disabled={!spectrum || harmonicsCount <= 0}
                  title="Remove one harmonic line"
                  aria-label="Remove harmonic"
                >
                  Remove Harmonic
                </Button>
              </div>
            </div>
            {error && (
              <div className="mt-4">
                <Alert>
                  <AlertTitle>Parse error</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
        </div>
            )}
          </CardContent>
        </Card>

        {rows && (
          <Tabs defaultValue="time" className="w-full">
            <TabsList>
              <TabsTrigger value="time">Time Series</TabsTrigger>
              <TabsTrigger value="fft" disabled={!spectrum}>FFT</TabsTrigger>
            </TabsList>
            <TabsContent value="time" className="mt-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <CardTitle>
                    Time Series — {selectedKey} ({rows.length} samples{sampleHz ? `, ~${sampleHz.toFixed(2)} Hz` : ""})
                  </CardTitle>
                  {reconstructed && (
                    <div className="flex items-center gap-5 text-sm text-muted-foreground">
                      <button
                        type="button"
                        className={`flex items-center gap-2 cursor-pointer ${showOriginal ? "opacity-100" : "opacity-40"}`}
                        onClick={() => setShowOriginal((v) => !v)}
                        aria-pressed={showOriginal}
                        title={showOriginal ? "Hide original" : "Show original"}
                        aria-label={showOriginal ? "Hide original series" : "Show original series"}
                      >
                        <span className="inline-block h-2 w-4 rounded-sm" style={{ backgroundColor: "#a1a1aa" }} aria-hidden="true" />
                        <span>original</span>
                      </button>
                      <button
                        type="button"
                        className={`flex items-center gap-2 cursor-pointer ${showReconstructed ? "opacity-100" : "opacity-40"}`}
                        onClick={() => setShowReconstructed((v) => !v)}
                        aria-pressed={showReconstructed}
                        title={showReconstructed ? "Hide reconstructed" : "Show reconstructed"}
                        aria-label={showReconstructed ? "Hide reconstructed series" : "Show reconstructed series"}
                      >
                        <span className="inline-block h-2 w-4 rounded-sm" style={{ backgroundColor: "#f59e0b" }} aria-hidden="true" />
                        <span>reconstructed</span>
                      </button>
                    </div>
                  )}
                </CardHeader>
                <CardContent>
                  <Plot
                    data={(() => {
                      const base: Data = {
                        x: relTimesSec,
                        y: series,
                        type: "scatter",
                        mode: "lines",
                        line: { color: "#a1a1aa" },
                        hovertemplate: "%{x:.3f} s, %{y:.4f}<extra></extra>",
                        name: "original",
                      };
                      const dataTraces: Data[] = [];
                      if (showOriginal) {
                        dataTraces.push(base);
                      }
                      if (reconstructed && showReconstructed) {
                        dataTraces.push({
                          ...(reconstructed as Data),
                          x: relTimesSec,
                          type: "scatter",
                        } as Data);
                      }
                      return dataTraces;
                    })()}
                    layout={{
                      paper_bgcolor: "transparent",
                      plot_bgcolor: "transparent",
                      autosize: true,
                      margin: { l: 48, r: 16, t: 16, b: 48 },
                      xaxis: {
                        title: { text: "Time (s)" },
                        type: "linear",
                        tickformat: ".3~f",
                        gridcolor: "rgba(255,255,255,0.08)",
                        color: "#e4e4e7",
                      },
                      yaxis: {
                        title: { text: selectedKey },
                        gridcolor: "rgba(255,255,255,0.08)",
                        color: "#e4e4e7",
                      },
                      showlegend: false
                    }}
                    useResizeHandler
                    style={{ width: "100%", height: 420 }}
                    config={{ displayModeBar: false, responsive: true, displaylogo: false }}
                    onRelayout={onPlotRelayout}
                  />
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="fft" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle>FFT Magnitude Spectrum{sampleHz ? ` (Fs=${sampleHz.toFixed(2)} Hz)` : ""}</CardTitle>
                </CardHeader>
                <CardContent>
                  {spectrum ? (
                    <>
                      <Plot
                        data={fftData}
                        layout={{
                          paper_bgcolor: "transparent",
                          plot_bgcolor: "transparent",
                          autosize: true,
                          margin: { l: 48, r: 16, t: 16, b: 64 },
                          xaxis: {
                            title: { text: "Frequency (Hz)" },
                            gridcolor: "rgba(255,255,255,0.08)",
                            color: "#e4e4e7",
                          },
                          yaxis: {
                            title: { text: "Magnitude" },
                            gridcolor: "rgba(255,255,255,0.08)",
                            color: "#e4e4e7",
                          },
                          shapes: fminHz > 0 ? ([{
                            type: "rect",
                            xref: "x",
                            yref: "paper",
                            x0: 0,
                            x1: fminHz,
                            y0: 0,
                            y1: 1,
                            fillcolor: "rgba(239,68,68,0.10)",
                            line: { width: 0 },
                          }] as Partial<Layout>["shapes"]) : undefined,
                          showlegend: false,
                        }}
                        useResizeHandler
                        style={{ width: "100%", height: 420 }}
                        config={{ displayModeBar: false, responsive: true }}
                      />
                      <div className="mt-3 pl-[48px] pr-[16px]">
                        <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                          <span>Ignore 1/f noise <span className="font-medium">&lt; {fminHz.toFixed(2)} Hz</span></span>
                          <span>Nyquist {(Math.max(1, (sampleHz ?? 10) / 2)).toFixed(2)} Hz</span>
                        </div>
                        <Slider
                          className="w-full"
                          value={[fminHz]}
                          onValueChange={(v) => setFminHz(Array.isArray(v) ? Number(v[0]) : Number(v))}
                          min={0}
                          max={Math.max(1, (sampleHz ?? 10) / 2)}
                          step={0.01}
                          aria-label="1/f cutoff (Hz)"
                        />
                        <div className="mt-1 text-xs text-muted-foreground">Harmonics shown: {Math.min(harmonicsCount, harmonicFreqs.length)}</div>
                      </div>
                    </>
                  ) : (
                    <div className="text-sm text-muted-foreground">Need at least 4 samples and a valid sampling rate.</div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        )}
        {harmonicInfo.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Harmonic Information</CardTitle>
            </CardHeader>
            <CardContent>
              {equation && (
                <div className="overflow-x-auto whitespace-nowrap">
                  <BlockMath math={equation} />
                </div>
              )}
              <div className="mt-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[180px]">Frequency (Hz)</TableHead>
                      <TableHead>Magnitude</TableHead>
                      <TableHead>Phase (rad)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {harmonicInfo.map((info) => (
                      <TableRow key={info.freq}>
                        <TableCell className="font-medium">{info.freq.toFixed(4)}</TableCell>
                        <TableCell>{info.mag.toFixed(4)}</TableCell>
                        <TableCell>{info.phase.toFixed(4)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
