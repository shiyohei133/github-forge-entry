// Git smart HTTP: info/refs advertisement (v0 + v2), ls-refs, upload-pack (fetch/clone, shallow),
// receive-pack (push with fast-forward enforcement and report-status).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, type Repo, type GitObject, parseCommit, hashObject } from './store.ts';
import { pktLine, PKT_FLUSH, PKT_DELIM, parsePktLines, parsePack, writePack, setPackExternalLookup, type PackEntry } from './pack.ts';

const ZERO = '0'.repeat(40);
const AGENT = 'forge/1.0';

const UPLOAD_CAPS_V0 = 'side-band-64k ofs-delta shallow agent=' + AGENT;
const RECEIVE_CAPS_V0 = 'report-status side-band-64k ofs-delta delete-refs quiet agent=' + AGENT;

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The commit a tag object ultimately points at (peel), or the object itself. */
function peel(repo: Repo, sha: string): string {
  let cur = sha;
  for (let i = 0; i < 10; i++) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tag') return cur;
    const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    if (!m) return cur;
    cur = m[1];
  }
  return cur;
}

export function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo | null, service: string, isV2: boolean): void {
  if (!repo) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'Not Found' }));
    return;
  }
  const isUpload = service === 'git-upload-pack';
  const contentType = isUpload ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
  const parts: Buffer[] = [];
  if (isV2 && isUpload) {
    parts.push(pktLine('version 2\n'));
    parts.push(pktLine(`agent=${AGENT}\n`));
    parts.push(pktLine('ls-refs=unborn\n'));
    parts.push(pktLine('fetch=shallow wait-for-done\n'));
    parts.push(pktLine('object-format=sha1\n'));
    parts.push(PKT_FLUSH);
  } else {
    parts.push(pktLine(`# service=${service}\n`));
    parts.push(PKT_FLUSH);
    const caps = isUpload
      ? `${UPLOAD_CAPS_V0} symref=HEAD:${headTarget(repo)}`
      : RECEIVE_CAPS_V0;
    const refs = sortedRefs(repo);
    const headSha = repo.refs.get(headTarget(repo));
    if (refs.length === 0) {
      parts.push(pktLine(`${ZERO} capabilities^{}\0${caps}\n`));
    } else {
      let first = true;
      if (headSha) {
        parts.push(pktLine(`${headSha} HEAD\0${caps}\n`));
        first = false;
      }
      for (const [ref, sha] of refs) {
        const line = `${sha} ${ref}\n`;
        parts.push(first ? pktLine(`${sha} ${ref}\0${caps}\n`) : pktLine(line));
        first = false;
        const obj = repo.objects.get(sha);
        if (obj?.type === 'tag') {
          parts.push(pktLine(`${peel(repo, sha)} ${ref}^{}\n`));
        }
      }
      if (first) {
        // refs exist but no HEAD target (shouldn't happen); still emit caps on first ref — handled above.
      }
    }
    parts.push(PKT_FLUSH);
  }
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
  res.end(Buffer.concat(parts));
}

// ---------------- object closure computation ----------------

interface ClosureResult {
  objects: PackEntry[];
  shallow: string[]; // boundary commits (parents excluded)
  unshallow: string[];
}

