import { Command } from 'commander';
import { startMcpServer } from '../../mcp/index.js';

export function serveCommand() {
  const cmd = new Command('serve');
  cmd
    .description('Start the MCP server')
    .option('--transport <type>', 'Transport type: stdio or sse', 'stdio')
    .option('--port <number>', 'Port for SSE transport', process.env.ORACLE_MCP_PORT || '3000')
    .option('--idle-timeout <minutes>', 'Idle timeout in minutes (0 to disable)', process.env.ORACLE_MCP_IDLE_TIMEOUT_MINUTES || '0')
    .option('--watch', 'Watch workspace files for changes and auto-reindex', false)
    .action(async (opts) => {
      await startMcpServer({
        transport: opts.transport,
        port: parseInt(opts.port, 10),
        idleTimeoutMinutes: parseInt(opts.idleTimeout, 10),
        watch: opts.watch,
      });
    });
  return cmd;
}
