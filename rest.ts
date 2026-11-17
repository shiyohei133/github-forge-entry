// GitHub REST v3 surface under /api/v3.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  store, VIEWER, type Repo,
  parseCommit, buildCommit, makeIdent,
} from './store.ts';
import {
  HttpError, userJson, repoJson, labelJson, issueJson, pullJson, commitJson,
  createIssue, createPull, mergePull, pullFiles,
} from './domain.ts';

let requestCounter = 0;

export function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-GitHub-Request-Id': `F${(++requestCounter).toString(16).toUpperCase().padStart(7, '0')}:0000:000000:000000:00000000`,
    ...extraHeaders,
  });
  res.end(text);
}

export function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof HttpError) {
    sendJson(res, err.status, { message: err.message });
  } else {
    sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
  }
}

function notFound(): never {
  throw new HttpError(404, 'Not Found');
}

function requireRepo(owner: string, name: string): Repo {
  const repo = store.getRepo(owner, name);
  if (!repo) notFound();
  return repo!;
}

function pageParams(url: URL): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(res: ServerResponse, req: IncomingMessage, url: URL, items: T[]): T[] {
  const { page, perPage } = pageParams(url);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const headers: Record<string, string> = {};
  if (page < totalPages) {
    const base = `http://${req.headers.host}${url.pathname}`;
    const next = new URLSearchParams(url.searchParams);
    next.set('page', String(page + 1));
    next.set('per_page', String(perPage));
    const last = new URLSearchParams(url.searchParams);
    last.set('page', String(totalPages));
    last.set('per_page', String(perPage));
    headers['Link'] = `<${base}?${next.toString()}>; rel="next", <${base}?${last.toString()}>; rel="last"`;
  }
  if (Object.keys(headers).length) {
    // stash for sendJson by the caller via res.setHeader
    res.setHeader('Link', headers['Link']);
  }
  return items.slice((page - 1) * perPage, page * perPage);
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: Record<string, unknown> | null;
  rawBody: Buffer;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export async function handleRest(ctx: Ctx, segments: string[]): Promise<boolean> {
  const { res, url, body } = ctx;
  const method = ctx.req.method ?? 'GET';
  // segments are the path parts after /api/v3
  try {
    // Root + meta + user
    if (segments.length === 0 && method === 'GET') {
      sendJson(res, 200, {
        current_user_url: 'https://api.github.com/user',
        repository_url: 'https://api.github.com/repos/{owner}/{repo}',
        issue_search_url: 'https://api.github.com/search/issues?q={query}',
      }, { 'X-OAuth-Scopes': 'repo, read:org' });
      return true;
    }
    if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
      sendJson(res, 200, { verifiable_password_authentication: false, installed_version: '3.18-forge-1', hooks: [], pages: [], git: [] });
      return true;
    }
    if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
      sendJson(res, 200, { ...userJson(), name: VIEWER.name, email: VIEWER.email, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', public_repos: store.listRepos().length, followers: 0, following: 0 });
      return true;
    }
    if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
      if (method === 'GET') {
        const items = store.listRepos().map(repoJson);
        sendJson(res, 200, paginate(res, ctx.req, url, items));
        return true;
      }
      if (method === 'POST') {
        const name = str(body?.name);
        if (!name) throw new HttpError(422, 'name is required');
        if (store.getRepo(VIEWER.login, name)) throw new HttpError(422, 'name already exists on this account');
        const repo = store.createRepo(name, str(body?.description) ?? null, body?.private === true);
        if (body?.auto_init === true) {
          const blob = store.putObject(repo, 'blob', Buffer.from('# ' + name + '\n', 'utf8'));
          const flat = new Map([['README.md', { mode: '100644', sha: blob }]]);
          const tree = store.buildTreeFromFlat(repo, flat);
          const when = store.nowSec();
          const ident = makeIdent(VIEWER.name, VIEWER.email, when);
          const commit = store.putObject(repo, 'commit', buildCommit({ tree, parents: [], author: ident, committer: ident, message: 'Initial commit\n' }));
          repo.refs.set(`refs/heads/${repo.defaultBranch}`, commit);
        }
        sendJson(res, 201, repoJson(repo));
        return true;
      }
    }
    if (segments[0] === 'users' && segments[2] === 'repos' && segments.length === 3 && method === 'GET') {
      const items = segments[1] === VIEWER.login ? store.listRepos().map(repoJson) : [];
      sendJson(res, 200, paginate(res, ctx.req, url, items));
      return true;
    }

    if (segments[0] === 'repos' && segments.length >= 3) {
      const owner = segments[1];
      const name = segments[2];
      const rest = segments.slice(3);
      if (rest.length === 0) {
        if (method === 'GET') { sendJson(res, 200, repoJson(requireRepo(owner, name))); return true; }
        if (method === 'PATCH') {
          const repo = requireRepo(owner, name);
          if (typeof body?.description === 'string' || body?.description === null) repo.description = body.description as string | null;
          if (typeof body?.private === 'boolean') repo.isPrivate = body.private;
          if (typeof body?.default_branch === 'string') repo.defaultBranch = body.default_branch;
          if (typeof body?.name === 'string' && body.name !== repo.name) {
            store.repos.delete(`${repo.owner}/${repo.name}`);
            repo.name = body.name;
            store.repos.set(`${repo.owner}/${repo.name}`, repo);
          }
          repo.updatedAt = store.nowIso();
          sendJson(res, 200, repoJson(repo));
          return true;
        }
        if (method === 'DELETE') {
          if (!store.deleteRepo(owner, name)) notFound();
          sendJson(res, 204, undefined);
          return true;
        }
      }
      const repo = requireRepo(owner, name);
      return await handleRepoScoped(ctx, repo, rest);
    }
    return false;
  } catch (err) {
    sendError(res, err);
    return true;
  }
}