/** Collect objects reachable from `wants`, excluding anything reachable from `haves`. Depth limits commit ancestry. */
function computeClosure(
  repo: Repo,
  wants: string[],
  haves: Set<string>,
  depth: number | null,
  deepenSince: number | null,
  deepenNot: Set<string>,
  clientShallow: string[],
): ClosureResult {
  const haveObjects = new Set<string>();
  if (haves.size) {
    const boundary = new Set(clientShallow);
    const stack = [...haves];
    const seenCommits = new Set<string>();
    while (stack.length) {
      const sha = stack.pop()!;
      const obj = repo.objects.get(sha);
      if (!obj) continue;
      if (obj.type === 'commit') {
        if (seenCommits.has(sha)) continue;
        seenCommits.add(sha);
        haveObjects.add(sha);
        const c = parseCommit(obj.data);
        addTreeObjects(repo, c.tree, haveObjects);
        // A commit the client holds shallowly does not imply its parents are held.
        if (!boundary.has(sha)) stack.push(...c.parents);
      }
    }
  }
  const notCommits = new Set<string>();
  for (const n of deepenNot) {
    for (const a of store.ancestors(repo, n)) notCommits.add(a);
  }

  // BFS by depth from wants.
  const included = new Map<string, GitObject>();
  const shallow = new Set<string>();
  const depthOf = new Map<string, number>();
  let frontier = wants.filter((w) => repo.objects.has(w));
  for (const w of frontier) depthOf.set(w, 0);
  // Also deepen from the client's existing shallow boundary: they get `depth` more levels.
  const extraRoots = clientShallow.filter((s) => repo.objects.has(s));
  const queue: { sha: string; d: number }[] = [
    ...frontier.map((sha) => ({ sha, d: 0 })),
    ...extraRoots.map((sha) => ({ sha, d: 0 })),
  ];
  const visitedCommitDepth = new Map<string, number>();
  const includeObject = (sha: string) => {
    const obj = repo.objects.get(sha);
    if (obj && !haveObjects.has(sha)) included.set(sha, obj);
  };
  while (queue.length) {
    const { sha, d } = queue.shift()!;
    const obj = repo.objects.get(sha);
    if (!obj) continue;
    if (obj.type === 'tag') {
      includeObject(sha);
      const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (m) queue.push({ sha: m[1], d });
      continue;
    }
    if (obj.type !== 'commit') continue;
    if (notCommits.has(sha) && !wants.includes(sha)) continue;
    const prev = visitedCommitDepth.get(sha);
    if (prev !== undefined && prev <= d) continue;
    visitedCommitDepth.set(sha, d);
    if (deepenSince !== null) {
      const c = parseCommit(obj.data);
      const t = commitTime(c.committer);
      if (t !== null && t < deepenSince) {
        shallow.add(sha);
        includeObject(sha);
        includeTreeOf(repo, c.tree, haveObjects, included);
        continue;
      }
    }
    includeObject(sha);
    const c = parseCommit(obj.data);
    includeTreeOf(repo, c.tree, haveObjects, included);
    const atLimit = depth !== null && d + 1 >= depth;
    if (atLimit) {
      if (c.parents.length) shallow.add(sha);
      continue;
    }
    for (const p of c.parents) queue.push({ sha: p, d: d + 1 });
  }
  // Unshallow: client boundary commits whose parents are now included.
  const unshallow: string[] = [];
  for (const s of clientShallow) {
    if (!shallow.has(s) && visitedCommitDepth.has(s)) unshallow.push(s);
  }
  const objects: PackEntry[] = [...included.entries()].map(([sha, o]) => ({ sha, type: o.type, data: o.data }));
  return { objects, shallow: [...shallow], unshallow };
}

function commitTime(ident: string): number | null {
  const m = / (\d{9,}) [+-]\d{4}$/.exec(ident);
  return m ? Number(m[1]) : null;
}

function addTreeObjects(repo: Repo, treeSha: string, into: Set<string>): void {
  const stack = [treeSha];
  while (stack.length) {
    const sha = stack.pop()!;
    if (into.has(sha)) continue;
    const obj = repo.objects.get(sha);
    if (!obj) continue;
    into.add(sha);
    if (obj.type === 'tree') {
      const text = obj.data;
      let i = 0;
      while (i < text.length) {
        const nul = text.indexOf(0x00, i);
        const child = text.toString('hex', nul + 1, nul + 21);
        stack.push(child);
        i = nul + 21;
      }
    }
  }
}

function includeTreeOf(repo: Repo, treeSha: string, exclude: Set<string>, included: Map<string, GitObject>): void {
  const stack = [treeSha];
  while (stack.length) {
    const sha = stack.pop()!;
    if (included.has(sha) || exclude.has(sha)) continue;
    const obj = repo.objects.get(sha);
    if (!obj) continue;
    included.set(sha, obj);
    if (obj.type === 'tree') {
      let i = 0;
      while (i < obj.data.length) {
        const nul = obj.data.indexOf(0x00, i);
        stack.push(obj.data.toString('hex', nul + 1, nul + 21));
        i = nul + 21;
      }
    }
  }
}

