// Minimal GraphQL executor covering the documents gh / github-mcp-server send:
// viewer, repository, node, __type introspection, issue/pullRequest connections,
// and the createIssue / closeIssue / createPullRequest / mergePullRequest / addComment mutations.

import { store, VIEWER, type Repo, type IssueRec } from './store.ts';
import {
  HttpError, nodeId, createIssue, createPull, mergePull, pullFiles, pullMergeable,
} from './domain.ts';

// ---------------- tokenizer / parser ----------------

type Token = { kind: 'name' | 'string' | 'number' | 'punct' | 'eof'; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (src.startsWith('...', i)) { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('{}()[]:=@$!|&'.includes(c)) { tokens.push({ kind: 'punct', value: c }); i++; continue; }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: src.slice(i + 3, end === -1 ? src.length : end) });
        i = end === -1 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; }
        else { out += src[j]; j++; }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j++;
      tokens.push({ kind: 'number', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j])) j++;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    i++;
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

interface FieldNode {
  name: string;
  alias?: string;
  args: Record<string, unknown>;
  selection?: FieldNode[];
  fragmentType?: string; // for inline fragments: the type condition (name holds '')
}

interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  selection: FieldNode[];
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  private variables: Record<string, unknown>;
  constructor(tokens: Token[], variables: Record<string, unknown>) {
    this.tokens = tokens;
    this.variables = variables;
  }
  private peek(): Token { return this.tokens[this.pos]; }
  private next(): Token { return this.tokens[this.pos++]; }
  private expect(value: string): void {
    const t = this.next();
    if (t.value !== value) throw new Error(`expected "${value}", got "${t.value}"`);
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, { type: string; selection: FieldNode[] }> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, { type: string; selection: FieldNode[] }>();
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
        this.next();
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.peek().value === '(') this.skipParens();
        // directives
        while (this.peek().value === '@') { this.next(); this.next(); if (this.peek().value === '(') this.skipParens(); }
        operations.push({ type: t.value === 'mutation' ? 'mutation' : 'query', name, selection: this.parseSelectionSet() });
      } else if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const fname = this.next().value;
        this.next(); // 'on'
        const type = this.next().value;
        fragments.set(fname, { type, selection: this.parseSelectionSet() });
      } else if (t.value === '{') {
        operations.push({ type: 'query', selection: this.parseSelectionSet() });
      } else {
        this.next();
      }
    }
    return { operations, fragments };
  }

  private skipParens(): void {
    let depth = 0;
    do {
      const t = this.next();
      if (t.value === '(') depth++;
      else if (t.value === ')') depth--;
    } while (depth > 0 && this.peek().kind !== 'eof');
  }

  private parseSelectionSet(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek().value !== '}') {
      if (this.peek().value === '...') {
        this.next();
        const t = this.peek();
        if (t.kind === 'name' && t.value === 'on') {
          this.next();
          const type = this.next().value;
          fields.push({ name: '', fragmentType: type, args: {}, selection: this.parseSelectionSet() });
        } else if (t.kind === 'name') {
          fields.push({ name: `__spread:${this.next().value}`, args: {} });
        }
        continue;
      }
      let nameTok = this.next();
      let alias: string | undefined;
      if (this.peek().value === ':') {
        this.next();
        alias = nameTok.value;
        nameTok = this.next();
      }
      const args: Record<string, unknown> = {};
      if (this.peek().value === '(') {
        this.next();
        while (this.peek().value !== ')') {
          const argName = this.next().value;
          this.expect(':');
          args[argName] = this.parseValue();
        }
        this.next();
      }
      while (this.peek().value === '@') { this.next(); this.next(); if (this.peek().value === '(') this.skipParens(); }
      let selection: FieldNode[] | undefined;
      if (this.peek().value === '{') selection = this.parseSelectionSet();
      fields.push({ name: nameTok.value, alias, args, selection });
    }
    this.next(); // '}'
    return fields;
  }

  private parseValue(): unknown {
    const t = this.next();
    if (t.value === '$') {
      const name = this.next().value;
      return this.variables[name];
    }
    if (t.kind === 'string') return t.value;
    if (t.kind === 'number') return t.value.includes('.') ? parseFloat(t.value) : parseInt(t.value, 10);
    if (t.kind === 'name') {
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      return t.value; // enum
    }
    if (t.value === '[') {
      const arr: unknown[] = [];
      while (this.peek().value !== ']') arr.push(this.parseValue());
      this.next();
      return arr;
    }
    if (t.value === '{') {
      const obj: Record<string, unknown> = {};
      while (this.peek().value !== '}') {
        const key = this.next().value;
        this.expect(':');
        obj[key] = this.parseValue();
      }
      this.next();
      return obj;
    }
    return undefined;
  }
}

