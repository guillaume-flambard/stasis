import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MOCK } from "./mock";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Compass, RotateCw, ArrowRight, CornerDownLeft, Diamond, Info,
} from "lucide-react";

// ---- shapes of the stasis --json output (only fields the UI reads) ----
type Factors = Record<string, number>;
interface Scored {
  name: string; score: number; factors: Factors;
  daysSinceCommit: number | null; costUsd: number;
  paperclip: { percentDone: number; done: number; total: number } | null;
}
interface Block {
  project: string; kind: "anchor" | "hop" | "return";
  task: string; stop: string; why: string; estTokens: number; estMinutes: number;
}
interface Route {
  mode: string; anchor: string | null; budgetTokens: number | null; usedTokens: number;
  totalMinutes: number; blocks: Block[]; deferred: { project: string; roi: number; reason: string }[]; note: string;
}
interface SwitchOpt { name: string; roi: number; score: number; reason: string }
interface Sprint { gate: string; route: Route; why: string[]; switchOptions: SwitchOpt[] }
interface FocusStatus {
  focus: { project: string; bet: string; kill: string; horizonDays: number };
  daysElapsed: number; daysLeft: number; overdue: boolean;
  fidelity: number | null; traceable: boolean; leaks: { name: string; tokens: number }[];
}
interface Quota {
  subscription: string; calibrated: boolean;
  rolling5h: { tokens: number; cap: number | null; pct: number | null };
  weekly: { tokens: number; cap: number | null; pct: number | null };
  resetInDays: number; gate: "green" | "yellow" | "red";
}

const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
async function call<T>(command: string): Promise<T> {
  if (!IS_TAURI) { await new Promise((r) => setTimeout(r, 60)); return MOCK[command] as T; }
  return JSON.parse(await invoke<string>("run_stasis", { command })) as T;
}

const fmtK = (n: number) =>
  n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);
