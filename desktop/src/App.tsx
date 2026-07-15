import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MOCK } from "./mock";
import "./App.css";

// ---- minimal shapes of the stasis --json output (only fields the UI reads) ----
type Factors = Record<string, number>;
interface Scored {
  name: string;
  score: number;
  factors: Factors;
  daysSinceCommit: number | null;
  costUsd: number;
  paperclip: { percentDone: number; done: number; total: number } | null;
}
interface Block {
  project: string;
  kind: "anchor" | "hop" | "return";
  task: string;
  stop: string;
  why: string;
  estTokens: number;
  estMinutes: number;
}
interface Route {
  mode: string;
  anchor: string | null;
  budgetTokens: number | null;
  usedTokens: number;
  totalMinutes: number;
  blocks: Block[];
  deferred: { project: string; roi: number; reason: string }[];
  note: string;
}
interface SwitchOpt { name: string; roi: number; score: number; reason: string }
interface Sprint { gate: string; route: Route; why: string[]; switchOptions: SwitchOpt[] }
interface FocusStatus {
  focus: { project: string; bet: string; kill: string; horizonDays: number };
  daysElapsed: number;
  daysLeft: number;
  overdue: boolean;
  fidelity: number | null;
  traceable: boolean;
  leaks: { name: string; tokens: number }[];
}
interface Quota {
  subscription: string;
  calibrated: boolean;
  rolling5h: { tokens: number; cap: number | null; pct: number | null };
  weekly: { tokens: number; cap: number | null; pct: number | null };
  resetInDays: number;
  gate: "green" | "yellow" | "red";
}

const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(command: string): Promise<T> {
  if (!IS_TAURI) {
    await new Promise((r) => setTimeout(r, 60)); // mimic latency
    return MOCK[command] as T;
  }
  const raw = await invoke<string>("run_stasis", { command });
  return JSON.parse(raw) as T;
}

const fmtK = (n: number) =>
  n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);
const KIND: Record<Block["kind"], { mark: string; label: string }> = {
  anchor: { mark: "◆", label: "anchor" },
  hop: { mark: "→", label: "hop" },
  return: { mark: "↩", label: "return" },
};
const REFRESH_MS = 5000;

