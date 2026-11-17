// The forge's HTTP surface: git smart HTTP, REST v3, GraphQL v4 and MCP, one process, one store.
// main.ts owns the lifecycle (bind, register, poll /done); this file is the server it serves.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { store } from './store.ts';
import { handleRest, sendJson, sendError } from './rest.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './git.ts';
import { executeGraphQL } from './gql.ts';
import { handleMcpBody } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY = 256 * 1024 * 1024;

function expectedToken(): string | null {
  return process.env.MAKEFUN_SHOP_TOKEN ?? null;
}

function isAuthorized(req: IncomingMessage): boolean {
  const expected = expectedToken();
  if (!expected) return true; // local development without the trial env
  const header = req.headers.authorization;
  return header === `Bearer ${expected}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Bad credentials' });
}

export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch) {
          if (!isAuthorized(req)) { unauthorized(res); return; }
          const owner = decodeURIComponent(gitMatch[1]);
          const repoName = decodeURIComponent(gitMatch[2]);
          const repo = store.getRepo(owner, repoName) ?? null;
          const tail = gitMatch[3] ?? '';
          const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
          if (method === 'GET' && tail === '/info/refs') {
            const service = url.searchParams.get('service') ?? '';
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              sendJson(res, 400, { message: 'service required' });
              return;
            }
            handleInfoRefs(req, res, repo, service, isV2);
            return;
          }
          if (method === 'POST' && (tail === '/git-upload-pack' || tail === '/git-receive-pack')) {
            if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
            const body = await readBody(req);
            try {
              if (tail === '/git-upload-pack') handleUploadPack(res, repo, body, isV2);
              else handleReceivePack(res, repo, body);
            } catch (err) {
              // A malformed git request must never take the forge down (repo-survives-errors).
              if (!res.headersSent) sendJson(res, 400, { message: err instanceof Error ? err.message : 'Bad Request' });
              else res.end();
            }
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // MCP
        if (path === '/mcp') {
          if (!isAuthorized(req)) { unauthorized(res); return; }
          if (method === 'POST') {
            const body = await readBody(req);
            const { status, json } = handleMcpBody(body);
            if (json === undefined) {
              res.writeHead(status);
              res.end();
            } else {
              sendJson(res, status, json);
            }
            return;
          }
          if (method === 'DELETE') { res.writeHead(204); res.end(); return; }
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }

        // GraphQL
        if (path === '/api/graphql') {
          if (!isAuthorized(req)) { unauthorized(res); return; }
          if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Body is not valid JSON' });
            return;
          }
          const runOne = (item: { query?: string; variables?: Record<string, unknown>; operationName?: string }) =>
            executeGraphQL(String(item.query ?? ''), item.variables ?? {}, item.operationName);
          if (Array.isArray(parsed)) {
            sendJson(res, 200, parsed.map((item) => runOne(item as never)));
            return;
          }
          const single = parsed as { query?: string; variables?: Record<string, unknown>; operationName?: string };
          try {
            sendJson(res, 200, runOne(single));
          } catch (err) {
            sendJson(res, 200, { errors: [{ message: err instanceof Error ? err.message : 'GraphQL error' }] });
          }
          return;
        }

        // REST v3
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!isAuthorized(req)) { unauthorized(res); return; }
          const raw = await readBody(req);
          let body: Record<string, unknown> | null = null;
          if (raw.length > 0) {
            try {
              const parsedBody = JSON.parse(raw.toString('utf8'));
              body = typeof parsedBody === 'object' && parsedBody !== null ? (parsedBody as Record<string, unknown>) : {};
            } catch {
              sendJson(res, 400, { message: 'Body is not valid JSON' });
              return;
            }
          }
          const segments = path === '/api/v3' || path === '/api/v3/'
            ? []
            : path.slice('/api/v3/'.length).split('/');
          const handled = await handleRest({ req, res, url, body, rawBody: raw }, segments);
          if (!handled) sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) sendError(res, err);
        else res.end();
      }
    })();
  });
  server.headersTimeout = 120_000;
  server.requestTimeout = 0;
  return server;
}
