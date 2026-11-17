# github-forge-entry

A standalone, GitHub-compatible git forge in a single Node process, built from scratch
on the Node standard library alone — no dependencies, no database, no `git` binary.

It serves the four surfaces agents and tools already speak, all over one in-memory store:

- **Git smart HTTP** — upload-pack protocol v2 (`ls-refs`, `fetch` with shallow/deepen)
  and v0, receive-pack v0 with fast-forward enforcement and report-status.
  Packfiles are parsed and written natively, including OFS/REF delta resolution.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents, labels,
  issues, comments and pull requests (including squash/merge merges with three-way
  tree merges and conflict detection).
- **GraphQL v4** at `/api/graphql` — the queries and mutations `gh` and
  `github-mcp-server` send: viewer, repository, node, issue/pullRequest connections
  with cursor pagination, introspection, createIssue, closeIssue, createPullRequest,
  mergePullRequest, addComment.
- **MCP** at `/mcp` — JSON-RPC over streamable HTTP (2026-07-28 `server/discover` plus
  the classic `initialize` handshake) with repo/issue/pull-request tools backed by the
  same store as REST.

## Run it

```sh
node --experimental-strip-types main.ts
```

The process expects `MAKEFUN_ENV_URL` (the harness it registers its ephemeral port
with) and answers `GET /healthz` as a boot probe. For local development,
`dev-run.ts` serves the same app on a fixed port.

## Layout

- `main.ts` — the harness lifecycle: bind, register, poll `/done`, exit.
- `app.ts` — HTTP routing, auth, and surface dispatch.
- `git.ts` — smart HTTP: advertisements, ls-refs, fetch closures (shallow-aware), push.
- `pack.ts` — packfile read/write and pkt-line framing.
- `store.ts` — the in-memory store and git object model (trees, commits, ancestry).
- `rest.ts` — the REST v3 surface.
- `gql.ts` — a small GraphQL parser/executor for the suite's documents.
- `mcp.ts` — the MCP endpoint.
- `domain.ts` — issues, pull requests, merges and JSON shapes shared by all surfaces.

## License

MIT (see `LICENSE`).