// ---------------- schema / introspection ----------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'user', 'organization', 'search', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'reopenIssue', 'updateIssue'],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl', 'createdAt', 'updatedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'primaryLanguage'],
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'repository'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'mergedAt', 'files', 'commits', 'author', 'createdAt', 'updatedAt', 'closedAt', 'repository', 'url', 'additions', 'deletions', 'changedFiles'],
  Ref: ['id', 'name', 'prefix', 'target'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Label: ['id', 'name', 'color', 'description'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
};
const ENUM_TYPES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

// ---------------- execution ----------------

interface GqlError { message: string }
interface Ctx { errors: GqlError[]; fragments: Map<string, { type: string; selection: FieldNode[] }> }

function decodeGlobalId(id: string): { kind: string; num: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const m = /^([A-Za-z]+):(\d+)$/.exec(text);
    if (!m) return null;
    return { kind: m[1], num: parseInt(m[2], 10) };
  } catch {
    return null;
  }
}

function findIssueByGlobalId(id: string): { repo: Repo; rec: IssueRec } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  for (const repo of store.listRepos()) {
    for (const rec of repo.issues.values()) {
      if (rec.id === decoded.num) return { repo, rec };
    }
  }
  return null;
}

function findRepoByGlobalId(id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  return store.listRepos().find((r) => r.id === decoded.num) ?? null;
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}
function indexFromCursor(cursor: string): number {
  try {
    const m = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
    return m ? parseInt(m[1], 10) : 0;
  } catch {
    return 0;
  }
}

function connection<T>(
  items: T[],
  args: Record<string, unknown>,
  ctx: Ctx,
  selection: FieldNode[] | undefined,
  mapNode: (item: T, sel: FieldNode[] | undefined, typeName: string) => unknown,
  typeName: string,
): Record<string, unknown> {
  const first = typeof args.first === 'number' ? args.first : items.length;
  const after = typeof args.after === 'string' ? indexFromCursor(args.after) + 1 : 0;
  const slice = items.slice(after, after + first);
  const out: Record<string, unknown> = {};
  for (const field of selection ?? []) {
    if (field.name === 'nodes') {
      out[field.alias ?? 'nodes'] = slice.map((item) => mapNode(item, field.selection, typeName));
    } else if (field.name === 'edges') {
      out[field.alias ?? 'edges'] = slice.map((item, i) => ({ node: mapNode(item, undefined, typeName), cursor: cursorFor(after + i) }));
    } else if (field.name === 'pageInfo') {
      out[field.alias ?? 'pageInfo'] = {
        hasNextPage: after + slice.length < items.length,
        hasPreviousPage: after > 0,
        startCursor: slice.length ? cursorFor(after) : null,
        endCursor: slice.length ? cursorFor(after + slice.length - 1) : null,
      };
    } else if (field.name === 'totalCount') {
      out[field.alias ?? 'totalCount'] = items.length;
    }
  }
  return out;
}

function resolveSelection(
  typeName: string,
  source: unknown,
  selection: FieldNode[] | undefined,
  ctx: Ctx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selection ?? []) {
    if (field.fragmentType) {
      if (field.fragmentType === typeName) {
        Object.assign(out, resolveSelection(typeName, source, field.selection, ctx));
      }
      continue;
    }
    if (field.name.startsWith('__spread:')) {
      const frag = ctx.fragments.get(field.name.slice('__spread:'.length));
      if (frag && frag.type === typeName) Object.assign(out, resolveSelection(typeName, source, frag.selection, ctx));
      continue;
    }
    const key = field.alias ?? field.name;
    out[key] = resolveField(typeName, source, field, ctx);
  }
  return out;
}

function unknownField(ctx: Ctx, typeName: string, fieldName: string): null {
  ctx.errors.push({ message: `Field '${fieldName}' doesn't exist on type '${typeName}'` });
  return null;
}