export default function App() {
  const [sprint, setSprint] = useState<Sprint | null>(null);
  const [focus, setFocus] = useState<FocusStatus | null>(null);
  const [quota, setQuota] = useState<Quota[]>([]);
  const [scores, setScores] = useState<Scored[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [tick, setTick] = useState(0);
  const [live, setLive] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [sp, fo, qu, sc] = await Promise.all([
        call<Sprint>("sprint"),
        call<{ active: FocusStatus | null }>("focus"),
        call<Quota[]>("quota"),
        call<Scored[]>("score"),
      ]);
      setSprint(sp); setFocus(fo.active); setQuota(qu); setScores(sc);
      setError(null); setUpdatedAt(new Date()); setTick((t) => t + 1);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    if (!live) return;
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh, live]);

  const loading = !updatedAt && !error;

  return (
    <main className="app">
      <header className="bar">
        <div className="brand">
          <span className="glyph">◱</span> stasis
          <span className="tag">{IS_TAURI ? "live" : "preview"}</span>
        </div>
        <div className="bar-quota">
          {quota.map((q) => (
            <div className="qchip" key={q.subscription} title={q.subscription}>
              <span className={`gate ${q.gate}`} />
              {q.calibrated ? (
                <>
                  <Meter label="5h" pct={q.rolling5h.pct} />
                  <Meter label="wk" pct={q.weekly.pct} />
                  <span className="reset">↻{q.resetInDays}d</span>
                </>
              ) : (
                <span className="muted">uncalibrated</span>
              )}
            </div>
          ))}
        </div>
        <div className="bar-ctl">
          <button className={`live ${live ? "on" : ""}`} onClick={() => setLive((v) => !v)}>
            <span key={tick} className="pulse" /> {live ? "Live" : "Paused"}
          </button>
          <button className="ghost" onClick={refresh}>↻</button>
          <span className="stamp">{updatedAt ? updatedAt.toLocaleTimeString() : "—"}</span>
        </div>
      </header>

      {error && <div className="error"><b>error</b> {error}</div>}

      {/* FOCUS BAND */}
      <section className={`focus ${focus?.overdue ? "overdue" : ""}`}>
        {loading ? (
          <Skeleton lines={2} />
        ) : focus ? (
          <>
            <div className="focus-main">
              <div className="focus-eyebrow">committed focus</div>
              <div className="focus-name">{focus.focus.project}</div>
              <div className="focus-bet">{focus.focus.bet}</div>
            </div>
            <div className="focus-side">
              <div className="focus-day">
                <span className="big">{focus.daysElapsed}</span>
                <span className="muted">/{focus.focus.horizonDays}d</span>
                {focus.overdue
                  ? <span className="badge crit">overdue</span>
                  : <span className="badge">{focus.daysLeft}d left</span>}
              </div>
              <Fidelity f={focus} />
            </div>
          </>
        ) : (
          <div className="empty">No active commitment — <span className="muted">decide your bet in the CLI.</span></div>
        )}
      </section>

      <div className="cols">
        {/* ROUTE */}
        <section className="panel route">
          <div className="phead">
            <h2>Today's route</h2>
            {sprint && <span className={`mode ${sprint.gate}`}>{sprint.route.mode}</span>}
          </div>
          {loading ? <Skeleton lines={4} /> : sprint ? (
            <>
              <BudgetBar r={sprint.route} />
              <ol className="timeline">
                {sprint.route.blocks.map((b, i) => (
                  <li key={i} className={`step ${b.kind}`} style={{ animationDelay: `${i * 45}ms` }}>
                    <span className="node">{KIND[b.kind].mark}</span>
                    <div className="step-body">
                      <div className="step-top">
                        <span className="proj">{b.project}</span>
                        <span className="kindtag">{KIND[b.kind].label}</span>
                        <span className="est">~{fmtK(b.estTokens)} · {b.estMinutes}m</span>
                      </div>
                      <div className="task">{b.task}</div>
                      <div className="stop"><span className="arrow">stop</span> {b.stop}</div>
                    </div>
                  </li>
                ))}
              </ol>
              {sprint.route.deferred.length > 0 && (
                <div className="deferred">
                  <div className="dline"><span>below the line</span></div>
                  {sprint.route.deferred.map((d) => (
                    <div key={d.project} className="drow">
                      <span className="proj">{d.project}</span>
                      <span className="roi">roi {d.roi.toFixed(1)}</span>
                      <span className="muted">{d.reason}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : null}
        </section>

        {/* SWITCH */}
        <section className="panel switch">
          <div className="phead"><h2>Switch by ROI</h2></div>
          {loading ? <Skeleton lines={4} /> : (
            <ul className="switches">
              {sprint?.switchOptions.map((o, i) => (
                <li key={o.name} style={{ animationDelay: `${i * 45}ms` }}>
                  <span className="proj">{o.name}</span>
                  <RoiPip roi={o.roi} />
                  <span className="reason muted">{o.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* SCORES */}
      <section className="panel scores">
        <div className="phead">
          <h2>Scores</h2>
          <span className="count">{scores.length}</span>
        </div>
        {loading ? <Skeleton lines={5} /> : (
          <table>
            <thead>
              <tr>
                <th className="r">#</th><th className="l">project</th>
                <th>score</th><th>roi</th><th>prox</th><th>mom</th><th>done</th><th>cost</th>
              </tr>
            </thead>
            <tbody>
              {scores.slice(0, 12).map((p, i) => (
                <tr key={p.name}>
                  <td className="r idx">{i + 1}</td>
                  <td className="l proj">{p.name}</td>
                  <td className="score">{p.score.toFixed(1)}</td>
                  <td>{(p.factors.roi * 10).toFixed(1)}</td>
                  <td>{(p.factors.proximity * 10).toFixed(1)}</td>
                  <td>{(p.factors.momentum * 10).toFixed(1)}</td>
                  <td>{p.paperclip ? <span className="pc">{p.paperclip.done}/{p.paperclip.total}</span> : <span className="dash">·</span>}</td>
                  <td className="muted">{p.costUsd ? "$" + Math.round(p.costUsd) : <span className="dash">·</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

function Meter({ label, pct }: { label: string; pct: number | null }) {
  const p = pct == null ? 0 : Math.round(pct * 100);
  const tone = p >= 90 ? "crit" : p >= 60 ? "warn" : "ok";
  return (
    <span className="meter" title={`${label} ${p}%`}>
      <span className="meter-label">{label}</span>
      <span className="meter-track"><span className={`meter-fill ${tone}`} style={{ width: `${p}%` }} /></span>
      <span className="meter-pct">{pct == null ? "—" : p}</span>
    </span>
  );
}

function BudgetBar({ r }: { r: Route }) {
  const cap = r.budgetTokens;
  const pct = cap ? Math.min(100, Math.round((r.usedTokens / cap) * 100)) : 0;
  return (
    <div className="budget">
      <div className="budget-row">
        <span className="anchor-chip"><span className="dot" /> {r.anchor ?? "—"}</span>
        <span className="muted budget-meta">
          {fmtK(r.usedTokens)}{cap != null && ` / ${fmtK(cap)}`} tok · ~{r.totalMinutes}m
        </span>
      </div>
      {cap != null && (
        <span className="budget-track"><span className="budget-fill" style={{ width: `${pct}%` }} /></span>
      )}
    </div>
  );
}

function Fidelity({ f }: { f: FocusStatus }) {
  if (!f.traceable)
    return <div className="fid"><span className="fid-label muted">not token-traced</span><span className="muted small">non-code bet · judged at verdict</span></div>;
  if (f.fidelity == null)
    return <div className="fid"><span className="fid-label muted">no activity yet</span></div>;
  const p = Math.round(f.fidelity * 100);
  const tone = f.fidelity >= 0.6 ? "ok" : "crit";
  return (
    <div className="fid">
      <div className="fid-top">
        <span className={`fid-val ${tone}`}>{p}%</span>
        <span className="muted small">on target{f.fidelity < 0.6 ? " · scattering" : ""}</span>
      </div>
      <span className="fid-track"><span className={`fid-fill ${tone}`} style={{ width: `${p}%` }} /></span>
      {f.leaks.length > 0 && (
        <div className="leaks muted small">↳ {f.leaks.map((l) => `${l.name} ${fmtK(l.tokens)}`).join(" · ")}</div>
      )}
    </div>
  );
}

function RoiPip({ roi }: { roi: number }) {
  const tone = roi >= 7 ? "hi" : roi >= 3 ? "mid" : "lo";
  return <span className={`roipip ${tone}`}>roi <b>{roi.toFixed(1)}</b></span>;
}

function Skeleton({ lines }: { lines: number }) {
  return (
    <div className="skel">
      {Array.from({ length: lines }).map((_, i) => (
        <span key={i} className="skel-line" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}
