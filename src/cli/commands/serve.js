import { Command } from 'commander';
import { startMcpServer } from '../../mcp/index.js';

export function serveCommand() {
  const cmd = new Command('serve');
  cmd
    .description('Start the MCP server')
    .option('--transport <type>', 'Transport type: stdio or http (sse is accepted as a deprecated alias)', 'stdio')
    .option('--host <host>', 'Host for HTTP transport', process.env.ORACLE_MCP_HOST || '127.0.0.1')
    .option('--port <number>', 'Port for HTTP transport', process.env.ORACLE_MCP_PORT || '3000')
    .option('--idle-timeout <minutes>', 'Idle timeout in minutes (0 to disable)', process.env.ORACLE_MCP_IDLE_TIMEOUT_MINUTES || '0')
    .option('--watch', 'Watch workspace files for changes and auto-reindex', false)
    .action(async (opts) => {
      await startMcpServer({
        transport: opts.transport,
        host: opts.host,
        port: parseInt(opts.port, 10),
        idleTimeoutMinutes: parseInt(opts.idleTimeout, 10),
        watch: opts.watch,
      });
    });
  return cmd;
}
