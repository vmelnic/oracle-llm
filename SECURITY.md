# Security policy

## Supported versions

Security fixes are applied to the current `main` branch. Until a stable release is tagged, deployments should pin an exact commit and update only after CI passes.

## Reporting a vulnerability

Do not open a public issue containing exploit details, credentials, filesystem paths, or source code from indexed workspaces. Report vulnerabilities privately to the repository owner and include the affected commit, reproduction steps, impact, and suggested mitigation.

## Deployment baseline

- Prefer the `stdio` transport for local MCP clients.
- HTTP binds to `127.0.0.1` by default. A non-loopback bind requires an `ORACLE_MCP_AUTH_TOKEN` of at least 32 bytes and an explicit `ORACLE_MCP_ALLOWED_HOSTS` allowlist.
- HTTP administrative tools are disabled by default. Enabling them requires both `ORACLE_MCP_ADMIN_ENABLED=true` and `ORACLE_ALLOWED_ROOTS`.
- Terminate TLS at a trusted reverse proxy, restrict network access, rotate bearer tokens, and run the process as an unprivileged OS user.
- Treat indexed projects and model endpoints as untrusted input. Keep the configured resource limits enabled.
- `oracle.gate` can execute a project's compiler and tests. The temporary shadow workspace protects source files from proposed edits, but it is not a security sandbox; evaluate untrusted repositories inside an OS container or VM with no secrets and restricted network access.
