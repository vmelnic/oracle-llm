import fs from 'node:fs';
import { Command } from 'commander';
import { downloadModel, formatBytes, llmConfig, processRss, readPid, serverStatus, startServer, stopServer } from '../../llm/server.js';
import { runL3Bench } from '../../llm/bench.js';
import { l3Config } from '../../l3/config.js';
import { L3InferenceEngine } from '../../l3/inference.js';
import { readJsonFile, requireGraph, requireSubproject } from '../resolve.js';

export function llmCommand() {
  const cmd = new Command('llm');
  cmd.description('Local model server for L3 (llama.cpp llama-server; settings: ORACLE_LLM_* in .env)');

  cmd
    .command('download')
    .description('Download the GGUF model (ORACLE_LLM_HF_REPO / ORACLE_LLM_HF_FILE) and verify its SHA-256')
    .action(async () => {
      await downloadModel(llmConfig(), { log: console.log });
    });

  cmd
    .command('start')
    .description('Start llama-server in the background and wait until it is ready')
    .action(async () => {
      const { baseUrl } = await startServer(llmConfig(), { log: console.log });
      console.log(`Point L3 at it: ORACLE_L3_BASE_URL=${baseUrl}  ORACLE_L3_MODEL=${llmConfig().alias}`);
    });

  cmd
    .command('stop')
    .description('Stop the background llama-server')
    .action(async () => {
      await stopServer(llmConfig(), { log: console.log });
    });

  cmd
    .command('status')
    .description('Show whether llama-server is running, its model, health and memory')
    .option('--json', 'Print JSON')
    .action(async (opts) => {
      const status = await serverStatus(llmConfig());
      if (opts.json) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        console.log(`llama-server: ${status.running ? `running (pid ${status.pid}, ${status.health})` : 'stopped'}`);
        console.log(`  endpoint: ${status.baseUrl}`);
        console.log(`  model:    ${status.model}${status.servedModels ? ` (serving: ${status.servedModels.join(', ')})` : ''}`);
        console.log(`  file:     ${status.modelPath} ${status.modelPresent ? `(${formatBytes(status.modelBytes)})` : '(not downloaded)'}`);
        if (status.rssBytes) console.log(`  memory:   ${formatBytes(status.rssBytes)} resident`);
        console.log(`  log:      ${status.log}`);
      }
      if (!status.running) process.exitCode = 1;
    });

  cmd
    .command('bench <workspace_id> <subproject_id>')
    .description('Measure L3 speed and grounding acceptance on real tool results (uses ORACLE_L3_* settings)')
    .option('--tasks <path>', 'JSON array of { "tool": "oracle.context"|"oracle.where_would"|"oracle.conventions_for", "args": {...} }')
    .option('--output <path>', 'Write the full results as JSON')
    .action(async (workspaceId, subprojectId, opts) => {
      const { workspace } = requireSubproject(workspaceId, subprojectId);
      requireGraph(workspaceId, subprojectId);
      const config = l3Config();
      if (!config.baseUrl) throw new Error('ORACLE_L3_BASE_URL is not set (the bench uses the L3 settings, enabled or not).');

      const cfg = llmConfig();
      const pid = readPid(cfg);
      console.log(`Model: ${config.model} at ${config.baseUrl}${pid ? ` (local llama-server pid ${pid})` : ''}\n`);
      const { rows, summary } = await runL3Bench({
        workspace,
        subprojectId,
        engine: new L3InferenceEngine(config),
        tasks: opts.tasks ? readJsonFile(opts.tasks, 'tasks file') : null,
        log: console.log,
        rssOf: pid ? () => processRss(pid) : undefined,
      });

      console.log('\n--- Summary ---');
      console.log(`  accepted:    ${summary.accepted}/${summary.tasks - summary.skipped} (${Math.round(summary.acceptanceRate * 100)}%), rejected ${summary.rejected}, failed ${summary.failed}, skipped ${summary.skipped}`);
      console.log(`  latency:     p50 ${summary.latencyMs.p50} ms, p95 ${summary.latencyMs.p95} ms, max ${summary.latencyMs.max} ms`);
      console.log(`  speed:       ${summary.avgTokensPerSecond ?? '-'} tok/s generation${summary.avgPromptTokensPerSecond ? `, ${summary.avgPromptTokensPerSecond} tok/s prompt` : ''} (avg ${summary.avgCompletionTokens ?? '-'} completion tokens)`);
      if (summary.peakRssBytes) console.log(`  server RAM:  ${formatBytes(summary.peakRssBytes)} peak resident`);
      for (const [reason, n] of Object.entries(summary.reasons)) console.log(`  ${n}x ${reason}`);
      if (opts.output) {
        fs.writeFileSync(opts.output, JSON.stringify({ model: config.model, baseUrl: config.baseUrl, summary, rows }, null, 2));
        console.log(`\nResults written to ${opts.output}`);
      }
    });

  return cmd;
}