type Tone = "ok" | "warn" | "crit" | "accent";
const indicator: Record<Tone, string> = {
  ok: "[&_[data-slot=progress-indicator]]:bg-ok",
  warn: "[&_[data-slot=progress-indicator]]:bg-warn",
  crit: "[&_[data-slot=progress-indicator]]:bg-crit",
  accent: "[&_[data-slot=progress-indicator]]:bg-primary",
};
const KIND: Record<Block["kind"], { icon: typeof Diamond; label: string }> = {
  anchor: { icon: Diamond, label: "anchor" },
  hop: { icon: ArrowRight, label: "hop" },
  return: { icon: CornerDownLeft, label: "return" },
};
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
        call<Sprint>("sprint"), call<{ active: FocusStatus | null }>("focus"),
        call<Quota[]>("quota"), call<Scored[]>("score"),
      ]);
      setSprint(sp); setFocus(fo.active); setQuota(qu); setScores(sc);
      setError(null); setUpdatedAt(new Date());
    } catch (e) { setError(String(e)); }
  }, []);

  useEffect(() => {
    refresh();
    if (!live) return;
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh, live]);

  const loading = !updatedAt && !error;

  return (
    <TooltipProvider>
      <div className="mx-auto max-w-[1140px] px-6 pb-16 pt-4 font-sans text-foreground">
        {/* top bar */}
        <header className="flex items-center gap-5 border-b pb-4">
          <div className="flex items-center gap-2 font-mono text-[15px] font-semibold tracking-tight">
            <Compass className="size-[18px] text-primary" />
            stasis
            <Badge variant="secondary" className="ml-1 text-primary">{IS_TAURI ? "live" : "preview"}</Badge>
          </div>
          <div className="ml-auto flex items-center gap-4">
            {quota.map((q) => (
              <div key={q.subscription} className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                <span className={cn("size-2 rounded-full", q.gate === "green" ? "bg-ok" : q.gate === "yellow" ? "bg-warn" : "bg-crit")} />
                {q.calibrated ? (
                  <>
                    <MiniMeter label="5h" pct={q.rolling5h.pct} />
                    <MiniMeter label="wk" pct={q.weekly.pct} />
                    <span className="opacity-70">↻{q.resetInDays}d</span>
                  </>
                ) : <span>uncalibrated</span>}
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button variant={live ? "secondary" : "ghost"} size="sm" onClick={() => setLive((v) => !v)} className="h-8 gap-2">
              <span className={cn("size-2 rounded-full", live ? "animate-pulse bg-ok" : "bg-muted-foreground")} />
              {live ? "Live" : "Paused"}
            </Button>
            <Button variant="ghost" size="icon" className="size-8" onClick={refresh}><RotateCw className="size-4" /></Button>
            <span className="w-[62px] text-right font-mono text-[11px] text-muted-foreground">
              {updatedAt ? updatedAt.toLocaleTimeString() : "—"}
            </span>
          </div>
        </header>

        {error && (
          <div className="mt-4 rounded-lg border border-crit/40 bg-crit/10 px-3 py-2 font-mono text-[12px] text-crit">
            <b className="mr-2">error</b>{error}
          </div>
        )}

        {/* FOCUS */}
        <Card className={cn("mt-4 gap-0 overflow-hidden py-0", focus?.overdue && "border-crit/50")}>
          <div className="relative flex items-end justify-between gap-7 p-5">
            <span className={cn("absolute inset-y-0 left-0 w-[3px]", focus?.overdue ? "bg-crit" : "bg-primary")} />
            {loading ? <div className="w-full space-y-3"><Skeleton className="h-7 w-40" /><Skeleton className="h-4 w-96" /></div>
              : focus ? (
                <>
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">committed focus</div>
                    <div className="mt-1 font-mono text-[22px] font-semibold tracking-tight">{focus.focus.project}</div>
                    <p className="mt-1.5 max-w-[62ch] text-muted-foreground">{focus.focus.bet}</p>
                  </div>
                  <div className="min-w-[210px] text-right">
                    <div className="flex items-baseline justify-end gap-1.5">
                      <span className="font-mono text-[26px] font-semibold leading-none">{focus.daysElapsed}</span>
                      <span className="text-muted-foreground">/{focus.focus.horizonDays}d</span>
                      {focus.overdue
                        ? <Badge variant="destructive" className="ml-1.5">overdue</Badge>
                        : <Badge variant="outline" className="ml-1.5">{focus.daysLeft}d left</Badge>}
                    </div>
                    <Fidelity f={focus} />
                  </div>
                </>
              ) : (
                <div className="py-1 text-[15px]">No active commitment — <span className="text-muted-foreground">decide your bet in the CLI.</span></div>
              )}
          </div>
        </Card>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[1.55fr_1fr]">
          {/* ROUTE */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Today's route
                {sprint && <Badge variant="outline" className={cn("uppercase", modeText(sprint.gate))}>{sprint.route.mode}</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? <SkelRows n={3} />
                : sprint ? (
                  <>
                    <BudgetBar r={sprint.route} />
                    <Separator className="my-4" />
                    <ol className="relative">
                      <span className="absolute bottom-3 left-[11px] top-3 w-px bg-border" />
                      {sprint.route.blocks.map((b, i) => {
                        const Icon = KIND[b.kind].icon;
                        return (
                          <li key={i} className="relative flex gap-4 py-2.5">
                            <span className={cn(
                              "z-10 mt-0.5 grid size-[23px] shrink-0 place-items-center rounded-full border bg-card",
                              b.kind === "anchor" ? "border-primary/50 text-primary" : "text-muted-foreground",
                              b.kind === "return" && "text-warn",
                            )}><Icon className="size-3" /></span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="font-mono font-semibold">{b.project}</span>
                                <Badge variant="outline" className="text-[9px] uppercase text-muted-foreground">{KIND[b.kind].label}</Badge>
                                <span className="ml-auto font-mono text-[11px] text-muted-foreground/70">~{fmtK(b.estTokens)} · {b.estMinutes}m</span>
                              </div>
                              <div className="mt-0.5 text-[13px]">{b.task}</div>
                              <div className="mt-1 text-[11px] text-muted-foreground">
                                <span className="mr-1.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/70">stop</span>{b.stop}
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                    {sprint.route.deferred.length > 0 && (
                      <>
                        <div className="my-3 flex items-center gap-3 text-[10px] uppercase tracking-wider text-muted-foreground/70">
                          below the line<Separator className="flex-1" />
                        </div>
                        <div className="space-y-1.5">
                          {sprint.route.deferred.map((d) => (
                            <div key={d.project} className="flex items-center gap-2.5 text-[12px]">
                              <span className="font-mono text-muted-foreground">{d.project}</span>
                              <span className="font-mono text-[11px] text-muted-foreground/60">roi {d.roi.toFixed(1)}</span>
                              <span className="text-muted-foreground/80">{d.reason}</span>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </>
                ) : null}
            </CardContent>
          </Card>

          {/* SWITCH */}
          <Card>
            <CardHeader>
              <CardTitle className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Switch by ROI</CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? <SkelRows n={4} />
                : (
                  <div className="divide-y">
                    {sprint?.switchOptions.map((o) => (
                      <div key={o.name} className="flex items-center gap-2.5 py-2.5 first:pt-0">
                        <span className="font-mono font-semibold">{o.name}</span>
                        <Badge variant="outline" className={cn("font-mono", o.roi >= 7 && "border-ok/40 text-ok")}>roi {o.roi.toFixed(1)}</Badge>
                        <span className="ml-auto max-w-[48%] text-right text-[11px] text-muted-foreground">{o.reason}</span>
                      </div>
                    ))}
                  </div>
                )}
            </CardContent>
          </Card>
        </div>

        {/* SCORES */}
        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Scores <span className="font-mono text-muted-foreground/60">{scores.length}</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? <SkelRows n={5} /> : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-8 text-right">#</TableHead>
                    <TableHead>project</TableHead>
                    <HeadHint label="score" hint="Weighted total across all factors (0–10)." />
                    <HeadHint label="roi" hint="Value / revenue potential toward your goal." />
                    <HeadHint label="prox" hint="Proximity to shippable (Paperclip / AI / git)." />
                    <HeadHint label="mom" hint="Momentum — how recently it was worked (git + claude-mem)." />
                    <HeadHint label="done" hint="Paperclip issues completed / total." />
                    <TableHead className="text-right">cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="font-mono text-[12px]">
                  {scores.slice(0, 12).map((p, i) => (
                    <TableRow key={p.name}>
                      <TableCell className="text-right text-muted-foreground/70">{i + 1}</TableCell>
                      <TableCell className="font-semibold">{p.name}</TableCell>
                      <TableCell className="text-right font-semibold text-primary">{p.score.toFixed(1)}</TableCell>
                      <TableCell className="text-right">{(p.factors.roi * 10).toFixed(1)}</TableCell>
                      <TableCell className="text-right">{(p.factors.proximity * 10).toFixed(1)}</TableCell>
                      <TableCell className="text-right">{(p.factors.momentum * 10).toFixed(1)}</TableCell>
                      <TableCell className="text-right">{p.paperclip ? <span className="text-ok">{p.paperclip.done}/{p.paperclip.total}</span> : <span className="text-muted-foreground/50">·</span>}</TableCell>
                      <TableCell className="text-right text-muted-foreground">{p.costUsd ? "$" + Math.round(p.costUsd) : <span className="text-muted-foreground/50">·</span>}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </TooltipProvider>
  );
}

function MiniMeter({ label, pct }: { label: string; pct: number | null }) {
  const p = pct == null ? 0 : Math.round(pct * 100);
  const tone: Tone = p >= 90 ? "crit" : p >= 60 ? "warn" : "ok";
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex items-center gap-1.5" />}>
        <span className="opacity-70">{label}</span>
        <Progress value={p} className={cn("w-12", indicator[tone])} />
        <span className="w-5">{pct == null ? "—" : p}</span>
      </TooltipTrigger>
      <TooltipContent>{label === "5h" ? "5-hour rolling window" : "Weekly quota"} — {p}% used</TooltipContent>
    </Tooltip>
  );
}

function BudgetBar({ r }: { r: Route }) {
  const cap = r.budgetTokens;
  const pct = cap ? Math.min(100, Math.round((r.usedTokens / cap) * 100)) : 0;
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 font-mono font-semibold">
          <span className="size-1.5 rounded-full bg-primary shadow-[0_0_8px_var(--primary)]" />{r.anchor ?? "—"}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {fmtK(r.usedTokens)}{cap != null && ` / ${fmtK(cap)}`} tok · ~{r.totalMinutes}m
        </span>
      </div>
      {cap != null && <Progress value={pct} className={cn("mt-2", indicator.accent)} />}
    </div>
  );
}

function Fidelity({ f }: { f: FocusStatus }) {
  if (!f.traceable)
    return <div className="mt-3 text-[11px] text-muted-foreground">not token-traced <span className="opacity-70">· non-code bet, judged at verdict</span></div>;
  if (f.fidelity == null) return <div className="mt-3 text-[11px] text-muted-foreground">no activity yet</div>;
  const p = Math.round(f.fidelity * 100);
  const tone: Tone = f.fidelity >= 0.6 ? "ok" : "crit";
  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-end gap-1.5">
        <span className={cn("font-mono text-[15px] font-semibold", tone === "ok" ? "text-ok" : "text-crit")}>{p}%</span>
        <span className="text-[11px] text-muted-foreground">on target{f.fidelity < 0.6 ? " · scattering" : ""}</span>
      </div>
      <Progress value={p} className={cn("mt-1.5", indicator[tone])} />
      {f.leaks.length > 0 && (
        <div className="mt-1.5 font-mono text-[11px] text-muted-foreground/70">
          ↳ {f.leaks.map((l) => `${l.name} ${fmtK(l.tokens)}`).join(" · ")}
        </div>
      )}
    </div>
  );
}

function HeadHint({ label, hint }: { label: string; hint: string }) {
  return (
    <TableHead className="text-right">
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex cursor-help items-center gap-1" />}>
          {label}<Info className="size-3 opacity-40" />
        </TooltipTrigger>
        <TooltipContent className="max-w-56">{hint}</TooltipContent>
      </Tooltip>
    </TableHead>
  );
}

function SkelRows({ n }: { n: number }) {
  return <div className="space-y-3 py-1">{Array.from({ length: n }).map((_, i) => <Skeleton key={i} className="h-4" style={{ width: `${88 - i * 11}%` }} />)}</div>;
}

function modeText(gate: string) {
  return gate === "green" ? "text-ok" : gate === "yellow" ? "text-warn" : "text-crit";
}
