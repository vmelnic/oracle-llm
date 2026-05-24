import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import { loadWorkspace, getSubprojectDir } from '../../scanner/workspace.js';
import { GraphStore } from '../../graph/store.js';
import { BenchmarkRunner, generateDefaultTasks } from '../../benchmark/index.js';

export function benchmarkCommand() {
  const cmd = new Command('benchmark');
  cmd
    .description('Run efficiency benchmark — measures tokens, latency, accuracy per oracle query')
    .argument('<workspace_id>', 'Workspace ID')
    .argument('<subproject_id>', 'Subproject ID')
    .option('--tasks <path>', 'Path to tasks JSON file (default: auto-generate)')
    .option('--output <path>', 'Write results JSON to file')
    .action(async (workspaceId, subprojectId, opts) => {
      const workspace = loadWorkspace(workspaceId);
      if (!workspace) {
        console.error(`Workspace '${workspaceId}' not found.`);
        process.exit(1);
      }

      const sp = workspace.subprojects.find((s) => s.id === subprojectId);
      if (!sp) {
        console.error(`Subproject '${subprojectId}' not found.`);
        process.exit(1);
      }

      const dir = getSubprojectDir(workspaceId, subprojectId);
      const dbPath = path.join(dir, 'entity_graph.sqlite');
      if (!fs.existsSync(dbPath)) {
        console.error(`Entity graph not built. Run 'oracle ingest' first.`);
        process.exit(1);
      }

      let tasks;
      if (opts.tasks) {
        tasks = JSON.parse(fs.readFileSync(opts.tasks, 'utf-8'));
      } else {
        const store = new GraphStore(dbPath);
        tasks = generateDefaultTasks(store, subprojectId);
        store.close();
        console.log(`Auto-generated ${tasks.length} benchmark tasks\n`);
      }

      const runner = new BenchmarkRunner(workspace, subprojectId);

      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        process.stdout.write(`[${i + 1}/${tasks.length}] ${task.description.slice(0, 60)} ... `);
        const entry = await runner.runTask(task);
        if (entry.error) {
          console.log(`ERROR: ${entry.error}`);
        } else {
          const ratio = entry.reductionRatio > 0 ? ` (${entry.reductionRatio}x reduction)` : '';
          console.log(`${entry.oracleTokens} tokens vs ${entry.baselineTokens} baseline, ${entry.oracleLatencyMs}ms, conf=${entry.confidence}${ratio}`);
        }
      }

      const summary = runner.summarize();
      runner.close();

      console.log('\n--- Summary ---');
      console.log(`  tasks: ${summary.total} (${summary.successful} ok, ${summary.errors} errors)`);
      console.log(`  avg oracle tokens/query: ${summary.avgTokensPerQuery}`);
      console.log(`  avg baseline tokens/query: ${summary.avgBaselineTokensPerQuery}`);
      console.log(`  avg reduction: ${summary.avgReductionRatio}x`);
      console.log(`  avg latency: ${summary.avgLatencyMs}ms`);
      console.log(`  evidence pointers: ${summary.totalEvidencePointers}`);
      console.log(`  evidence verification: ${(summary.evidenceVerificationRate * 100).toFixed(1)}%`);
      console.log(`  avg confidence: ${summary.avgConfidence}`);

      if (opts.output) {
        fs.writeFileSync(opts.output, JSON.stringify(summary, null, 2));
        console.log(`\nResults written to ${opts.output}`);
      }
    });

  return cmd;
}