async function handleRepoScoped(ctx: Ctx, repo: Repo, rest: string[]): Promise<boolean> {
  const { res, url, body } = ctx;
  const method = ctx.req.method ?? 'GET';
  const fullName = `${repo.owner}/${repo.name}`;

  // ---- branches ----
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, url: `https://api.github.com/repos/${fullName}/commits/${sha}` }, protected: false }));
      sendJson(res, 200, branches);
      return true;
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = decodeURIComponent(rest.slice(1).join('/'));
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) throw new HttpError(404, 'Branch not found');
      sendJson(res, 200, {
        name: branch,
        commit: commitJson(repo, sha),
        protected: false,
        _links: {},
      });
      return true;
    }
  }

  // ---- git refs ----
  if (rest[0] === 'git') {
    if (rest[1] === 'refs' && rest.length === 2) {
      if (method === 'GET') {
        const refs = [...repo.refs.entries()].map(([ref, sha]) => refJson(repo, ref, sha));
        sendJson(res, 200, refs);
        return true;
      }
      if (method === 'POST') {
        const ref = str(body?.ref);
        const sha = str(body?.sha);
        if (!ref || !sha) throw new HttpError(422, 'ref and sha are required');
        if (repo.refs.has(ref)) throw new HttpError(422, 'Reference already exists');
        if (!repo.objects.has(sha)) throw new HttpError(422, 'sha does not exist');
        repo.refs.set(ref, sha);
        repo.updatedAt = store.nowIso();
        sendJson(res, 201, refJson(repo, ref, sha));
        return true;
      }
    }
    if (rest[1] === 'ref' && rest.length >= 3 && method === 'GET') {
      const ref = decodeURIComponent(rest.slice(2).join('/'));
      const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
      const sha = repo.refs.get(full);
      if (!sha) throw new HttpError(404, 'Reference not found');
      sendJson(res, 200, refJson(repo, full, sha));
      return true;
    }
    if (rest[1] === 'refs' && rest.length >= 3 && method === 'DELETE') {
      const ref = decodeURIComponent(rest.slice(2).join('/'));
      if (!repo.refs.delete(ref)) throw new HttpError(422, 'Reference does not exist');
      sendJson(res, 204, undefined);
      return true;
    }
    if (rest[1] === 'commits' && rest.length === 3 && method === 'GET') {
      sendJson(res, 200, commitJson(repo, rest[2]).commit);
      return true;
    }
    if (rest[1] === 'trees' && rest.length === 3 && method === 'GET') {
      const obj = repo.objects.get(rest[2]);
      if (!obj || obj.type !== 'tree') throw new HttpError(404, 'Tree not found');
      const tree = [...store.flattenTree(repo, rest[2]).entries()].map(([path, v]) => ({ path, mode: v.mode, type: 'blob', sha: v.sha }));
      sendJson(res, 200, { sha: rest[2], tree, truncated: false });
      return true;
    }
  }

  // ---- commits ----
  if (rest[0] === 'commits') {
    if (rest.length === 1 && method === 'GET') {
      const shaParam = url.searchParams.get('sha');
      let start: string | undefined;
      if (shaParam) start = repo.refs.get(`refs/heads/${shaParam}`) ?? (repo.objects.has(shaParam) ? shaParam : undefined);
      else start = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      const commits: Record<string, unknown>[] = [];
      if (start) {
        const seen = new Set<string>();
        const walk = (sha: string) => {
          if (seen.has(sha)) return;
          seen.add(sha);
          const obj = repo.objects.get(sha);
          if (!obj || obj.type !== 'commit') return;
          commits.push(commitJson(repo, sha));
          for (const p of parseCommit(obj.data).parents) walk(p);
        };
        walk(start);
      }
      sendJson(res, 200, paginate(res, ctx.req, url, commits));
      return true;
    }
    if (rest.length === 2 && method === 'GET') {
      sendJson(res, 200, commitJson(repo, rest[1]));
      return true;
    }
  }

  // ---- contents ----
  if (rest[0] === 'contents') {
    const path = decodeURIComponent(rest.slice(1).join('/'));
    if (method === 'GET') {
      const refParam = url.searchParams.get('ref') ?? repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${refParam}`);
      if (!tip) {
        if (path === '') { sendJson(res, 200, []); return true; }
        throw new HttpError(404, 'Not Found');
      }
      const treeSha = parseCommit(repo.objects.get(tip)!.data).tree;
      const flat = store.flattenTree(repo, treeSha);
      if (path === '') {
        sendJson(res, 200, dirListing(repo, flat, ''));
        return true;
      }
      const file = flat.get(path);
      if (file) {
        sendJson(res, 200, fileJson(repo, path, file.sha, file.mode));
        return true;
      }
      const prefix = path.endsWith('/') ? path : path + '/';
      if ([...flat.keys()].some((k) => k.startsWith(prefix))) {
        sendJson(res, 200, dirListing(repo, flat, path));
        return true;
      }
      throw new HttpError(404, 'Not Found');
    }
    if (method === 'PUT') {
      const message = str(body?.message);
      const contentB64 = str(body?.content);
      if (message === undefined || contentB64 === undefined) throw new HttpError(422, 'message and content are required');
      const branch = str(body?.branch) ?? repo.defaultBranch;
      const data = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
      const blobSha = store.putObject(repo, 'blob', data);
      const tip = repo.refs.get(`refs/heads/${branch}`);
      const flat = tip ? store.flattenTree(repo, parseCommit(repo.objects.get(tip)!.data).tree) : new Map<string, { mode: string; sha: string }>();
      const existing = flat.get(path);
      const givenSha = str(body?.sha);
      if (existing) {
        if (givenSha === undefined) throw new HttpError(422, 'sha was not supplied');
        if (givenSha !== existing.sha) throw new HttpError(409, 'sha does not match');
      } else if (givenSha !== undefined) {
        throw new HttpError(422, 'sha supplied for a file that does not exist');
      }
      flat.set(path, { mode: existing?.mode ?? '100644', sha: blobSha });
      const commitSha = commitOnBranch(repo, branch, flat, message, tip);
      sendJson(res, existing ? 200 : 201, {
        content: fileJson(repo, path, blobSha, existing?.mode ?? '100644'),
        commit: commitSummary(repo, commitSha),
      });
      return true;
    }
    if (method === 'DELETE') {
      const message = str(body?.message);
      if (message === undefined) throw new HttpError(422, 'message is required');
      const branch = str(body?.branch) ?? repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (!tip) throw new HttpError(404, 'Not Found');
      const flat = store.flattenTree(repo, parseCommit(repo.objects.get(tip)!.data).tree);
      const existing = flat.get(path);
      if (!existing) throw new HttpError(404, 'Not Found');
      const givenSha = str(body?.sha);
      if (givenSha !== undefined && givenSha !== existing.sha) throw new HttpError(409, 'sha does not match');
      flat.delete(path);
      const commitSha = commitOnBranch(repo, branch, flat, message, tip);
      sendJson(res, 200, { content: null, commit: commitSummary(repo, commitSha) });
      return true;
    }
  }

  // ---- labels ----
  if (rest[0] === 'labels') {
    if (rest.length === 1) {
      if (method === 'GET') { sendJson(res, 200, [...repo.labels.values()].map(labelJson)); return true; }
      if (method === 'POST') {
        const name = str(body?.name);
        if (!name) throw new HttpError(422, 'name is required');
        if (repo.labels.has(name)) throw new HttpError(422, 'Label already exists');
        const label = { id: repo.nextLabelId++, name, color: (str(body?.color) ?? 'ededed').replace(/^#/, ''), description: str(body?.description) ?? null };
        repo.labels.set(name, label);
        sendJson(res, 201, labelJson(label));
        return true;
      }
    }
    if (rest.length === 2 && method === 'GET') {
      const label = repo.labels.get(decodeURIComponent(rest[1]));
      if (!label) throw new HttpError(404, 'Label not found');
      sendJson(res, 200, labelJson(label));
      return true;
    }
  }

  // ---- issues + comments ----
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const direction = url.searchParams.get('direction') ?? 'desc';
        let items = [...repo.issues.values()];
        if (state === 'open') items = items.filter((i) => i.state === 'open');
        else if (state === 'closed') items = items.filter((i) => i.state === 'closed');
        items.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        sendJson(res, 200, paginate(res, ctx.req, url, items.map((i) => issueJson(repo, i))));
        return true;
      }
      if (method === 'POST') {
        const title = str(body?.title);
        if (!title) throw new HttpError(422, 'title is required');
        const labels = Array.isArray(body?.labels) ? (body.labels as unknown[]).map((l) => (typeof l === 'string' ? l : (l as { name?: string })?.name ?? '')).filter(Boolean) : [];
        const rec = createIssue(repo, { title, body: str(body?.body) ?? null, labels });
        sendJson(res, 201, issueJson(repo, rec));
        return true;
      }
    }
    const num = parseInt(rest[1] ?? '', 10);
    const rec = Number.isFinite(num) ? repo.issues.get(num) : undefined;
    if (rest.length === 2) {
      if (!rec) throw new HttpError(404, 'Issue not found');
      if (method === 'GET') { sendJson(res, 200, issueJson(repo, rec)); return true; }
      if (method === 'PATCH') {
        if (typeof body?.title === 'string') rec.title = body.title;
        if (typeof body?.body === 'string' || body?.body === null) rec.body = body.body as string | null;
        if (Array.isArray(body?.labels)) {
          const labels = (body.labels as unknown[]).map((l) => (typeof l === 'string' ? l : (l as { name?: string })?.name ?? '')).filter(Boolean);
          for (const name of labels) if (!repo.labels.has(name)) throw new HttpError(422, `label "${name}" does not exist`);
          rec.labels = labels;
        }
        if (body?.state === 'closed' || body?.state === 'open') {
          rec.state = body.state;
          rec.closedAt = body.state === 'closed' ? store.nowIso() : null;
        }
        rec.updatedAt = store.nowIso();
        sendJson(res, 200, issueJson(repo, rec));
        return true;
      }
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (!rec) throw new HttpError(404, 'Issue not found');
      if (method === 'GET') {
        sendJson(res, 200, rec.comments.map((c) => commentJson(repo, rec, c)));
        return true;
      }
      if (method === 'POST') {
        const text = str(body?.body);
        if (!text) throw new HttpError(422, 'body is required');
        const ts = store.nowIso();
        const comment = { id: store.nextCommentId++, body: text, createdAt: ts, updatedAt: ts };
        rec.comments.push(comment);
        rec.updatedAt = ts;
        sendJson(res, 201, commentJson(repo, rec, comment));
        return true;
      }
    }
  }

  // ---- pulls ----
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        let items = [...repo.issues.values()].filter((i) => i.isPull);
        if (state === 'open') items = items.filter((i) => i.state === 'open');
        else if (state === 'closed') items = items.filter((i) => i.state === 'closed');
        items.sort((a, b) => b.number - a.number);
        sendJson(res, 200, paginate(res, ctx.req, url, items.map((i) => pullJson(repo, i))));
        return true;
      }
      if (method === 'POST') {
        const title = str(body?.title);
        const head = str(body?.head);
        const base = str(body?.base);
        if (!title || !head || !base) throw new HttpError(422, 'title, head and base are required');
        const rec = createPull(repo, { title, body: str(body?.body) ?? null, head, base });
        sendJson(res, 201, pullJson(repo, rec));
        return true;
      }
    }
    const num = parseInt(rest[1] ?? '', 10);
    const rec = Number.isFinite(num) ? repo.issues.get(num) : undefined;
    const pull = rec?.isPull ? rec : undefined;
    if (rest.length === 2) {
      if (!pull) throw new HttpError(404, 'Pull Request not found');
      if (method === 'GET') { sendJson(res, 200, pullJson(repo, pull)); return true; }
      if (method === 'PATCH') {
        if (typeof body?.title === 'string') pull.title = body.title;
        if (typeof body?.body === 'string' || body?.body === null) pull.body = body.body as string | null;
        if (body?.state === 'closed' || body?.state === 'open') {
          pull.state = body.state;
          pull.closedAt = body.state === 'closed' ? store.nowIso() : null;
        }
        pull.updatedAt = store.nowIso();
        sendJson(res, 200, pullJson(repo, pull));
        return true;
      }
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      if (!pull) throw new HttpError(404, 'Pull Request not found');
      const files = pullFiles(repo, pull).map((f) => ({
        sha: f.sha ?? '',
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        blob_url: `https://api.github.com/repos/${fullName}/git/blobs/${f.sha ?? ''}`,
        raw_url: `https://github.com/${fullName}/raw/${f.sha ?? ''}/${f.filename}`,
        contents_url: `https://api.github.com/repos/${fullName}/contents/${f.filename}`,
      }));
      sendJson(res, 200, paginate(res, ctx.req, url, files));
      return true;
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (!pull) throw new HttpError(404, 'Pull Request not found');
      if (method === 'GET') {
        if (pull.merged) { sendJson(res, 204, undefined); return true; }
        throw new HttpError(404, 'Not Found');
      }
      if (method === 'PUT') {
        const sha = mergePull(repo, pull, str(body?.merge_method) ?? 'squash', str(body?.commit_title), str(body?.commit_message));
        sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
        return true;
      }
    }
  }

  return false;
}