function userObject(selection: FieldNode[] | undefined, ctx: Ctx): Record<string, unknown> {
  const src = { login: VIEWER.login, id: nodeId('User', VIEWER.id), name: VIEWER.name, email: VIEWER.email, url: `https://github.com/${VIEWER.login}`, avatarUrl: '', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
  if (!selection) return src;
  return resolveSelection('User', src, selection, ctx);
}

function issueObject(repo: Repo, rec: IssueRec, selection: FieldNode[] | undefined, ctx: Ctx): Record<string, unknown> {
  const typeName = rec.isPull ? 'PullRequest' : 'Issue';
  const src: Record<string, unknown> = {
    __repo: repo,
    __rec: rec,
    id: nodeId(typeName, rec.id),
    databaseId: rec.id,
    number: rec.number,
    title: rec.title,
    body: rec.body,
    state: rec.isPull && rec.merged ? 'MERGED' : rec.state.toUpperCase(),
    url: `https://github.com/${repo.owner}/${repo.name}/${rec.isPull ? 'pull' : 'issues'}/${rec.number}`,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    closedAt: rec.closedAt,
  };
  if (!selection) return src;
  return resolveSelection(typeName, src, selection, ctx);
}

function repoObject(repo: Repo, selection: FieldNode[] | undefined, ctx: Ctx): Record<string, unknown> {
  const src: Record<string, unknown> = {
    __repo: repo,
    id: nodeId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.isPrivate,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
  };
  if (!selection) return src;
  return resolveSelection('Repository', src, selection, ctx);
}

function resolveField(typeName: string, source: unknown, field: FieldNode, ctx: Ctx): unknown {
  const src = source as Record<string, unknown>;
  const name = field.name;
  if (name === '__typename') return typeName;

  if (typeName === 'Query') {
    switch (name) {
      case 'viewer': return userObject(field.selection, ctx);
      case 'repository': {
        const repo = store.getRepo(String(field.args.owner ?? ''), String(field.args.name ?? ''));
        return repo ? repoObject(repo, field.selection, ctx) : null;
      }
      case 'node': {
        const id = String(field.args.id ?? '');
        const decoded = decodeGlobalId(id);
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          const repo = store.listRepos().find((r) => r.id === decoded.num);
          return repo ? repoObject(repo, field.selection, ctx) : null;
        }
        if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
          const found = findIssueByGlobalId(id);
          return found ? issueObject(found.repo, found.rec, field.selection, ctx) : null;
        }
        if (decoded.kind === 'User') return userObject(field.selection, ctx);
        return null;
      }
      case '__type': {
        const typeNameArg = String(field.args.name ?? '');
        return typeObject(typeNameArg, field.selection, ctx);
      }
      case '__schema': return { types: [], queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
      default: return unknownField(ctx, 'Query', name);
    }
  }

  if (typeName === 'Mutation') {
    const input = (field.args.input ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case 'createIssue': {
          const repo = findRepoByGlobalId(String(input.repositoryId ?? ''));
          if (!repo) throw new Error('repository not found');
          const rec = createIssue(repo, { title: String(input.title ?? ''), body: (input.body as string) ?? null });
          return { issue: issueObject(repo, rec, field.selection?.find((f) => f.name === 'issue')?.selection, ctx) };
        }
        case 'closeIssue': {
          const found = findIssueByGlobalId(String(input.issueId ?? ''));
          if (!found) throw new Error('issue not found');
          found.rec.state = 'closed';
          found.rec.closedAt = store.nowIso();
          found.rec.updatedAt = found.rec.closedAt;
          return { issue: issueObject(found.repo, found.rec, field.selection?.find((f) => f.name === 'issue')?.selection, ctx) };
        }
        case 'createPullRequest': {
          const repo = findRepoByGlobalId(String(input.repositoryId ?? ''));
          if (!repo) throw new Error('repository not found');
          const rec = createPull(repo, {
            title: String(input.title ?? ''),
            body: (input.body as string) ?? null,
            head: String(input.headRefName ?? ''),
            base: String(input.baseRefName ?? ''),
          });
          return { pullRequest: issueObject(repo, rec, field.selection?.find((f) => f.name === 'pullRequest')?.selection, ctx) };
        }
        case 'mergePullRequest': {
          const found = findIssueByGlobalId(String(input.pullRequestId ?? ''));
          if (!found) throw new Error('pull request not found');
          const methodRaw = String(input.mergeMethod ?? 'MERGE').toUpperCase();
          mergePull(found.repo, found.rec, methodRaw === 'SQUASH' ? 'squash' : 'merge');
          return { pullRequest: issueObject(found.repo, found.rec, field.selection?.find((f) => f.name === 'pullRequest')?.selection, ctx) };
        }
        case 'addComment': {
          const found = findIssueByGlobalId(String(input.subjectId ?? ''));
          if (!found) throw new Error('subject not found');
          const ts = store.nowIso();
          const comment = { id: store.nextCommentId++, body: String(input.body ?? ''), createdAt: ts, updatedAt: ts };
          found.rec.comments.push(comment);
          const node = { id: nodeId('IssueComment', comment.id), databaseId: comment.id, body: comment.body, createdAt: ts, updatedAt: ts };
          const payloadSel = field.selection;
          const out: Record<string, unknown> = {};
          for (const f of payloadSel ?? []) {
            if (f.name === 'commentEdge') {
              const edgeOut: Record<string, unknown> = {};
              for (const ef of f.selection ?? []) {
                if (ef.name === 'node') edgeOut[ef.alias ?? 'node'] = resolveSelection('IssueComment', node, ef.selection, ctx);
                else if (ef.name === 'cursor') edgeOut[ef.alias ?? 'cursor'] = cursorFor(0);
              }
              out[f.alias ?? 'commentEdge'] = edgeOut;
            }
          }
          return out;
        }
        default: return unknownField(ctx, 'Mutation', name);
      }
    } catch (err) {
      if (err instanceof HttpError) {
        ctx.errors.push({ message: err.message });
        return null;
      }
      throw err;
    }
  }

  if (typeName === 'Repository') {
    const repo = src.__repo as Repo;
    switch (name) {
      case 'owner': return userObject(field.selection, ctx);
      case 'defaultBranchRef': {
        const sel = field.selection;
        const refObj: Record<string, unknown> = { name: repo.defaultBranch, prefix: 'refs/heads/', id: nodeId('Ref', repo.id) };
        if (!sel) return refObj;
        const out: Record<string, unknown> = {};
        for (const f of sel) out[f.alias ?? f.name] = f.name === 'target' ? { __typename: 'Commit', oid: repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null } : refObj[f.name] ?? null;
        return out;
      }
      case 'issue': {
        const rec = repo.issues.get(Number(field.args.number));
        return rec && !rec.isPull ? issueObject(repo, rec, field.selection, ctx) : null;
      }
      case 'issues': {
        let items = [...repo.issues.values()].filter((i) => !i.isPull);
        const states = field.args.states as string[] | undefined;
        if (states?.length) {
          const wanted = states.map((s) => s.toLowerCase());
          items = items.filter((i) => wanted.includes(i.state));
        }
        const orderBy = field.args.orderBy as { field?: string; direction?: string } | undefined;
        const asc = orderBy?.direction === 'ASC';
        items.sort((a, b) => (asc ? a.number - b.number : b.number - a.number));
        return connection(items, field.args, ctx, field.selection, (rec, sel) => issueObject(repo, rec as IssueRec, sel, ctx), 'Issue');
      }
      case 'pullRequest': {
        const rec = repo.issues.get(Number(field.args.number));
        return rec?.isPull ? issueObject(repo, rec, field.selection, ctx) : null;
      }
      case 'pullRequests': {
        let items = [...repo.issues.values()].filter((i) => i.isPull);
        const states = field.args.states as string[] | undefined;
        if (states?.length) {
          items = items.filter((i) => {
            const st = i.merged ? 'MERGED' : i.state.toUpperCase();
            return states.includes(st);
          });
        }
        items.sort((a, b) => b.number - a.number);
        return connection(items, field.args, ctx, field.selection, (rec, sel) => issueObject(repo, rec as IssueRec, sel, ctx), 'PullRequest');
      }
      default:
        if (name in src) return src[name];
        return unknownField(ctx, 'Repository', name);
    }
  }

  if (typeName === 'Issue' || typeName === 'PullRequest') {
    const repo = src.__repo as Repo;
    const rec = src.__rec as IssueRec;
    switch (name) {
      case 'author': return userObject(field.selection, ctx);
      case 'repository': return repoObject(repo, field.selection, ctx);
      case 'labels': {
        const labels = rec.labels.map((labelName) => {
          const label = repo.labels.get(labelName);
          return { id: nodeId('Label', label?.id ?? 0), name: labelName, color: label?.color ?? 'ededed', description: label?.description ?? null };
        });
        return connection(labels, field.args, ctx, field.selection, (l, sel) => {
          if (!sel) return l;
          const out: Record<string, unknown> = {};
          for (const f of sel) out[f.alias ?? f.name] = (l as Record<string, unknown>)[f.name] ?? null;
          return out;
        }, 'Label');
      }
      case 'comments': {
        const comments = rec.comments.map((c) => ({ id: nodeId('IssueComment', c.id), databaseId: c.id, body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt }));
        return connection(comments, field.args, ctx, field.selection, (c, sel) => {
          if (!sel) return c;
          const out: Record<string, unknown> = {};
          for (const f of sel) {
            if (f.name === 'author') out[f.alias ?? 'author'] = userObject(f.selection, ctx);
            else out[f.alias ?? f.name] = (c as Record<string, unknown>)[f.name] ?? null;
          }
          return out;
        }, 'IssueComment');
      }
      case 'headRefName': return rec.headRef ?? null;
      case 'baseRefName': return rec.baseRef ?? null;
      case 'merged': return rec.merged ?? false;
      case 'mergedAt': return rec.mergedAt ?? null;
      case 'mergeable': return rec.merged ? 'UNKNOWN' : pullMergeable(repo, rec) ? 'MERGEABLE' : 'CONFLICTING';
      case 'files': {
        const files = pullFiles(repo, rec).map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status.toUpperCase() }));
        return connection(files, field.args, ctx, field.selection, (f, sel) => {
          if (!sel) return f;
          const out: Record<string, unknown> = {};
          for (const sf of sel) out[sf.alias ?? sf.name] = (f as Record<string, unknown>)[sf.name] ?? null;
          return out;
        }, 'PullRequestChangedFile');
      }
      case 'additions': return pullFiles(repo, rec).reduce((s, f) => s + f.additions, 0);
      case 'deletions': return pullFiles(repo, rec).reduce((s, f) => s + f.deletions, 0);
      case 'changedFiles': return pullFiles(repo, rec).length;
      default:
        if (name in src) return src[name];
        return unknownField(ctx, typeName, name);
    }
  }

  if (typeName === 'User' || typeName === 'IssueComment' || typeName === 'Label') {
    if (name in src) return src[name];
    return unknownField(ctx, typeName, name);
  }

  if (name in src) return src[name];
  return unknownField(ctx, typeName, name);
}

