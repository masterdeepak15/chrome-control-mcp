// Lightweight trace analysis (not the full DevTools trace engine).
export interface Analysis {
  summary: string;
  insights: Record<string, string>;
}

const ms = (us: number) => `${(us / 1000).toFixed(1)} ms`;

export function analyzeTrace(events: any[]): Analysis {
  const nav = events
    .filter((e) => e.name === "navigationStart" && e.args?.data?.isLoadingMainFrame !== false)
    .sort((a, b) => b.ts - a.ts)[0];
  const t0 = nav?.ts ?? Math.min(...events.filter((e) => e.ts).map((e) => e.ts));
  const after = (e: any) => e.ts >= t0;

  const fcpEv = events.filter((e) => e.name === "firstContentfulPaint" && after(e)).sort((a, b) => a.ts - b.ts)[0];
  const lcpEv = events.filter((e) => e.name === "largestContentfulPaint::Candidate" && after(e)).sort((a, b) => b.ts - a.ts)[0];
  const loadEv = events.filter((e) => e.name === "MarkLoad" && after(e)).sort((a, b) => a.ts - b.ts)[0];
  const dclEv = events.filter((e) => e.name === "MarkDOMContent" && after(e)).sort((a, b) => a.ts - b.ts)[0];
  const respEv = events
    .filter((e) => e.name === "ResourceReceiveResponse" && after(e) && /html/.test(e.args?.data?.mimeType ?? ""))
    .sort((a, b) => a.ts - b.ts)[0];

  // CLS: biggest session window (gap < 1s, window <= 5s)
  const shifts = events
    .filter((e) => e.name === "LayoutShift" && e.args?.data?.is_main_frame && !e.args.data.had_recent_input && after(e))
    .sort((a, b) => a.ts - b.ts);
  let cls = 0, win = 0, winStart = 0, last = 0;
  for (const s of shifts) {
    if (!win || s.ts - last > 1_000_000 || s.ts - winStart > 5_000_000) {
      win = 0;
      winStart = s.ts;
    }
    win += s.args.data.score;
    last = s.ts;
    cls = Math.max(cls, win);
  }

  // Long tasks and Total Blocking Time
  const tasks = events
    .filter((e) => e.name === "RunTask" && e.ph === "X" && e.dur > 50_000 && after(e))
    .sort((a, b) => b.dur - a.dur);
  const fcpTs = fcpEv?.ts ?? t0;
  const tbt = tasks.filter((t) => t.ts >= fcpTs).reduce((sum, t) => sum + (t.dur - 50_000), 0);

  const lines = [
    `- LCP: ${lcpEv ? ms(lcpEv.ts - t0) + (lcpEv.args?.data?.type ? ` (${lcpEv.args.data.type})` : "") : "not recorded"}`,
    `- FCP: ${fcpEv ? ms(fcpEv.ts - t0) : "not recorded"}`,
    `- CLS: ${shifts.length ? cls.toFixed(4) : "0 (no layout shifts)"}`,
    `- TTFB: ${respEv ? ms(respEv.ts - t0) : "not recorded"}`,
    `- Total Blocking Time (approx): ${ms(tbt)}`,
    `- DOMContentLoaded: ${dclEv ? ms(dclEv.ts - t0) : "not recorded"}`,
    `- Load event: ${loadEv ? ms(loadEv.ts - t0) : "not recorded"}`,
    `- Long tasks (>50ms): ${tasks.length}`,
  ];

  const insights: Record<string, string> = {
    LCPBreakdown: lcpEv
      ? [
          `LCP total: ${ms(lcpEv.ts - t0)}`,
          `Time to first byte: ${respEv ? ms(respEv.ts - t0) : "n/a"}`,
          `First byte to FCP: ${respEv && fcpEv ? ms(fcpEv.ts - respEv.ts) : "n/a"}`,
          `FCP to LCP: ${fcpEv ? ms(lcpEv.ts - fcpEv.ts) : "n/a"}`,
          `LCP element type: ${lcpEv.args?.data?.type ?? "unknown"}, size: ${lcpEv.args?.data?.size ?? "unknown"}`,
          "Note: approximate breakdown from trace events.",
        ].join("\n")
      : "No LCP candidate in this trace.",
    LongTasks: tasks.length
      ? tasks
          .slice(0, 15)
          .map((t, i) => `${i + 1}. ${ms(t.dur)} at +${ms(t.ts - t0)}`)
          .join("\n")
      : "No tasks longer than 50 ms.",
    LayoutShifts: shifts.length
      ? shifts
          .slice(0, 20)
          .map((s, i) => `${i + 1}. score ${s.args.data.score.toFixed(4)} at +${ms(s.ts - t0)}`)
          .join("\n") + `\nCLS (worst session window): ${cls.toFixed(4)}`
      : "No layout shifts without recent input.",
  };
  return { summary: lines.join("\n"), insights };
}
