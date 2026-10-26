# pi configuration examples

Templates for running [pi](https://pi.dev) on the local llama.cpp model with
the oracle's MCP tools. See [docs/l3-local-model.md](../../docs/l3-local-model.md#using-the-local-model-as-an-agent-pi).

- `models.json`: copy into pi's agent directory (merge with an existing file).
- `mcp.json`: copy to `.pi/mcp.json` in a project, or `~/.pi/agent/mcp.json`
  for all projects, and replace the absolute path.