function refJson(repo: Repo, ref: string, sha: string): Record<string, unknown> {
  const obj = repo.objects.get(sha);
  return {
    ref,
    node_id: `REF:${ref}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/${ref}`,
    object: { type: obj?.type ?? 'commit', sha, url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
  };
}

function commentJson(repo: Repo, rec: { number: number }, c: { id: number; body: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: c.id,
    node_id: `IC:${c.id}`,
    body: c.body,
    user: userJson(),
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${rec.number}#issuecomment-${c.id}`,
    issue_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${rec.number}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/comments/${c.id}`,
  };
}

function fileJson(repo: Repo, path: string, sha: string, mode: string): Record<string, unknown> {
  const obj = repo.objects.get(sha);
  const name = path.split('/').pop() ?? path;
  return {
    name,
    path,
    sha,
    size: obj?.data.length ?? 0,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    git_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/blobs/${sha}`,
    download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.defaultBranch}/${path}`,
    type: 'file',
    content: obj ? obj.data.toString('base64') : '',
    encoding: 'base64',
    _links: {},
    mode,
  };
}

function dirListing(repo: Repo, flat: Map<string, { mode: string; sha: string }>, dir: string): Record<string, unknown>[] {
  const prefix = dir === '' ? '' : dir + '/';
  const entries = new Map<string, { type: string; sha: string; mode: string }>();
  for (const [path, v] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) entries.set(rest, { type: 'file', sha: v.sha, mode: v.mode });
    else {
      const name = rest.slice(0, slash);
      if (!entries.has(name)) entries.set(name, { type: 'dir', sha: '', mode: '40000' });
    }
  }
  return [...entries.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, v]) => {
    const path = prefix + name;
    const out: Record<string, unknown> = {
      name,
      path,
      sha: v.sha,
      size: v.type === 'file' ? repo.objects.get(v.sha)?.data.length ?? 0 : 0,
      type: v.type,
      url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${path}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/${v.type === 'dir' ? 'tree' : 'blob'}/${repo.defaultBranch}/${path}`,
      git_url: '',
      download_url: null,
      _links: {},
    };
    if (v.type === 'dir') {
      // Directory sha: compute the subtree sha for realism.
      out.sha = subtreeSha(repo, flat, path);
      out.git_url = `https://api.github.com/repos/${repo.owner}/${repo.name}/git/trees/${out.sha}`;
    }
    return out;
  });
}