function typeObject(typeName: string, selection: FieldNode[] | undefined, ctx: Ctx): Record<string, unknown> | null {
  const isEnum = typeName in ENUM_TYPES;
  const isObject = typeName in TYPE_FIELDS;
  if (!isEnum && !isObject) return null;
  const out: Record<string, unknown> = {};
  for (const field of selection ?? []) {
    const key = field.alias ?? field.name;
    if (field.name === 'name') out[key] = typeName;
    else if (field.name === 'kind') out[key] = isEnum ? 'ENUM' : 'OBJECT';
    else if (field.name === 'fields') {
      out[key] = isEnum ? null : (TYPE_FIELDS[typeName] ?? []).map((fname) => {
        const fOut: Record<string, unknown> = {};
        for (const sf of field.selection ?? []) {
          if (sf.name === 'name') fOut[sf.alias ?? 'name'] = fname;
          else if (sf.name === 'description') fOut[sf.alias ?? 'description'] = null;
          else if (sf.name === 'isDeprecated') fOut[sf.alias ?? 'isDeprecated'] = false;
          else if (sf.name === 'deprecationReason') fOut[sf.alias ?? 'deprecationReason'] = null;
        }
        return fOut;
      });
    } else if (field.name === 'enumValues') {
      out[key] = isEnum
        ? (ENUM_TYPES[typeName] ?? []).map((vname) => {
            const vOut: Record<string, unknown> = {};
            for (const sf of field.selection ?? []) {
              if (sf.name === 'name') vOut[sf.alias ?? 'name'] = vname;
              else if (sf.name === 'description') vOut[sf.alias ?? 'description'] = null;
              else if (sf.name === 'isDeprecated') vOut[sf.alias ?? 'isDeprecated'] = false;
            }
            return vOut;
          })
        : null;
    } else if (field.name === 'description') out[key] = null;
    else if (field.name === 'possibleTypes') out[key] = null;
    else if (field.name === 'inputFields') out[key] = null;
    else if (field.name === 'interfaces') out[key] = [];
    else out[key] = null;
  }
  return out;
}

export function executeGraphQL(queryText: string, variables: Record<string, unknown>, operationName?: string): { data?: Record<string, unknown>; errors?: GqlError[] } {
  const parser = new Parser(tokenize(queryText), variables);
  const { operations, fragments } = parser.parseDocument();
  const ctx: Ctx = { errors: [], fragments };
  const data: Record<string, unknown> = {};
  const ops = operationName ? operations.filter((o) => o.name === operationName) : operations;
  for (const op of ops) {
    const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
    Object.assign(data, resolveSelection(rootType, {}, op.selection, ctx));
  }
  const result: { data?: Record<string, unknown>; errors?: GqlError[] } = { data };
  if (ctx.errors.length) result.errors = ctx.errors;
  return result;
}
