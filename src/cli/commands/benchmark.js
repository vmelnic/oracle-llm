import { Command } from 'commander';
import fs from 'fs';
import { readJsonFile, requireGraph, requireSubproject } from '../resolve.js';
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
      const { workspace } = requireSubproject(workspaceId, subprojectId);
      const { dbPath } = requireGraph(workspaceId, subprojectId);

      let tasks;
      if (opts.tasks) {
        tasks = readJsonFile(opts.tasks, 'tasks file');
      } else {
        const store = new GraphStore(dbPath);
        try {
          tasks = generateDefaultTasks(store, subprojectId);
        } finally {
          store.close();
        }
        console.log(`Auto-generated ${tasks.length} benchmark tasks\n`);
      }

      const runner = new BenchmarkRunner(workspace, subprojectId);
      let summary;
      try {
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
        summary = runner.summarize();
      } finally {
        runner.close();
      }

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