function subtreeSha(repo: Repo, flat: Map<string, { mode: string; sha: string }>, dir: string): string {
  const sub = new Map<string, { mode: string; sha: string }>();
  const prefix = dir + '/';
  for (const [path, v] of flat) {
    if (path.startsWith(prefix)) sub.set(path.slice(prefix.length), v);
  }
  return store.buildTreeFromFlat(repo, sub);
}

function commitOnBranch(repo: Repo, branch: string, flat: Map<string, { mode: string; sha: string }>, message: string, parent: string | undefined): string {
  const tree = store.buildTreeFromFlat(repo, flat);
  const when = store.nowSec();
  const ident = makeIdent(VIEWER.name, VIEWER.email, when);
  const sha = store.putObject(repo, 'commit', buildCommit({
    tree,
    parents: parent ? [parent] : [],
    author: ident,
    committer: ident,
    message: message.endsWith('\n') ? message : message + '\n',
  }));
  repo.refs.set(`refs/heads/${branch}`, sha);
  repo.updatedAt = store.nowIso();
  return sha;
}

function commitSummary(repo: Repo, sha: string): Record<string, unknown> {
  const full = commitJson(repo, sha);
  return { sha, ...((full.commit as Record<string, unknown>) ?? {}), parents: full.parents, url: full.url, html_url: full.html_url };
}
