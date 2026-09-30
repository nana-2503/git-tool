/**
 * @local/dsh-github-push — Host half.
 *
 * Owns everything that needs a process: GitHub authentication, the per-workspace
 * repository bindings, `git push` execution, and the browser RPC route the Client
 * half calls. Deliberately import-free apart from `node:` builtins, so the bundle
 * resolves from any profile without profile-installed dependencies.
 *
 * Model-facing surface: the `github_push` tool.
 * Browser surface: `POST /api/github-push.rpc` inside Connection's auth fence.
 *
 * @module @local/dsh-github-push
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Loader entry name; also the Client module id. */
export const name = 'github-push';

/** Hard dependencies: tool registry, RPC carrier, secret store, workspace registry. */
export const inject = ['tools', 'connection', 'credentials', 'workspaceRegistry', 'commands'];

/** Exact Fetch route the Client half posts to (inside Connection's `/api` fence). */
const ROUTE_PATH = '/api/github-push.rpc';

/** Credential references consulted, in precedence order, before falling back to `gh`. */
const TOKEN_REFS = ['GITHUB_PUSH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];

/** Credential reference this plugin writes to. */
const TOKEN_WRITE_REF = 'GITHUB_PUSH_TOKEN';

/** Dedicated remote this plugin may configure inside a bound workspace. */
const BINDING_REMOTE = 'dsh-binding';

/** OAuth scopes requested by the device flow. */
const DEVICE_SCOPE = 'repo read:user';

/** Rolling activity window size. */
const ACTIVITY_LIMIT = 40;

/** Owner/repo segment validation (GitHub's own allowed set, minus path tricks). */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Matches a `git push` invocation inside a shell command line. */
const GIT_PUSH = /\bgit\b[^\n;&|]*\s+push\b/;

const DEFAULTS = {
  clientId: '',
  apiBase: 'https://api.github.com',
  gitBase: 'https://github.com',
  autoPushDefault: true,
  autoCommitDefault: true,
  gitTimeoutMs: 180_000,
};

/* ------------------------------------------------------------------ */
/* small utilities                                                     */
/* ------------------------------------------------------------------ */

/** Normalize a path-ish string for stable binding keys. */
function normalizePath(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed.length === 0 ? '/' : trimmed;
}

/** True when `child` is `parent` itself or sits underneath it. */
function isWithin(parent, child) {
  if (parent === '' || child === '') return false;
  if (parent === child) return true;
  return child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
}

/** Redact anything token-shaped from text that may reach a log or a UI. */
function redact(text) {
  return String(text ?? '')
    .replace(/x-access-token:[^@/\s]+/g, 'x-access-token:***')
    .replace(/(gh[pousr]_[A-Za-z0-9]{8})[A-Za-z0-9]+/g, '$1***')
    .replace(/github_pat_[A-Za-z0-9_]{8}[A-Za-z0-9_]+/g, 'github_pat_***');
}

/** Promise-returning `execFile` with a fixed shape. */
function run(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      resolve({
        ok: error === null,
        code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        error,
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* Host half                                                           */
/* ------------------------------------------------------------------ */

/**
 * Mount the GitHub Push plugin.
 * @param ctx - registrant context (tools, connection, credentials, workspaceRegistry).
 * @param rawConfig - the Loader row's `config`, read defensively (no Config schema).
 */
export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}) };
  const log = (message, ...rest) => ctx.logger?.info?.(`[github-push] ${redact(message)}`, ...rest);

  /** Turn a raw git failure into something a user can act on. */
  function pushHint(text, binding) {
    const full = String(text ?? '');
    const lines = full.split('\n').map((line) => line.trim()).filter((line) => line !== '');
    // git puts its own `hint:` block after the line that says what went wrong.
    const keyLine =
      lines.find((line) => /\[rejected\]|non-fast-forward|fetch first|error:|fatal:|! \[remote rejected\]/i.test(line)) ??
      lines.slice(-3).join('\n');
    const branch = binding.branch || 'the current branch';
    const because = (hint) => (keyLine === '' ? hint : `${keyLine}\n${hint}`);
    if (/non-fast-forward|fetch first|\[rejected\]|Updates were rejected/i.test(full)) {
      return because(
        `${binding.owner}/${binding.repo}#${branch} already has commits this workspace does not. Push to a different branch, or reconcile the histories.`,
      );
    }
    if (/src refspec|does not match any/i.test(full)) {
      return because('the workspace has no commits yet: make one, or turn on "commit local changes before pushing".');
    }
    if (/Authentication failed|could not read Username|Permission denied|403/i.test(full)) {
      return because(
        `GitHub rejected the credential: check the token's repo scope and write access to ${binding.owner}/${binding.repo}.`,
      );
    }
    return keyLine;
  }

  /* ---------------- durable state ---------------- */

  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  const statePath = join(home, 'github-push.json');

  /** @type {{version: number, bindings: Record<string, object>, activity: object[]}} */
  let state = { version: 1, bindings: {}, activity: [] };
  let loaded = false;
  let flushTimer;

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      if (!existsSync(statePath)) return;
      const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        state = {
          version: 1,
          bindings: parsed.bindings && typeof parsed.bindings === 'object' ? parsed.bindings : {},
          activity: Array.isArray(parsed.activity) ? parsed.activity : [],
        };
      }
    } catch (error) {
      ctx.logger?.warn?.(`[github-push] unreadable state at ${statePath}: ${redact(error?.message ?? error)}`);
    }
  }

  function flushNow() {
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      const body = JSON.stringify(state, null, 2);
      const temp = `${statePath}.${process.pid}.tmp`;
      writeFileSync(temp, body, { mode: 0o600 });
      renameSync(temp, statePath);
    } catch (error) {
      ctx.logger?.warn?.(`[github-push] could not persist state: ${redact(error?.message ?? error)}`);
    }
  }

  function touch() {
    if (flushTimer !== undefined) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      flushNow();
    }, 60);
    flushTimer.unref?.();
  }

  function record(entry) {
    load();
    state.activity.unshift({ at: new Date().toISOString(), ...entry });
    if (state.activity.length > ACTIVITY_LIMIT) state.activity.length = ACTIVITY_LIMIT;
    touch();
  }

  ctx.effect(() => () => {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    flushNow();
  }, 'github-push: flush state');

  /* ---------------- credentials ---------------- */

  async function tokenStatuses() {
    const out = [];
    for (const ref of TOKEN_REFS) {
      try {
        const info = await ctx.credentials.describe(ref);
        out.push({ ref, configured: info.configured === true, source: info.source, writable: info.writable !== false });
      } catch {
        out.push({ ref, configured: false, writable: false });
      }
    }
    return out;
  }

  async function resolveToken() {
    for (const ref of TOKEN_REFS) {
      try {
        const resolved = await ctx.credentials.resolve(ref);
        if (resolved?.value) return { token: resolved.value, source: ref };
      } catch {
        /* an unreadable source is treated as unconfigured */
      }
    }
    const viaCli = await run('gh', ['auth', 'token'], { timeout: 10_000 });
    if (viaCli.ok && viaCli.stdout.trim().length > 0) {
      return { token: viaCli.stdout.trim(), source: 'gh CLI' };
    }
    return undefined;
  }

  async function requireToken() {
    const found = await resolveToken();
    if (found === undefined) {
      throw new Error(
        'No GitHub token. Sign in from the GitHub Push panel (the sidebar row above Settings), or export GITHUB_PUSH_TOKEN, or run `gh auth login`.',
      );
    }
    return found;
  }

  /* ---------------- GitHub REST ---------------- */

  async function api(path, options = {}) {
    const { method = 'GET', token, body, raw = false } = options;
    const headers = {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-github-push',
      'x-github-api-version': '2022-11-28',
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response;
    try {
      response = await fetch(`${String(config.apiBase).replace(/\/+$/, '')}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(25_000),
      });
    } catch (error) {
      throw new Error(`GitHub unreachable: ${redact(error?.message ?? error)}`);
    }
    const text = await response.text();
    let parsed;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!response.ok) {
      const detail = parsed && typeof parsed === 'object' && typeof parsed.message === 'string' ? `: ${parsed.message}` : '';
      throw new Error(`GitHub ${method} ${path} → ${response.status}${detail}`);
    }
    return raw ? { parsed, response } : parsed;
  }

  /** The signed-in account, or `undefined` when the token is unusable. */
  async function accountOf(token) {
    try {
      const user = await api('/user', { token });
      return { login: user.login, name: user.name ?? null, avatarUrl: user.avatar_url ?? null };
    } catch (error) {
      return { error: redact(error?.message ?? error) };
    }
  }

  /* ---------------- workspaces & bindings ---------------- */

  function listWorkspaces() {
    let rows = [];
    try {
      rows = ctx.workspaceRegistry.list() ?? [];
    } catch (error) {
      ctx.logger?.warn?.(`[github-push] workspaceRegistry.list() failed: ${redact(error?.message ?? error)}`);
    }
    return rows.map((workspace) => ({
      id: String(workspace.id),
      path: normalizePath(workspace.path),
      title: String(workspace.title ?? workspace.path ?? ''),
      sessionIds: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.map(String) : [],
    }));
  }

  /** Longest-prefix workspace match for a session's cwd. */
  function workspaceForCwd(cwd) {
    const target = normalizePath(cwd);
    if (target === '') return undefined;
    let best;
    for (const workspace of listWorkspaces()) {
      if (!isWithin(workspace.path, target)) continue;
      if (best === undefined || workspace.path.length > best.path.length) best = workspace;
    }
    return best;
  }

  function bindingFor(workspacePath) {
    load();
    return state.bindings[normalizePath(workspacePath)];
  }

  function bindingForCwd(cwd) {
    const workspace = workspaceForCwd(cwd);
    if (workspace === undefined) return undefined;
    const binding = bindingFor(workspace.path);
    return binding === undefined ? undefined : { ...binding, workspace };
  }

  /** The live working directory of a session, when its Agent is still resident. */
  function cwdOfSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined;
    try {
      return ctx.get('agents')?.get?.(sessionId)?.session?.header?.cwd;
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve the workspace a request speaks about: an explicit path, else the
   * calling session's cwd, canonicalized to the owning workspace when known.
   */
  function workspacePathFrom(input) {
    const explicit = normalizePath(input?.workspace ?? input?.workspacePath);
    if (explicit !== '') return explicit;
    const cwd = normalizePath(cwdOfSession(input?.sessionId));
    if (cwd === '') return '';
    return workspaceForCwd(cwd)?.path ?? cwd;
  }

  function validateSegments(owner, repo) {
    if (!SEGMENT.test(owner) || SEGMENT.test(repo) === false) {
      throw new Error('owner and repo must be plain GitHub names (letters, digits, ".", "_", "-").');
    }
  }

  /** HTTPS remote a binding pushes to; `gitBase` moves it for GitHub Enterprise. */
  function remoteUrl(owner, repo) {
    const base = String(config.gitBase ?? DEFAULTS.gitBase).replace(/\/+$/, '') || DEFAULTS.gitBase;
    return `${base}/${owner}/${repo}.git`;
  }

  /* ---------------- git ---------------- */

  /** Environment that authenticates a single git invocation without argv exposure. */
  function gitEnv(token) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_ASKPASS: 'echo' };
    if (token) {
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
      env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')}`;
    }
    return env;
  }

  async function git(cwd, args, token) {
    const result = await run('git', ['-C', cwd, ...args], {
      timeout: Number(config.gitTimeoutMs) || DEFAULTS.gitTimeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: gitEnv(token),
    });
    return {
      ok: result.ok,
      code: result.code,
      stdout: result.stdout.trim(),
      stderr: redact(result.stderr.trim()),
      message: redact(result.error?.message ?? ''),
    };
  }

  async function gitOrThrow(cwd, args, token) {
    const result = await git(cwd, args, token);
    if (!result.ok) {
      const detail = result.stderr || result.message || `git ${args.join(' ')} failed`;
      throw new Error(detail.split('\n').slice(-4).join('\n'));
    }
    return result.stdout;
  }

  async function gitIdentity(cwd) {
    const name = await git(cwd, ['config', '--get', 'user.name']);
    const email = await git(cwd, ['config', '--get', 'user.email']);
    const args = [];
    if (name.stdout === '') args.push('-c', 'user.name=dsh-github-push');
    if (email.stdout === '') args.push('-c', 'user.email=dsh-github-push@localhost');
    return args;
  }

  /* ---------------- the commit operation ---------------- */

  /** In-flight commits keyed by workspace path. */
  const committing = new Map();

  /**
   * Commit local changes in the bound workspace, without pushing.
   * @param binding - stored binding record.
   * @param options - trigger label and custom message.
   * @returns the operation outcome.
   */
  async function commitBinding(binding, options = {}) {
    const trigger = options.trigger ?? 'manual';
    const cwd = binding.workspacePath;
    if (committing.has(cwd)) {
      const previous = committing.get(cwd);
      return { ok: false, summary: `A commit for ${cwd} is already running (${previous}).` };
    }
    const runId = `${trigger} ${new Date().toISOString()}`;
    committing.set(cwd, runId);

    try {
      if (!existsSync(cwd)) throw new Error(`workspace directory is gone: ${cwd}`);

      const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
      if (!inside.ok || inside.stdout !== 'true') {
        throw new Error(`${cwd} is not a git repository. Run \`git init\` there first.`);
      }

      const status = await gitOrThrow(cwd, ['status', '--porcelain'], undefined);
      if (status.length === 0) {
        return { ok: true, summary: 'Nothing to commit.', skipped: true };
      }

      const identity = await gitIdentity(cwd);
      await gitOrThrow(cwd, ['add', '-A'], undefined);
      const message =
        typeof options.message === 'string' && options.message.trim().length > 0
          ? options.message.trim()
          : `chore(dsh): commit workspace at ${new Date().toISOString()}`;
      await gitOrThrow(cwd, [...identity, 'commit', '-m', message], undefined);
      const head = await gitOrThrow(cwd, ['rev-parse', '--short', 'HEAD'], undefined);
      const summary = `Committed ${head} in ${cwd} (${trigger}).`;

      record({ workspacePath: cwd, repo: `${binding.owner}/${binding.repo}`, branch: binding.branch, ok: true, trigger, message: summary });
      log(summary);
      return { ok: true, summary, commit: head };
    } catch (error) {
      const message = redact(error?.message ?? error);
      record({ workspacePath: cwd, repo: `${binding.owner}/${binding.repo}`, branch: binding.branch, ok: false, trigger, message });
      log(`commit failed: ${message}`);
      return { ok: false, summary: message };
    } finally {
      committing.delete(cwd);
    }
  }

  /* ---------------- the push operation ---------------- */

  /** In-flight pushes keyed by workspace path, so a mirror never stacks up. */
  const pushing = new Map();

  /**
   * Commit (optionally), configure the remote (optionally), and push HEAD to the
   * binding's branch. One implementation for the UI, the agent tool, and the
   * automatic mirror.
   * @param binding - stored binding record.
   * @param options - trigger label and overrides.
   * @returns the operation outcome.
   */
  async function pushBinding(binding, options = {}) {
    const trigger = options.trigger ?? 'manual';
    const cwd = binding.workspacePath;
    if (pushing.has(cwd)) {
      const previous = pushing.get(cwd);
      return { ok: false, summary: `A push for ${cwd} is already running (${previous}).`, branch: binding.branch };
    }
    const runId = `${trigger} ${new Date().toISOString()}`;
    pushing.set(cwd, runId);

    try {
      if (!existsSync(cwd)) throw new Error(`workspace directory is gone: ${cwd}`);

      const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
      if (!inside.ok || inside.stdout !== 'true') {
        throw new Error(`${cwd} is not a git repository. Run \`git init\` there first.`);
      }

      const { token, source } = await requireToken();
      const url = remoteUrl(binding.owner, binding.repo);
      const notes = [];

      // 1. Optional auto-commit so "push" actually carries the session's work.
      if (binding.autoCommit !== false) {
        const status = await gitOrThrow(cwd, ['status', '--porcelain'], token);
        if (status.length > 0) {
          const identity = await gitIdentity(cwd);
          await gitOrThrow(cwd, ['add', '-A'], token);
          const message =
            typeof options.message === 'string' && options.message.trim().length > 0
              ? options.message.trim()
              : `chore(dsh): sync workspace at ${new Date().toISOString()}`;
          await gitOrThrow(cwd, [...identity, 'commit', '-m', message], token);
          notes.push('committed local changes');
        }
      }

      // 2. Optional remote so plain `git push dsh-binding` keeps working afterwards.
      if (binding.configureRemote !== false) {
        const existing = await git(cwd, ['remote', 'get-url', BINDING_REMOTE]);
        if (existing.ok) {
          if (existing.stdout !== url) await gitOrThrow(cwd, ['remote', 'set-url', BINDING_REMOTE, url], token);
        } else {
          await gitOrThrow(cwd, ['remote', 'add', BINDING_REMOTE, url], token);
        }
      }

      // 3. Resolve the destination branch.
      let branch = typeof binding.branch === 'string' ? binding.branch.trim() : '';
      if (branch === '') {
        const head = await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
        branch = head.ok && head.stdout !== '' ? head.stdout : 'main';
      }

      // 4. Push HEAD into that branch.
      const pushed = await git(cwd, ['push', url, `HEAD:refs/heads/${branch}`], token);
      if (!pushed.ok) throw new Error(pushHint(pushed.stderr || pushed.message, { ...binding, branch }));
      const head = await git(cwd, ['rev-parse', '--short', 'HEAD']);
      const summary = `Pushed ${binding.owner}/${binding.repo}#${branch} (${head.ok ? head.stdout : 'unknown'})${
        notes.length > 0 ? ` — ${notes.join(', ')}` : ''
      } via ${source}.`;

      binding.lastPushAt = new Date().toISOString();
      binding.lastPushStatus = 'ok';
      binding.lastPushMessage = summary;
      touch();
      record({ workspacePath: cwd, repo: `${binding.owner}/${binding.repo}`, branch, ok: true, trigger, message: summary });
      log(summary);
      return { ok: true, summary, branch, remoteUrl: url, commit: head.ok ? head.stdout : undefined, source };
    } catch (error) {
      const message = redact(error?.message ?? error);
      binding.lastPushAt = new Date().toISOString();
      binding.lastPushStatus = 'error';
      binding.lastPushMessage = message;
      touch();
      record({ workspacePath: cwd, repo: `${binding.owner}/${binding.repo}`, branch: binding.branch, ok: false, trigger, message });
      log(`push failed: ${message}`);
      return { ok: false, summary: message, branch: binding.branch };
    } finally {
      pushing.delete(cwd);
    }
  }

  /* ---------------- authentication flows ---------------- */

  /** Live device-flow attempts keyed by the GitHub device code. */
  const deviceFlows = new Map();

  async function beginDeviceFlow() {
    const clientId = String(config.clientId ?? '').trim();
    if (clientId === '') {
      throw new Error(
        'Device-flow login needs a GitHub OAuth App client id. Set `clientId` on the github-push row in cordis.patch.yml, or paste a personal access token instead.',
      );
    }
    // Retire attempts nobody will finish so the table cannot grow with retries.
    for (const [code, flow] of deviceFlows) {
      if (Date.now() > flow.expiresAt) deviceFlows.delete(code);
    }
    const { parsed, response } = await api('/login/device/code', {
      method: 'POST',
      body: { client_id: clientId, scope: DEVICE_SCOPE },
      raw: true,
    }).catch((error) => {
      throw new Error(`Could not start GitHub device flow: ${redact(error?.message ?? error)}`);
    });
    void response;
    const flow = {
      deviceCode: parsed.device_code,
      userCode: parsed.user_code,
      verificationUri: parsed.verification_uri,
      interval: Number(parsed.interval) || 5,
      expiresAt: Date.now() + (Number(parsed.expires_in) || 900) * 1000,
      clientId,
    };
    deviceFlows.set(flow.deviceCode, flow);
    return {
      userCode: flow.userCode,
      verificationUri: flow.verificationUri,
      interval: flow.interval,
      expiresIn: Math.max(0, Math.round((flow.expiresAt - Date.now()) / 1000)),
      deviceCode: flow.deviceCode,
    };
  }

  async function pollDeviceFlow(deviceCode) {
    const flow = deviceFlows.get(deviceCode);
    if (flow === undefined) return { status: 'unknown' };
    if (Date.now() > flow.expiresAt) {
      deviceFlows.delete(deviceCode);
      return { status: 'expired' };
    }
    let payload;
    try {
      payload = await api('/login/oauth/access_token', {
        method: 'POST',
        body: { client_id: flow.clientId, device_code: flow.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
      });
    } catch (error) {
      return { status: 'error', message: redact(error?.message ?? error) };
    }
    if (typeof payload?.access_token === 'string' && payload.access_token.length > 0) {
      deviceFlows.delete(deviceCode);
      await ctx.credentials.set(TOKEN_WRITE_REF, payload.access_token);
      const account = await accountOf(payload.access_token);
      record({ repo: null, ok: true, trigger: 'login', message: `Signed in as ${account?.login ?? 'unknown'}` });
      return { status: 'ok', account, source: TOKEN_WRITE_REF };
    }
    const error = typeof payload?.error === 'string' ? payload.error : 'authorization_pending';
    if (error === 'authorization_pending' || error === 'slow_down') return { status: error };
    if (error === 'access_denied') return { status: 'denied' };
    if (error === 'expired_token') {
      deviceFlows.delete(deviceCode);
      return { status: 'expired' };
    }
    return { status: 'error', message: error };
  }

  async function setToken(token) {
    const value = String(token ?? '').trim();
    if (value === '') throw new Error('empty token');
    const account = await accountOf(value);
    if (account?.error !== undefined) throw new Error(`that token was rejected: ${account.error}`);
    await ctx.credentials.set(TOKEN_WRITE_REF, value);
    record({ repo: null, ok: true, trigger: 'login', message: `Signed in as ${account.login}` });
    return { account, source: TOKEN_WRITE_REF };
  }

  async function importCliToken() {
    const result = await run('gh', ['auth', 'token'], { timeout: 10_000 });
    if (!result.ok || result.stdout.trim() === '') {
      throw new Error('`gh auth token` returned nothing. Install the GitHub CLI and run `gh auth login` first.');
    }
    return setToken(result.stdout.trim());
  }

  async function signOut() {
    try {
      await ctx.credentials.unset(TOKEN_WRITE_REF);
    } catch (error) {
      throw new Error(`could not clear ${TOKEN_WRITE_REF}: ${redact(error?.message ?? error)}`);
    }
    deviceFlows.clear();
    record({ repo: null, ok: true, trigger: 'logout', message: 'Signed out' });
    return { ok: true };
  }

  /* ---------------- status ---------------- */

  async function status(input) {
    load();
    const token = await resolveToken();
    const account = token === undefined ? undefined : await accountOf(token.token);
    const sessionWorkspace = workspacePathFrom(input);
    return {
      account: account?.error !== undefined ? { error: account.error } : (account ?? null),
      token: {
        configured: token !== undefined,
        source: token?.source,
        refs: await tokenStatuses(),
        writeRef: TOKEN_WRITE_REF,
      },
      deviceFlowConfigured: String(config.clientId ?? '').trim() !== '',
      bindings: Object.values(state.bindings),
      workspaces: listWorkspaces(),
      sessionWorkspace: sessionWorkspace === '' ? null : sessionWorkspace,
      sessionBinding: sessionWorkspace === '' ? null : (bindingFor(sessionWorkspace) ?? null),
      activity: state.activity.slice(0, ACTIVITY_LIMIT),
      defaults: {
        autoPush: config.autoPushDefault !== false,
        autoCommit: config.autoCommitDefault !== false,
      },
      statePath,
    };
  }

  /* ---------------- operations shared by UI and tool ---------------- */

  async function bind(input) {
    load();
    const workspacePath = workspacePathFrom(input);
    const owner = String(input?.owner ?? '').trim();
    const repo = String(input?.repo ?? '').replace(/\.git$/i, '').trim();
    if (workspacePath === '') throw new Error('workspace is required');
    validateSegments(owner, repo);
    const workspace = listWorkspaces().find((entry) => entry.path === workspacePath);
    if (workspace === undefined && !existsSync(workspacePath)) {
      throw new Error(`${workspacePath} is neither a known workspace nor an existing directory.`);
    }
    const previous = state.bindings[workspacePath] ?? {};
    const binding = {
      workspacePath,
      workspaceId: workspace?.id ?? previous.workspaceId ?? null,
      workspaceTitle: workspace?.title ?? previous.workspaceTitle ?? workspacePath,
      owner,
      repo,
      branch: String(input?.branch ?? previous.branch ?? '').trim(),
      autoPush: input?.autoPush === undefined ? (previous.autoPush ?? config.autoPushDefault !== false) : input.autoPush === true,
      autoCommit: input?.autoCommit === undefined ? (previous.autoCommit ?? config.autoCommitDefault !== false) : input.autoCommit === true,
      configureRemote: input?.configureRemote === undefined ? (previous.configureRemote ?? true) : input.configureRemote === true,
      remote: BINDING_REMOTE,
      remoteUrl: remoteUrl(owner, repo),
      createdAt: previous.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastPushAt: previous.lastPushAt,
      lastPushStatus: previous.lastPushStatus,
      lastPushMessage: previous.lastPushMessage,
    };
    state.bindings[workspacePath] = binding;
    touch();
    record({ workspacePath, repo: `${owner}/${repo}`, branch: binding.branch, ok: true, trigger: 'bind', message: `Bound ${workspacePath} → ${owner}/${repo}` });
    return binding;
  }

  async function unbind(input) {
    load();
    const workspacePath = workspacePathFrom(input);
    const existing = state.bindings[workspacePath];
    if (existing === undefined) return { ok: false, summary: `${workspacePath} has no binding.` };
    delete state.bindings[workspacePath];
    touch();
    record({ workspacePath, repo: `${existing.owner}/${existing.repo}`, ok: true, trigger: 'unbind', message: `Unbound ${workspacePath}` });
    return { ok: true, summary: `Unbound ${workspacePath}.` };
  }

  async function commitNow(input) {
    const workspacePath = workspacePathFrom(input);
    const binding = bindingFor(workspacePath);
    if (binding === undefined) throw new Error(`no repository is bound to ${workspacePath || 'this session'}`);
    return commitBinding(binding, { trigger: input?.trigger === 'tool' ? 'tool' : 'manual', message: input?.message });
  }

  async function pushNow(input) {
    const workspacePath = workspacePathFrom(input);
    const binding = bindingFor(workspacePath);
    if (binding === undefined) throw new Error(`no repository is bound to ${workspacePath || 'this session'}`);
    return pushBinding(binding, { trigger: input?.trigger === 'tool' ? 'tool' : 'manual', message: input?.message });
  }

  async function listRepos(input) {
    const { token } = await requireToken();
    const query = String(input?.query ?? '').trim().toLowerCase();
    const repos = await api('/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member', { token });
    const rows = (Array.isArray(repos) ? repos : []).map((repo) => ({
      fullName: repo.full_name,
      private: repo.private === true,
      defaultBranch: repo.default_branch ?? 'main',
      canPush: repo.permissions?.push === true,
      updatedAt: repo.updated_at,
    }));
    return query === '' ? rows : rows.filter((row) => row.fullName.toLowerCase().includes(query));
  }

  async function createRepo(input) {
    const { token } = await requireToken();
    const name = String(input?.name ?? '').trim();
    if (!SEGMENT.test(name)) throw new Error('repository name must be letters, digits, ".", "_" or "-".');
    const created = await api('/user/repos', {
      method: 'POST',
      token,
      body: {
        name,
        private: input?.private !== false,
        // An empty repository: this plugin's whole purpose is to push the first real
        // commit, and an `auto_init` README would make that first push non-fast-forward.
        auto_init: false,
        description: String(input?.description ?? 'Managed from DeepSeek Harness'),
      },
    });
    record({ repo: created.full_name, ok: true, trigger: 'repo-create', message: `Created ${created.full_name}` });
    return { fullName: created.full_name, defaultBranch: created.default_branch ?? 'main', private: created.private === true };
  }

  /* ---------------- browser RPC ---------------- */

  /** Method table behind both the browser route and the agent tool. */
  const methods = {
    status: (params) => status(params),
    'login.start': () => beginDeviceFlow(),
    'login.poll': (params) => pollDeviceFlow(String(params?.deviceCode ?? '')),
    'login.cancel': (params) => {
      deviceFlows.delete(String(params?.deviceCode ?? ''));
      return { ok: true };
    },
    'token.set': (params) => setToken(params?.token),
    'token.clear': () => signOut(),
    'token.importCli': () => importCliToken(),
    'repos.list': (params) => listRepos(params),
    'repo.create': (params) => createRepo(params),
    'bind.set': (params) => bind(params),
    'bind.remove': (params) => unbind(params),
    'commit.now': (params) => commitNow(params),
    'push.now': (params) => pushNow(params),
    activity: () => {
      load();
      return state.activity.slice(0, ACTIVITY_LIMIT);
    },
  };

  async function dispatch(method, params) {
    const handler = methods[method];
    if (typeof handler !== 'function') throw new Error(`unknown method "${String(method)}"`);
    return handler(params);
  }

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: ROUTE_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let payload;
          try {
            payload = await request.json();
          } catch {
            return Response.json({ ok: false, error: { message: 'malformed request body' } }, { headers: { 'cache-control': 'no-store' } });
          }
          try {
            const value = await dispatch(payload?.method, payload?.params);
            return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } });
          } catch (error) {
            return Response.json(
              { ok: false, error: { message: redact(error?.message ?? error) } },
              { headers: { 'cache-control': 'no-store' } },
            );
          }
        },
      }),
    'github-push: browser RPC route',
  );

  /* ---------------- agent tool ---------------- */

  const TOOL_DESCRIPTION = [
    'Push a DSH workspace to the GitHub repository bound to it, and inspect or change that binding.',
    'A binding is stored per workspace directory. Use action "status" to see the binding, "push" to commit-and-push',
    'the workspace HEAD to the bound repository, "bind" to record owner/repo/branch, "unbind" to remove it, and',
    '"repos" to list repositories the signed-in account can push to. Signing in is user-only: if no token is',
    'configured, ask the user to sign in from the GitHub Push row in the sidebar instead of trying to authenticate here.',
  ].join(' ');

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'github_push',
        description: TOOL_DESCRIPTION,
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: {
              type: 'string',
              enum: ['status', 'commit', 'push', 'bind', 'unbind', 'repos'],
              description: 'status reports the binding and account; commit records local changes without pushing; push commits and pushes; bind/unbind change the binding; repos lists pushable repositories.',
            },
            workspace: {
              type: 'string',
              description: 'Absolute workspace directory. Defaults to the calling session\'s working directory.',
            },
            owner: { type: 'string', description: 'GitHub owner (user or organization) — required for bind.' },
            repo: { type: 'string', description: 'GitHub repository name — required for bind.' },
            branch: { type: 'string', description: 'Destination branch. Defaults to the current branch, or main on a detached HEAD.' },
            message: { type: 'string', description: 'Commit message used when push has to commit local changes first.' },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              summary: { type: 'string' },
            },
            required: ['ok', 'summary'],
          },
          render: (_args, value) => [{ type: 'text', text: String(value?.summary ?? '') }],
        },
        presentCall: (args) => ({
          card: 'generic',
          title: `github_push: ${String(args?.action ?? 'status')}`,
          kind: 'other',
          rawInput: args,
        }),
        execute: async (args, exec) => {
          const action = typeof args?.action === 'string' ? args.action : 'status';
          const cwd = exec?.agent?.session?.header?.cwd;
          const workspace = normalizePath(args?.workspace) || normalizePath(cwd);
          try {
            if (action === 'status') {
              const snapshot = await status();
              const binding = bindingFor(workspace);
              const lines = [
                snapshot.account?.login ? `Signed in as ${snapshot.account.login} (${snapshot.token.source}).` : 'Not signed in to GitHub.',
                binding === undefined
                  ? `${workspace || 'this session'} has no bound repository.`
                  : `Bound to ${binding.owner}/${binding.repo}#${binding.branch || '(current branch)'} (auto-push ${binding.autoPush ? 'on' : 'off'}).`,
              ];
              return { ok: true, summary: lines.join(' ') };
            }
            if (action === 'bind') {
              const binding = await bind({ workspace, owner: args?.owner, repo: args?.repo, branch: args?.branch });
              return { ok: true, summary: `Bound ${binding.workspacePath} → ${binding.owner}/${binding.repo}${binding.branch ? `#${binding.branch}` : ''}.` };
            }
            if (action === 'unbind') return unbind({ workspace });
            if (action === 'repos') {
              const repos = await listRepos({});
              const summary = repos.length === 0
                ? 'No pushable repositories found.'
                : `Pushable repositories (${repos.length}): ${repos.slice(0, 30).map((row) => row.fullName).join(', ')}${repos.length > 30 ? ', …' : ''}`;
              return { ok: true, summary };
            }
            if (action === 'commit') {
              const outcome = await commitNow({ workspace, trigger: 'tool', message: args?.message });
              return { ok: outcome.ok === true, summary: outcome.summary };
            }
            if (action === 'push') {
              const outcome = await pushNow({ workspace, trigger: 'tool', message: args?.message });
              return { ok: outcome.ok === true, summary: outcome.summary };
            }
            return { ok: false, summary: `unknown action "${action}"` };
          } catch (error) {
            return { ok: false, summary: redact(error?.message ?? error) };
          }
        },
      }),
    'github-push: agent tool',
  );

  /* ---------------- automatic mirror ---------------- */

  /**
   * A session that runs `git push` in a bound workspace mirrors that push to the
   * bound repository. Fire-and-forget: a tool result is never delayed or altered.
   */
  ctx.effect(
    () =>
      ctx.on('tools/result', (exec, result) => {
        try {
          const tool = exec?.name;
          if (tool !== 'bash' && tool !== 'pwsh') return;
          if (result?.isError === true) return;
          const command = exec?.arguments?.command;
          if (typeof command !== 'string' || GIT_PUSH.test(command) === false) return;
          const cwd = exec?.agent?.session?.header?.cwd;
          const found = bindingForCwd(cwd);
          if (found === undefined || found.autoPush === false) return;
          void pushBinding(found, { trigger: 'session git push' });
        } catch (error) {
          log(`mirror skipped: ${redact(error?.message ?? error)}`);
        }
      }),
    'github-push: session push mirror',
  );

  /* ---------------- slash command ---------------- */

  const commands = ctx.commands;
  const register = (definition) => ctx.effect(() => commands.register(definition), `github-push: /${definition.name}`);

  register({
    name: 'push',
    description: 'Push the current workspace to its bound GitHub repository.',
    input: { hint: '[workspace]' },
    handler: async (invocation) => {
      const rawInput = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : '';
      const workspace = rawInput || normalizePath(invocation?.agent?.session?.header?.cwd);
      const binding = bindingFor(workspace);
      if (binding === undefined) {
        return { kind: 'error', text: `No repository is bound to ${workspace || 'this session'}.` };
      }
      const outcome = await pushNow({ workspace, trigger: 'command', message: invocation?.rawInput });
      if (outcome.ok) {
        return { kind: 'success', text: outcome.summary };
      }
      return { kind: 'error', text: outcome.summary };
    },
  });

  const originalList = commands.list.bind(commands);
  const zhDescriptions = {
    push: '将当前工作区推送到已绑定的 GitHub 仓库。',
  };
  const patchedList = function (agent) {
    return originalList(agent).map((descriptor) => {
      const zh = zhDescriptions[descriptor.name];
      return zh === undefined ? descriptor : Object.assign({}, descriptor, { description: zh });
    });
  };
  commands.list = patchedList;
  ctx.effect(() => () => {
    if (commands.list === patchedList) commands.list = originalList;
  }, 'github-push: restore commands.list');

  commands.notifyChange();
}