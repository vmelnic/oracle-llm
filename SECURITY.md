# Security policy

## Supported versions

Security fixes are applied to the current `main` branch. Until a stable release is tagged, deployments should pin an exact commit and update only after CI passes.

## Reporting a vulnerability

Do not open a public issue containing exploit details, credentials, filesystem paths, or source code from indexed workspaces. Report vulnerabilities privately to the repository owner and include the affected commit, reproduction steps, impact, and suggested mitigation.

## Deployment baseline

- Prefer the `stdio` transport for local MCP clients.
- HTTP binds to `127.0.0.1` by default. A non-loopback bind requires an `ORACLE_MCP_AUTH_TOKEN` of at least 32 bytes and an explicit `ORACLE_MCP_ALLOWED_HOSTS` allowlist.
- HTTP administrative tools are disabled by default. Enabling them requires both `ORACLE_MCP_ADMIN_ENABLED=true` and `ORACLE_ALLOWED_ROOTS`. Over HTTP, `ORACLE_ALLOWED_ROOTS` also limits which workspaces the query tools can read.
- Terminate TLS at a trusted reverse proxy, restrict network access, rotate bearer tokens, and run the process as an unprivileged OS user.
- Treat indexed projects and model endpoints as untrusted input. Keep the configured resource limits enabled.
- `oracle.gate` can execute a project's compiler and tests. The temporary shadow workspace protects source files from proposed edits, but it is not a security sandbox; evaluate untrusted repositories inside an OS container or VM with no secrets and restricted network access. Over HTTP it is off unless `ORACLE_MCP_GATE_ENABLED=true` is set in addition to admin tools. Language servers run only if already installed (`npx --no`); the gate never downloads tooling.
- L3 receives repository-derived text as fenced, untrusted context, and its synthesis is labelled untrusted in tool responses. Downstream agents should still treat it as data, not instructions. Its citations are checked against verified facts; uncheckable answers are dropped.
- The optional local model server (`oracle llm start`, llama.cpp) binds to `127.0.0.1` by default and refuses a non-loopback address without `ORACLE_LLM_API_KEY` (passed to the process via its environment, not its command line). Model files are downloaded only by `oracle llm download` and verified against a SHA-256 (Hugging Face's published checksum or `ORACLE_LLM_SHA256`). The oracle never installs software; llama.cpp is installed by the operator.
- Hosted L3 backends receive repository facts (symbol names, paths, documented rules). Use a local backend when code must not leave the machine.
- The HTTP rate limit is keyed by client socket address; behind a reverse proxy, rate-limit at the proxy.
