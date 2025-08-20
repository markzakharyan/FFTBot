"use client";

import { useMemo, useState } from "react";
import Papa from "papaparse";
import dynamic from "next/dynamic";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import type { Layout, Config, Data } from "plotly.js";
const Plot = dynamic(async () => {
  const Plotly = (await import("plotly.js-dist-min")).default;
  const createPlotComponent = (await import("react-plotly.js/factory")).default as (
    plotly: unknown
  ) => React.ComponentType<{
    data: Data[];
    layout?: Partial<Layout> & { paper_bgcolor?: string; plot_bgcolor?: string };
    config?: Partial<Config> & { responsive?: boolean };
    style?: React.CSSProperties;
    useResizeHandler?: boolean;
  }>;
  return createPlotComponent(Plotly);
}, { ssr: false, loading: () => <div className="text-sm text-muted-foreground">Loading charts…</div> });

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
  return new Promise((resolve, reject) => {
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
          resolve(data);
        } catch (e) {
          reject(e);
        }
      },
      error: (err) => reject(err),
    });
  });
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

function computeFft(acc: number[], sampleHz: number) {
  // Zero-pad to next power of two for cleaner FFT
  const N = acc.length;
  const pow2 = 1 << Math.ceil(Math.log2(Math.max(2, N)));
  const padded = new Float64Array(pow2);
  for (let i = 0; i < N; i++) padded[i] = acc[i];

  // Use an inlined Cooley–Tukey radix-2 FFT (to avoid SSR/ESM issues from small libs)
  const re = padded.slice();
  const im = new Float64Array(pow2);

  // bit-reversal
  let j = 0;
  for (let i = 0; i < pow2; i++) {
    if (i < j) {
      const tr = re[i];
      const ti = im[i];
      re[i] = re[j];
      im[i] = im[j];
      re[j] = tr;
      im[j] = ti;
    }
    let m = pow2 >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }

  for (let step = 1; step < pow2; step <<= 1) {
    const jump = step << 1;
    const delta = -Math.PI / step;
    const sine = Math.sin(delta);
    const wpr = -2.0 * sine * sine;
    const wpi = Math.sin(2.0 * delta);
    for (let group = 0; group < step; group++) {
      let wr = 1.0;
      let wi = 0.0;
      for (let pair = group; pair < pow2; pair += jump) {
        const match = pair + step;
        const tr = wr * re[match] - wi * im[match];
        const ti = wr * im[match] + wi * re[match];
        re[match] = re[pair] - tr;
        im[match] = im[pair] - ti;
        re[pair] += tr;
        im[pair] += ti;
      }
      const tmp = wr;
      wr = tmp * wpr - wi * wpi + wr;
      wi = wi * wpr + tmp * wpi + wi;
    }
  }

  // Single-sided spectrum (magnitude)
  const freqs: number[] = [];
  const mags: number[] = [];
  const half = pow2 / 2;
  for (let k = 0; k <= half; k++) {
    const mag = Math.hypot(re[k], im[k]) / pow2;
    const f = (k * sampleHz) / pow2;
    freqs.push(f);
    mags.push(mag * 2); // scale single-sided
  }
  return { freqs, mags };
}

export default function Home() {
  const [rows, setRows] = useState<ParsedRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<ColumnKey>("AccX(g)");

  const sampleHz = useMemo(() => (rows ? estimateSamplingHz(rows) : null), [rows]);
  const relTimesSec = useMemo(() => {
    if (!rows?.length) return [] as number[];
    const t0 = rows[0].time;
    return rows.map((r) => (r.time - t0) / 1000);
  }, [rows]);
  const series = useMemo(() => rows?.map((r) => r[selectedKey] ?? NaN) ?? [], [rows, selectedKey]);

  const spectrum = useMemo(() => {
    if (!rows || !sampleHz || !Number.isFinite(sampleHz)) return null;
    const clean = series.filter((v) => Number.isFinite(v));
    if (clean.length < 4) return null;
    return computeFft(clean as number[], sampleHz);
  }, [rows, series, sampleHz]);

  const handleFile = async (file: File) => {
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
  };

  return (
    <div className="min-h-screen p-6 md:p-10">
      <div className="mx-auto max-w-6xl w-full space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Time Series and FFT</CardTitle>
          </CardHeader>
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
                    if (f) handleFile(f);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label>Select column</Label>
                <Select value={selectedKey} onValueChange={(v) => setSelectedKey(v as ColumnKey)}>
                  <SelectTrigger className="w-[220px]">
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
              <div>
                <Button
                  variant="secondary"
                  onClick={async () => {
                    try {
                      const res = await fetch("/20250313235359.txt");
                      if (!res.ok) throw new Error("Example file not found in public/");
                      const blob = await res.blob();
                      await handleFile(new File([blob], "example.txt", { type: "text/plain" }));
                    } catch (e: unknown) {
                      const msg = e instanceof Error ? e.message : String(e);
                      setError(msg || "Failed to load example file");
                    }
                  }}
                >
                  Load example (if placed in public)
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
                <CardHeader>
                  <CardTitle>
                    Time Series — {selectedKey} ({rows.length} samples{sampleHz ? `, ~${sampleHz.toFixed(2)} Hz` : ""})
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Plot
                    data={[
                      {
                        x: relTimesSec,
                        y: series,
                        type: "scatter",
                        mode: "lines",
                        line: { color: "#a1a1aa" },
                        hovertemplate: "%{x:.3f} s, %{y:.4f}<extra></extra>",
                      },
                    ]}
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
                      showlegend: false,
                    }}
                    useResizeHandler
                    style={{ width: "100%", height: 420 }}
                    config={{ displayModeBar: false, responsive: true }}
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
                    <Plot
                      data={[
                        {
                          x: spectrum.freqs,
                          y: spectrum.mags,
                          type: "scatter",
                          mode: "lines",
                          line: { color: "#60a5fa" },
                          hovertemplate: "%{x:.2f} Hz, %{y:.4f}<extra></extra>",
                        },
                      ]}
                      layout={{
                        paper_bgcolor: "transparent",
                        plot_bgcolor: "transparent",
                        autosize: true,
                        margin: { l: 48, r: 16, t: 16, b: 48 },
                        xaxis: {
                          title: { text: "Frequency (Hz)" },
                          gridcolor: "rgba(255,255,255,0.08)",
                          color: "#e4e4e7",
                        },
                        yaxis: {
                          title: { text: "Amplitude (g)" },
                          gridcolor: "rgba(255,255,255,0.08)",
                          color: "#e4e4e7",
                        },
                        showlegend: false,
                      }}
                      useResizeHandler
                      style={{ width: "100%", height: 420 }}
                      config={{ displayModeBar: false, responsive: true }}
                    />
                  ) : (
                    <div className="text-sm text-muted-foreground">Need at least 4 samples and a valid sampling rate.</div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  );
}
