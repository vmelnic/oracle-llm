import { Command, Option } from 'commander';
import { startMcpServer } from '../../mcp/index.js';
import { intOption } from '../resolve.js';

export function serveCommand() {
  const cmd = new Command('serve');
  cmd
    .description('Start the MCP server')
    .addOption(new Option('--transport <type>', 'Transport type (sse is a deprecated alias for http)').choices(['stdio', 'http', 'sse']).default('stdio'))
    .option('--host <host>', 'Host for HTTP transport', process.env.ORACLE_MCP_HOST || '127.0.0.1')
    .option('--port <number>', 'Port for HTTP transport', intOption(1, 65535), Number(process.env.ORACLE_MCP_PORT || 3000))
    .option('--idle-timeout <minutes>', 'Idle timeout in minutes (0 to disable)', intOption(0), Number(process.env.ORACLE_MCP_IDLE_TIMEOUT_MINUTES || 0))
    .option('--watch', 'Watch workspace files for changes and auto-reindex', false)
    .action(async (opts) => {
      await startMcpServer({
        transport: opts.transport,
        host: opts.host,
        port: opts.port,
        idleTimeoutMinutes: opts.idleTimeout,
        watch: opts.watch,
      });
    });
  return cmd;
}
