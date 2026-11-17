// MCP (Model Context Protocol) endpoint at /mcp: JSON-RPC 2.0 over streamable HTTP.
// Speaks the 2026-07-28 revision (server/discover) and the classic initialize handshake.

import { store, VIEWER } from './store.ts';
import {
  HttpError, repoJson, issueJson, pullJson, createIssue, createPull, mergePull,
} from './domain.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  required: string[];
  properties: Record<string, { type: string; description: string }>;
  run: (args: Record<string, unknown>) => Record<string, unknown>;
}

function argStr(args: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = args[n];
    if (typeof v === 'string' && v !== '') return v;
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

function ownerRepo(args: Record<string, unknown>): { owner: string; repoName: string } {
  let owner = argStr(args, 'owner');
  let repoName = argStr(args, 'repo', 'name', 'repository');
  const fullName = argStr(args, 'full_name', 'fullName');
  if (fullName && fullName.includes('/')) {
    const [o, r] = fullName.split('/', 2);
    owner = owner ?? o;
    repoName = repoName ?? r;
  }
  return { owner: owner ?? VIEWER.login, repoName: repoName ?? '' };
}

function requireRepoFromArgs(args: Record<string, unknown>) {
  const { owner, repoName } = ownerRepo(args);
  const repo = store.getRepo(owner, repoName);
  if (!repo) throw new Error(`repository ${owner}/${repoName} not found`);
  return repo;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'Repository name' },
      description: { type: 'string', description: 'Repository description' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
    },
    run: (args) => {
      const name = argStr(args, 'name')!;
      if (store.getRepo(VIEWER.login, name)) throw new Error(`repository ${name} already exists`);
      const repo = store.createRepo(name, argStr(args, 'description') ?? null, args.private === true);
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get details of a repository by owner and name.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      full_name: { type: 'string', description: 'Full name in owner/repo form' },
    },
    run: (args) => repoJson(requireRepoFromArgs(args)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    required: ['owner', 'repo', 'title'],
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      full_name: { type: 'string', description: 'Full name in owner/repo form' },
      title: { type: 'string', description: 'Issue title' },
      body: { type: 'string', description: 'Issue body' },
    },
    run: (args) => {
      const repo = requireRepoFromArgs(args);
      const rec = createIssue(repo, { title: argStr(args, 'title')!, body: argStr(args, 'body') ?? null });
      return issueJson(repo, rec);
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      full_name: { type: 'string', description: 'Full name in owner/repo form' },
      state: { type: 'string', description: 'Filter by state: open, closed, or all' },
    },
    run: (args) => {
      const repo = requireRepoFromArgs(args);
      const state = argStr(args, 'state') ?? 'open';
      let items = [...repo.issues.values()].filter((i) => !i.isPull);
      if (state === 'open') items = items.filter((i) => i.state === 'open');
      else if (state === 'closed') items = items.filter((i) => i.state === 'closed');
      items.sort((a, b) => b.number - a.number);
      return { issues: items.map((i) => issueJson(repo, i)), total_count: items.length };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch to a base branch.',
    required: ['owner', 'repo', 'title', 'head', 'base'],
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      full_name: { type: 'string', description: 'Full name in owner/repo form' },
      title: { type: 'string', description: 'Pull request title' },
      body: { type: 'string', description: 'Pull request body' },
      head: { type: 'string', description: 'Head branch name' },
      base: { type: 'string', description: 'Base branch name' },
    },
    run: (args) => {
      const repo = requireRepoFromArgs(args);
      const rec = createPull(repo, {
        title: argStr(args, 'title')!,
        body: argStr(args, 'body') ?? null,
        head: argStr(args, 'head')!,
        base: argStr(args, 'base')!,
      });
      return pullJson(repo, rec);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash merge).',
    required: ['owner', 'repo', 'pull_number'],
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      full_name: { type: 'string', description: 'Full name in owner/repo form' },
      pull_number: { type: 'number', description: 'Pull request number' },
    },
    run: (args) => {
      const repo = requireRepoFromArgs(args);
      const numRaw = args.pull_number ?? args.pullNumber ?? args.number;
      const num = typeof numRaw === 'number' ? numRaw : parseInt(String(numRaw ?? ''), 10);
      const rec = repo.issues.get(num);
      if (!rec?.isPull) throw new Error(`pull request ${num} not found`);
      const sha = mergePull(repo, rec, 'squash');
      return { sha, merged: true, message: 'Pull Request successfully merged', pull_request: pullJson(repo, rec) };
    },
  },
];

const toolsListResult = {
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: {
      type: 'object',
      properties: t.properties,
      required: t.required,
    },
  })),
};
export const TOOLS_LIST_JSON = JSON.stringify(toolsListResult);

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: string | number | null | undefined, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function rpcError(id: string | number | null | undefined, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export function handleRpc(rpc: RpcRequest): Record<string, unknown> | null {
  const { id, method } = rpc;
  const params = rpc.params ?? {};
  const isNotification = id === undefined || id === null;
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: { name: 'forge-mcp', version: '1.0.0' },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: 'forge-mcp', version: '1.0.0' },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, toolsListResult);
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((t) => t.name === toolName)
        ?? TOOLS.find((t) => toolName.toLowerCase().endsWith(t.name));
      if (!tool) return rpcError(id, -32602, `unknown tool: ${toolName}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      for (const req of tool.required) {
        if (argStr(args, req) === undefined && args[req] === undefined) {
          return rpcResult(id, {
            content: [{ type: 'text', text: `missing required argument: ${req}` }],
            isError: true,
          });
        }
      }
      try {
        const out = tool.run(args);
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(out) }],
          structuredContent: out,
          isError: false,
        });
      } catch (err) {
        const message = err instanceof HttpError ? err.message : err instanceof Error ? err.message : 'tool call failed';
        return rpcResult(id, {
          content: [{ type: 'text', text: message }],
          isError: true,
        });
      }
    }
    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

/** Handle one raw POST body; returns {status, json} to send. Notifications yield 202 with no body. */
export function handleMcpBody(raw: Buffer): { status: number; json?: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return { status: 400, json: rpcError(null, -32700, 'Parse error: body is not valid JSON') };
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((item) => handleRpc(item as RpcRequest)).filter((r) => r !== null);
    return { status: 200, json: results };
  }
  const result = handleRpc(parsed as RpcRequest);
  if (result === null) return { status: 202 };
  return { status: 200, json: result };
}
