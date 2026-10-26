import { loadToolContext } from '../benchmark/index.js';
import { synthesizeWithL3 } from '../l3/synthesize.js';
import { fillPlaceholders, loadJsonTemplate } from '../l3/prompts.js';
import { context } from '../mcp/tools/context.js';
import { whereWould } from '../mcp/tools/where-would.js';
import { conventionsFor } from '../mcp/tools/conventions-for.js';

const HANDLERS = {
  'oracle.context': context,
  'oracle.where_would': whereWould,
  'oracle.conventions_for': conventionsFor,
};

/**
 * Runs the production L3 path (tool -> verified facts -> model -> grounding
 * check) over a set of tasks and reports speed and acceptance, so models and
 * backends can be compared on the actual job. `engine` is any
 * L3InferenceEngine; `rssOf` optionally samples the model server's memory.
 */
export async function runL3Bench({ workspace, subprojectId, engine, tasks, log = () => {}, rssOf = () => null }) {
  const ctx = loadToolContext(workspace, subprojectId);
  ctx.l3 = engine;
  try {
    const list = tasks?.length ? tasks : defaultTasks(ctx);
    // Warm-up: the first request also pays for loading weights and caches.
    await runOne(ctx, list[0]);

    const rows = [];
    let peakRss = rssOf() || 0;
    for (const [i, task] of list.entries()) {
      const row = await runOne(ctx, task);
      rows.push(row);
      peakRss = Math.max(peakRss, rssOf() || 0);
      log(`[${i + 1}/${list.length}] ${row.status.padEnd(8)} ${String(row.latencyMs ?? '-').padStart(6)} ms  ${row.tokensPerSecond ? `${row.tokensPerSecond} tok/s` : ''}  ${task.tool} ${JSON.stringify(task.args)}${row.reason ? `  (${row.reason})` : ''}`);
    }
    return { rows, summary: summarize(rows, peakRss) };
  } finally {
    ctx.store.close();
  }
}

async function runOne(ctx, task) {
  const raw = await HANDLERS[task.tool](ctx, task.args);
  const result = { ...raw, evidence: (raw.evidence || []).map(e => ({ ...e, subproject_root: e.subproject_root || ctx.subproject.root })) };
  const { outcome } = await synthesizeWithL3(ctx, task.tool, task.args, result);
  const completion = outcome.usage?.completion_tokens || 0;
  const t = outcome.timings;
  return {
    tool: task.tool,
    args: task.args,
    status: outcome.status,
    reason: outcome.status === 'accepted' ? undefined : outcome.reason,
    latencyMs: outcome.latencyMs ?? null,
    promptTokens: outcome.usage?.prompt_tokens ?? null,
    completionTokens: completion || null,
    // Server-reported decode/prefill speeds when available (llama.cpp),
    // otherwise end-to-end tokens per second.
    tokensPerSecond: t?.predicted_per_second ? Math.round(t.predicted_per_second)
      : (completion && outcome.latencyMs ? Math.round(completion / (outcome.latencyMs / 1000)) : null),
    promptTokensPerSecond: t?.prompt_per_second ? Math.round(t.prompt_per_second) : null,
    answer: outcome.text,
  };
}

// Tasks derived from the indexed code (most referenced symbols) using the
// templates in prompts/l3/bench-tasks.json, so the bench works on any subproject.
function defaultTasks(ctx) {
  const top = ctx.store.db.prepare(`
    SELECT n.symbol, COUNT(e.id) AS refs FROM nodes n
    JOIN edges e ON e.target_id = n.id
    WHERE n.subproject_id = ? AND n.kind IN ('function', 'class') AND n.symbol NOT LIKE '%.%'
    GROUP BY n.id ORDER BY refs DESC, n.symbol LIMIT 4
  `).all(ctx.subproject.id).map(r => r.symbol);
  const templates = loadJsonTemplate('bench-tasks.json');
  return [
    ...top.flatMap(symbol => fillPlaceholders(templates.perSymbol || [], { symbol })),
    ...top.slice(0, 2).flatMap(symbol => fillPlaceholders(templates.perTopSymbol || [], { symbol })),
    ...(templates.fixed || []),
  ];
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function summarize(rows, peakRss) {
  const answered = rows.filter(r => r.latencyMs != null);
  const latencies = answered.map(r => r.latencyMs).sort((a, b) => a - b);
  const speeds = answered.map(r => r.tokensPerSecond).filter(Boolean);
  const prefill = answered.map(r => r.promptTokensPerSecond).filter(Boolean);
  const count = (status) => rows.filter(r => r.status === status).length;
  const reasons = {};
  for (const r of rows.filter(r => r.reason)) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  return {
    tasks: rows.length,
    accepted: count('accepted'),
    rejected: count('rejected'),
    failed: count('failed'),
    skipped: count('skipped'),
    acceptanceRate: answered.length ? Math.round((count('accepted') / answered.length) * 100) / 100 : 0,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: latencies.at(-1) ?? null },
    avgTokensPerSecond: speeds.length ? Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length) : null,
    avgPromptTokensPerSecond: prefill.length ? Math.round(prefill.reduce((a, b) => a + b, 0) / prefill.length) : null,
    avgCompletionTokens: answered.length ? Math.round(answered.reduce((a, r) => a + (r.completionTokens || 0), 0) / answered.length) : null,
    peakRssBytes: peakRss || null,
    reasons,
  };
}
