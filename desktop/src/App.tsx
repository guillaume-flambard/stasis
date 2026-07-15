import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
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
interface Sprint {
  gate: string;
  route: Route;
  why: string[];
  switchOptions: SwitchOpt[];
}
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

async function call<T>(command: string): Promise<T> {
  const raw = await invoke<string>("run_stasis", { command });
  return JSON.parse(raw) as T;
}

const fmtK = (n: number) =>
  n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);
const kindMark: Record<Block["kind"], string> = { anchor: "▶", hop: "→", return: "↩" };
const REFRESH_MS = 5000;

export default function App() {
  const [sprint, setSprint] = useState<Sprint | null>(null);
  const [focus, setFocus] = useState<FocusStatus | null>(null);
  const [quota, setQuota] = useState<Quota[]>([]);
  const [scores, setScores] = useState<Scored[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [live, setLive] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [sp, fo, qu, sc] = await Promise.all([
        call<Sprint>("sprint"),
        call<{ active: FocusStatus | null }>("focus"),
        call<Quota[]>("quota"),
        call<Scored[]>("score"),
      ]);
      setSprint(sp);
      setFocus(fo.active);
      setQuota(qu);
      setScores(sc);
      setError(null);
      setUpdatedAt(new Date());
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

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">🧭 stasis <span className="sub">live</span></div>
        <div className="controls">
          <span className={`dot ${live ? "on" : "off"}`} />
          <button onClick={() => setLive((v) => !v)}>{live ? "Live" : "Paused"}</button>
          <button onClick={refresh}>Refresh</button>
          <span className="ts">{updatedAt ? updatedAt.toLocaleTimeString() : "—"}</span>
        </div>
      </header>

      {error && <div className="error">⚠ {error}</div>}

      <div className="grid">
        {/* FOCUS */}
        <section className="card focus">
          <h2>Focus</h2>
          {focus ? (
            <>
              <div className="focus-name">🎯 {focus.focus.project}
                <span className="muted"> · day {focus.daysElapsed}/{focus.focus.horizonDays}
                  {focus.overdue ? <b className="red"> · OVERDUE</b> : ` · ${focus.daysLeft}d left`}</span>
              </div>
              <div className="bet">{focus.focus.bet}</div>
              <div className="fidelity">
                {!focus.traceable
                  ? <span className="muted">not token-traced (non-code bet)</span>
                  : focus.fidelity == null
                    ? <span className="muted">no activity yet</span>
                    : <span className={focus.fidelity >= 0.6 ? "green" : "red"}>
                        {Math.round(focus.fidelity * 100)}% on target
                        {focus.fidelity < 0.6 ? " ⚠ scattering" : ""}
                      </span>}
              </div>
            </>
          ) : (
            <div className="muted">No active commitment. Decide your bet.</div>
          )}
        </section>

        {/* QUOTA */}
        <section className="card quota">
          <h2>Quota</h2>
          {quota.length === 0 && <div className="muted">no subscriptions</div>}
          {quota.map((q) => (
            <div key={q.subscription} className="qrow">
              <span className={`gate ${q.gate}`} />
              <span className="qname">{q.subscription}</span>
              {q.calibrated ? (
                <span className="qbars">
                  <Bar label="5h" pct={q.rolling5h.pct} />
                  <Bar label="wk" pct={q.weekly.pct} />
                  <span className="muted">reset {q.resetInDays}d</span>
                </span>
              ) : (
                <span className="muted">uncalibrated · {fmtK(q.weekly.tokens)} tok/wk</span>
              )}
            </div>
          ))}
        </section>

        {/* ROUTE */}
        <section className="card route">
          <h2>Today's route {sprint && <span className="mode">{sprint.route.mode}</span>}</h2>
          {sprint ? (
            <>
              <div className="muted budget">
                budget {fmtK(sprint.route.usedTokens)}
                {sprint.route.budgetTokens != null && `/${fmtK(sprint.route.budgetTokens)}`} tok
                · ~{sprint.route.totalMinutes}m · anchor {sprint.route.anchor ?? "—"}
              </div>
              <ol className="blocks">
                {sprint.route.blocks.map((b, i) => (
                  <li key={i} className={`block ${b.kind}`}>
                    <div className="bhead"><span className="mark">{kindMark[b.kind]}</span>
                      <b>{b.project}</b> <span className="task">{b.task}</span></div>
                    <div className="bmeta muted">
                      ~{fmtK(b.estTokens)} · {b.estMinutes}m · stop: {b.stop}
                    </div>
                  </li>
                ))}
              </ol>
              {sprint.route.deferred.length > 0 && (
                <div className="deferred">
                  <div className="muted line">── budget line ──</div>
                  {sprint.route.deferred.map((d) => (
                    <div key={d.project} className="drow muted">
                      {d.project} · ROI {d.roi.toFixed(1)} · {d.reason}
                    </div>
                  ))}
                </div>
              )}
              <div className="muted note">{sprint.route.note}</div>
            </>
          ) : (
            <div className="muted">loading…</div>
          )}
        </section>

        {/* SWITCH OPTIONS */}
        <section className="card switch">
          <h2>Switch by ROI</h2>
          {sprint?.switchOptions.length ? (
            <ul className="switches">
              {sprint.switchOptions.map((o) => (
                <li key={o.name}>
                  <b>{o.name}</b>
                  <span className="roi">ROI {o.roi.toFixed(1)}</span>
                  <span className="muted">{o.reason}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="muted">—</div>
          )}
        </section>

        {/* SCORES */}
        <section className="card scores">
          <h2>Scores <span className="muted">({scores.length})</span></h2>
          <table>
            <thead>
              <tr><th>#</th><th>project</th><th>score</th><th>roi</th><th>prox</th><th>mom</th><th>done</th><th>cost</th></tr>
            </thead>
            <tbody>
              {scores.slice(0, 15).map((p, i) => (
                <tr key={p.name}>
                  <td className="muted">{i + 1}</td>
                  <td className="pname">{p.name}</td>
                  <td><Score v={p.score} /></td>
                  <td>{(p.factors.roi * 10).toFixed(1)}</td>
                  <td>{(p.factors.proximity * 10).toFixed(1)}</td>
                  <td>{(p.factors.momentum * 10).toFixed(1)}</td>
                  <td>{p.paperclip ? `${p.paperclip.done}/${p.paperclip.total}` : "—"}</td>
                  <td className="muted">{p.costUsd ? "$" + p.costUsd.toFixed(0) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </main>
  );
}

function Bar({ label, pct }: { label: string; pct: number | null }) {
  const p = pct == null ? 0 : Math.round(pct * 100);
  const tone = p >= 90 ? "red" : p >= 60 ? "yellow" : "green";
  return (
    <span className="bar">
      <span className="barlabel">{label}</span>
      <span className="bartrack"><span className={`barfill ${tone}`} style={{ width: `${p}%` }} /></span>
      <span className="barpct">{pct == null ? "—" : p + "%"}</span>
    </span>
  );
}

function Score({ v }: { v: number }) {
  return <b className="scoreval">{v.toFixed(1)}</b>;
}