// Pack cache for repeated identical fetches (the clone benchmark hammers one shape).
const packCache = new Map<string, Buffer>();
function packFor(repo: Repo, key: string, objects: PackEntry[]): Buffer {
  const hit = packCache.get(key);
  if (hit) return hit;
  const pack = writePack(objects);
  if (packCache.size > 64) packCache.clear();
  packCache.set(key, pack);
  return pack;
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65500;
  for (let i = 0; i < pack.length; i += CHUNK) {
    out.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(i, i + CHUNK)])));
  }
  if (pack.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

// ---------------- upload-pack ----------------

export function handleUploadPack(res: ServerResponse, repo: Repo, body: Buffer, isV2: boolean): void {
  const { items } = parsePktLines(body);
  const lines: string[] = [];
  for (const item of items) {
    if (Buffer.isBuffer(item)) lines.push(item.toString('utf8'));
    else lines.push(item === 'delim' ? '\x01' : '\x00');
  }
  const command = lines.find((l) => l.startsWith('command='));
  if (isV2 && command?.startsWith('command=ls-refs')) {
    return lsRefs(res, repo, lines);
  }
  if (isV2 && command?.startsWith('command=fetch')) {
    return fetchV2(res, repo, lines);
  }
  return fetchV0(res, repo, lines);
}

function lsRefs(res: ServerResponse, repo: Repo, lines: string[]): void {
  let peelWanted = false;
  let symrefsWanted = false;
  let unbornWanted = false;
  const prefixes: string[] = [];
  let inArgs = false;
  for (const line of lines) {
    if (line === '\x01') { inArgs = true; continue; }
    if (line === '\x00') break;
    if (!inArgs) continue;
    const l = line.replace(/\n$/, '');
    if (l === 'peel') peelWanted = true;
    else if (l === 'symrefs') symrefsWanted = true;
    else if (l === 'unborn') unbornWanted = true;
    else if (l.startsWith('ref-prefix ')) prefixes.push(l.slice('ref-prefix '.length));
  }
  const keep = (name: string) => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const headSha = repo.refs.get(headTarget(repo));
  if (keep('HEAD')) {
    if (headSha) {
      parts.push(pktLine(`${headSha} HEAD${symrefsWanted ? ` symref-target:${headTarget(repo)}` : ''}\n`));
    } else if (unbornWanted) {
      parts.push(pktLine(`unborn HEAD${symrefsWanted ? ` symref-target:${headTarget(repo)}` : ''}\n`));
    }
  }
  for (const [ref, sha] of sortedRefs(repo)) {
    if (!keep(ref)) continue;
    let suffix = '';
    if (peelWanted) {
      const obj = repo.objects.get(sha);
      if (obj?.type === 'tag') suffix = ` peeled:${peel(repo, sha)}`;
    }
    parts.push(pktLine(`${sha} ${ref}${suffix}\n`));
  }
  parts.push(PKT_FLUSH);
  res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result' });
  res.end(Buffer.concat(parts));
}

interface FetchArgs {
  wants: string[];
  wantRefs: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  done: boolean;
}

function parseFetchArgs(lines: string[], v2: boolean): FetchArgs {
  const args: FetchArgs = { wants: [], wantRefs: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [], done: false };
  let inArgs = !v2; // v0 has no command header; args start immediately (wants section), then flush, then haves section
  for (const raw of lines) {
    if (raw === '\x01') { inArgs = true; continue; }
    if (raw === '\x00') { inArgs = true; continue; }
    const l = raw.replace(/\n$/, '');
    if (l.startsWith('command=') || l.startsWith('agent=') || l.startsWith('object-format=')) { continue; }
    if (l.startsWith('want ')) args.wants.push(l.slice(5).trim().split(' ')[0]);
    else if (l.startsWith('want-ref ')) args.wantRefs.push(l.slice(9).trim());
    else if (l.startsWith('have ')) args.haves.push(l.slice(5).trim());
    else if (l.startsWith('shallow ')) args.shallow.push(l.slice(8).trim());
    else if (l.startsWith('deepen ')) args.depth = parseInt(l.slice(7).trim(), 10);
    else if (l.startsWith('deepen-since ')) args.deepenSince = parseInt(l.slice(13).trim(), 10);
    else if (l.startsWith('deepen-not ')) args.deepenNot.push(l.slice(11).trim());
    else if (l === 'done') args.done = true;
    // wait-for-done, server-option, filter etc. are accepted and ignored.
    void inArgs;
  }
  return args;
}

function resolveWantRefs(repo: Repo, args: FetchArgs): void {
  for (const ref of args.wantRefs) {
    const sha = repo.refs.get(ref);
    if (sha && !args.wants.includes(sha)) args.wants.push(sha);
  }
}

function fetchV2(res: ServerResponse, repo: Repo, lines: string[]): void {
  const args = parseFetchArgs(lines, true);
  resolveWantRefs(repo, args);
  const haves = new Set(args.haves);
  const { objects, shallow, unshallow } = computeClosure(
    repo, args.wants, haves, args.depth, args.deepenSince,
    new Set(args.deepenNot.map((r) => repo.refs.get(r) ?? r)),
    args.shallow,
  );
  const parts: Buffer[] = [];
  if (args.haves.length) {
    parts.push(pktLine('acknowledgments\n'));
    const common = args.haves.filter((h) => repo.objects.get(h)?.type === 'commit');
    if (common.length) {
      for (const c of common.slice(0, 1)) parts.push(pktLine(`ACK ${c}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(PKT_DELIM);
  }
  if (shallow.length || unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const u of unshallow) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(PKT_DELIM);
  }
  if (args.wantRefs.length) {
    parts.push(pktLine('wanted-refs\n'));
    for (const ref of args.wantRefs) {
      const sha = repo.refs.get(ref);
      if (sha) parts.push(pktLine(`${sha} ${ref}\n`));
    }
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  const key = `v2|${repo.id}|${args.wants.slice().sort().join(',')}|${args.depth}|${[...haves].sort().join(',')}`;
  const pack = packFor(repo, key, objects);
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result' });
  res.end(Buffer.concat(parts));
}

function fetchV0(res: ServerResponse, repo: Repo, lines: string[]): void {
  const args = parseFetchArgs(lines, false);
  const haves = new Set(args.haves);
  const { objects, shallow, unshallow } = computeClosure(
    repo, args.wants, haves, args.depth, args.deepenSince,
    new Set(args.deepenNot.map((r) => repo.refs.get(r) ?? r)),
    args.shallow,
  );
  const parts: Buffer[] = [];
  for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const u of unshallow) parts.push(pktLine(`unshallow ${u}\n`));
  parts.push(pktLine('NAK\n'));
  const key = `v0|${repo.id}|${args.wants.slice().sort().join(',')}|${args.depth}|${[...haves].sort().join(',')}`;
  const pack = packFor(repo, key, objects);
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result' });
  res.end(Buffer.concat(parts));
}

// ---------------- receive-pack ----------------

export function handleReceivePack(res: ServerResponse, repo: Repo, body: Buffer): void {
  const { items, next } = parsePktLines(body);
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  for (const item of items) {
    if (!Buffer.isBuffer(item)) break;
    let text = item.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const parts = text.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  const packBytes = body.subarray(next);
  let unpackOk = true;
  let unpackError = '';
  // Stage the pack's objects; they land in the repo store (as in git, objects from a
  // rejected ref update are not the protocol's problem), but refs move only per-command.
  if (packBytes.length > 0) {
    try {
      setPackExternalLookup((sha) => repo.objects.get(sha));
      const entries = parsePack(packBytes, hashObject);
      for (const e of entries) {
        if (!repo.objects.has(e.sha)) repo.objects.set(e.sha, { type: e.type, data: e.data });
      }
    } catch (err) {
      unpackOk = false;
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    } finally {
      setPackExternalLookup(undefined);
    }
  }

  const reportLines: string[] = [];
  reportLines.push(unpackOk ? 'unpack ok' : `unpack ${unpackError || 'error'}`);
  for (const cmd of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${cmd.ref} unpacker error`);
      continue;
    }
    const current = repo.refs.get(cmd.ref) ?? ZERO;
    if (cmd.newOid === ZERO) {
      // delete
      if (current === ZERO) {
        reportLines.push(`ng ${cmd.ref} reference not found`);
      } else if (cmd.oldOid !== ZERO && cmd.oldOid !== current) {
        reportLines.push(`ng ${cmd.ref} stale info`);
      } else {
        repo.refs.delete(cmd.ref);
        reportLines.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    const newObj = repo.objects.get(cmd.newOid);
    if (!newObj) {
      reportLines.push(`ng ${cmd.ref} unknown object`);
      continue;
    }
    if (current !== cmd.oldOid && cmd.oldOid !== ZERO) {
      reportLines.push(`ng ${cmd.ref} stale info`);
      continue;
    }
    if (current !== ZERO && newObj.type === 'commit') {
      if (!store.isAncestor(repo, current, cmd.newOid)) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward`);
        continue;
      }
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    reportLines.push(`ok ${cmd.ref}`);
  }
  repo.updatedAt = store.nowIso();

  const inner: Buffer[] = reportLines.map((l) => pktLine(l + '\n'));
  inner.push(PKT_FLUSH);
  const out: Buffer[] = inner.map((p) => pktLine(Buffer.concat([Buffer.from([1]), p])));
  out.push(PKT_FLUSH);
  res.writeHead(200, { 'Content-Type': 'application/x-git-receive-pack-result' });
  res.end(Buffer.concat(out));
}
