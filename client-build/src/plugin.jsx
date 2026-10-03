/**
 * @local/dsh-github-push — Client half source.
 *
 * Wraps the official shadcn components (registry/bases/base/ui, style vega)
 * with the Token values of the DeepSeek Harness theme. This file owns only the
 * plugin's own logic: the RPC client, the plugin store, the read model, and
 * the layout that composes those components. The only styled primitives it
 * defines itself are the `gp-` boxes shadcn has no component for — the dialog
 * frame, the sidebar row, and one status dot.
 *
 * Layout (redesigned):
 *
 *   header — title + subtitle, pinned outside the scrollport, beside the two
 *     corner actions (refresh, close).
 *   body   — a master/detail grid: the left rail carries the account card and
 *     the workspace picker (a shadcn Select — one row however many workspaces
 *     exist), the right column carries the binding editor for the selected
 *     workspace and the push activity feed. Below `lg` the two columns stack
 *     in reading order.
 *   footer — one muted footnote for the state file path; it is diagnostic, so
 *     it no longer sits inside the account card.
 *
 * Responsive behaviour is Tailwind's, not ours: the dialog is `position: fixed`,
 * so viewport breakpoints describe its width exactly, and every row either
 * stacks (`flex-col … sm:flex-row`), wraps (`flex-wrap`), or reflows its grid.
 *
 * Built by scripts/bundle.mjs into the ModuleLoader artifact the Harness serves.
 * Do not edit the generated `client.js` by hand.
 */
import css from "../dist/shadcn.css"

import * as React from "react"
import { ExternalLinkIcon, PlusIcon, RefreshCwIcon, XIcon } from "lucide-react"

/** The Harness's own transient banner; seeded in the browser module table. */
import { Toast } from "@deepseek-ai/dsh-client-ui-primitives"

import { Alert, AlertDescription } from "../vendor/ui/alert"
import { Badge } from "../vendor/ui/badge"
import { Button } from "../vendor/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../vendor/ui/card"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../vendor/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "../vendor/ui/empty"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "../vendor/ui/field"
import { Input } from "../vendor/ui/input"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../vendor/ui/item"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../vendor/ui/select"
import { Separator } from "../vendor/ui/separator"
import { Skeleton } from "../vendor/ui/skeleton"
import { Spinner } from "../vendor/ui/spinner"
import { Switch } from "../vendor/ui/switch"

/** Locale namespace owned by this plugin. */
const NS = "dsh-github-push"

/** Document-relative RPC route (survives a mount prefix). */
const ROUTE = "api/github-push.rpc"

const TOKEN_NEW_URL =
  "https://github.com/settings/tokens/new?scopes=repo,read:user&description=DSH%20GitHub%20Push"
const DEVICE_URL = "https://github.com/login/device"

/** Activity rows shown per page. */
const ACTIVITY_PAGE = 5

/* ======================================================================== */
/* helpers                                                                  */
/* ======================================================================== */

/** Open an external URL in a new tab without handing over the opener. */
function openExternal(url) {
  try {
    window.open(url, "_blank", "noopener,noreferrer")
  } catch {
    /* a blocked popup leaves the copyable URL on screen */
  }
}

/** Copy text, reporting whether it worked. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** `owner/repo` from whatever the user typed. */
function splitRepo(value) {
  const text = String(value ?? "")
    .replace(/\.git$/i, "")
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
  const slash = text.indexOf("/")
  if (slash <= 0) return null
  const owner = text.slice(0, slash).trim()
  const repo = text.slice(slash + 1).trim()
  if (owner === "" || repo === "") return null
  return { owner, repo }
}

/** Absolute timestamp, for `title` attributes and fallbacks. */
function timeOf(iso) {
  if (typeof iso !== "string" || iso === "") return ""
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString()
}

/** Compact relative time for dense rows: 刚刚 / 5 分钟前 / 3 小时前 / 2 天前. */
function relTime(t, iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  const diff = Date.now() - date.getTime()
  if (diff < 45_000) return t("timeNow")
  const minutes = Math.round(diff / 60_000)
  if (minutes < 60) return t("timeMinutesAgo", { n: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t("timeHoursAgo", { n: hours })
  const days = Math.round(hours / 24)
  if (days < 30) return t("timeDaysAgo", { n: days })
  return date.toLocaleDateString()
}

/** Activity trigger → dictionary key. */
const TRIGGER_KEYS = {
  manual: "triggerManual",
  tool: "triggerTool",
  "session git push": "triggerMirror",
  bind: "triggerBind",
  unbind: "triggerUnbind",
  login: "triggerLogin",
  logout: "triggerLogout",
  "repo-create": "triggerRepoCreate",
  ci: "triggerCi",
}

/** Translate an activity trigger, falling back to the raw value. */
function triggerLabel(t, trigger) {
  const value = String(trigger ?? "")
  const key = TRIGGER_KEYS[value]
  if (key === undefined) return value
  const text = t(key)
  return text === key ? value : text
}

/**
 * The GitHub mark. lucide carries no brand icons, so this is the canonical
 * octocat path in its own 16x16 box (optically centred), drawn at the size the
 * Harness uses for sidebar glyphs. Shaped like the Harness's own icon set
 * (`IconProps`: `size` + `className`) so the `/git-push` menu row can reuse it.
 */
function GitHubGlyph({ size = 16, className }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} fill="currentColor" focusable="false" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}

/**
 * A GitHub avatar that always renders: the photo when it loads, the mark when
 * there is none — or when the photo cannot be fetched. `avatars.githubusercontent.com`
 * is unreachable from many mobile networks even while the API itself works, so
 * the img's own `onError` falls back to the glyph instead of a broken icon.
 */
function AccountAvatar({ account }) {
  const url = account?.avatarUrl ?? null
  const [failed, setFailed] = React.useState(false)
  React.useEffect(() => setFailed(false), [url])
  if (url !== null && failed === false) {
    return (
      <img
        className="size-9 shrink-0 rounded-full bg-muted object-cover"
        src={url}
        alt=""
        width={36}
        height={36}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    )
  }
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
      <GitHubGlyph size={18} />
    </span>
  )
}

/** Spinner-bearing inline status row. */
function Working({ children }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Spinner />
      {children}
    </span>
  )
}

/* ======================================================================== */
/* dictionaries                                                             */
/* ======================================================================== */

const zh = {
  title: "GitHub 推送",
  subtitle: "登录 GitHub，为工作区绑定仓库；会话里一 push，就自动同步过去。",
  refresh: "刷新",

  accountCard: "GitHub 账户",
  signedInAs: "已登录",
  notSignedIn: "未登录",
  tokenSource: "凭据来源",
  signInDevice: "使用 GitHub 登录",
  signInDeviceHint: "打开 GitHub 授权页，输入验证码完成登录。",
  openDevicePage: "打开授权页",
  copyCode: "复制验证码",
  copied: "已复制",
  deviceWaiting: "等待授权…",
  deviceDenied: "授权被拒绝，请重试",
  deviceExpired: "验证码已过期，请重试",
  deviceNeedsClientId: "未配置 OAuth App clientId，暂时无法用设备码登录。可用下面两种方式。",
  pasteToken: "粘贴 Token 登录",
  tokenPlaceholder: "ghp_… 或 github_pat_…",
  tokenPage: "在 GitHub 上创建 Token",
  tokenPageHint: "需要一个带 repo 权限的 Token。",
  importCli: "复用 gh CLI 登录",
  importCliHint: "读取本机 gh auth login 已保存的凭据。",
  signIn: "登录",
  signOut: "退出登录",
  openPanel: "GitHub 设置",

  workspaceCard: "工作区",
  workspaceHint: "选一个工作区，右侧编辑它的仓库绑定。",
  boundBadge: "{n} 个已绑定",
  noWorkspaces: "还没有任何工作区。",
  unbound: "未绑定",

  repoLabel: "仓库（owner/repo）",
  repoPlaceholder: "octocat/hello-world",
  browseRepos: "浏览",
  hideRepos: "收起列表",
  reposLoading: "读取仓库列表…",
  noRepos: "没有可推送的仓库。",
  repoPrivate: "私有",
  repoPublic: "公开",
  branchLabel: "分支",
  branchPlaceholder: "留空 = 当前分支",
  createRepo: "新建仓库",
  createRepoName: "仓库名称",
  createRepoHint: "将创建为当前账号下的私有仓库。",
  create: "创建",
  cancel: "取消",
  bind: "绑定",
  save: "保存",
  unbind: "解绑",
  pushNow: "立即推送",
  forcePush: "强制推送",
  forceConfirmTitle: "确认强制推送？",
  forceConfirmBody: "强推会用本地历史覆盖远端 {repo}#{branch}。远端上比本地新的提交将永久丢失，其他协作者需要重新同步。此操作不可撤销。",
  forceConfirmAck: "我已了解风险，确认执行强推",
  forceConfirmGo: "确认强推",
  cmdLabel: "推送",
  cmdDesc: "将当前工作区推送到已绑定的 GitHub 仓库。",
  pushStarted: "开始推送…",
  pushSucceeded: "推送完成。",
  ciPassed: "CI 全部通过 ✅",
  ciFailed: "CI 未通过：{list}",
  triggerCi: "CI 检查",
  autoPush: "会话 push 时自动同步",
  autoPushHint: "会话里执行 git push 后，自动推送到绑定仓库。",
  autoCommit: "推送前自动提交改动",
  autoCommitHint: "先把工作区未提交的改动 commit，再一起推送。",
  configureRemote: "配置 dsh-binding remote",
  configureRemoteHint: "在本地仓库维护指向绑定仓库的 remote，方便手动 git push。",
  lastPush: "最近推送",
  pushing: "推送中…",

  activityCard: "推送记录",
  activityTabPush: "推送",
  activityTabCi: "CI",
  noActivity: "还没有推送记录。",
  activityPage: "第 {page} / {total} 页（{shown}-{end} / {totalItems} 条）",
  prevPage: "上一页",
  nextPage: "下一页",
  timeNow: "刚刚",
  timeMinutesAgo: "{n} 分钟前",
  timeHoursAgo: "{n} 小时前",
  timeDaysAgo: "{n} 天前",

  loading: "加载中…",
  statePath: "绑定数据保存在",
  triggerManual: "手动",
  triggerTool: "工具",
  triggerMirror: "会话 push 自动同步",
  triggerBind: "绑定",
  triggerLogin: "登录",
  triggerLogout: "退出",
  triggerRepoCreate: "新建仓库",
  triggerUnbind: "解绑",
}

const en = {
  title: "GitHub Push",
  subtitle: "Sign in to GitHub, bind a repository to a workspace, and every push from that workspace lands there.",
  refresh: "Refresh",

  accountCard: "GitHub account",
  signedInAs: "Signed in",
  notSignedIn: "Not signed in",
  tokenSource: "Credential source",
  signInDevice: "Sign in with GitHub",
  signInDeviceHint: "Open the GitHub device page and enter the code below.",
  openDevicePage: "Open device page",
  copyCode: "Copy code",
  copied: "Copied",
  deviceWaiting: "Waiting for authorization…",
  deviceDenied: "Authorization denied — try again",
  deviceExpired: "The code expired — try again",
  deviceNeedsClientId: "Device login needs an OAuth App clientId. Use one of the other paths below.",
  pasteToken: "Sign in with a token",
  tokenPlaceholder: "ghp_… or github_pat_…",
  tokenPage: "Create a token on GitHub",
  tokenPageHint: "It needs the repo scope.",
  importCli: "Reuse the gh CLI session",
  importCliHint: "Reads the credential stored by `gh auth login` on this machine.",
  signIn: "Sign in",
  signOut: "Sign out",
  openPanel: "GitHub Settings",

  workspaceCard: "Workspaces",
  workspaceHint: "Pick a workspace; the editor on the right binds its repository.",
  boundBadge: "{n} bound",
  noWorkspaces: "No workspaces yet.",
  unbound: "Not bound",

  repoLabel: "Repository (owner/repo)",
  repoPlaceholder: "octocat/hello-world",
  browseRepos: "Browse",
  hideRepos: "Hide list",
  reposLoading: "Loading repositories…",
  noRepos: "No pushable repositories found.",
  repoPrivate: "private",
  repoPublic: "public",
  branchLabel: "Branch",
  branchPlaceholder: "empty = current branch",
  createRepo: "New repository",
  createRepoName: "Repository name",
  createRepoHint: "It will be created as a private repository under your account.",
  create: "Create",
  cancel: "Cancel",
  bind: "Bind",
  save: "Save",
  unbind: "Unbind",
  pushNow: "Push now",
  forcePush: "Force push",
  forceConfirmTitle: "Force-push this workspace?",
  forceConfirmBody: "A force push overwrites {repo}#{branch} with your local history. Remote commits newer than local are lost permanently, and collaborators must re-sync. This cannot be undone.",
  forceConfirmAck: "I understand the risk — force-push anyway",
  forceConfirmGo: "Confirm force push",
  cmdLabel: "Push",
  cmdDesc: "Push the current workspace to its bound GitHub repository.",
  pushStarted: "Push started…",
  pushSucceeded: "Push finished.",
  ciPassed: "CI passed ✅",
  ciFailed: "CI failed: {list}",
  triggerCi: "CI check",
  autoPush: "Auto-sync when a session pushes",
  autoPushHint: "After `git push` in a session, push to the bound repository too.",
  autoCommit: "Commit local changes before pushing",
  autoCommitHint: "Commit the workspace's pending changes first, then push them together.",
  configureRemote: "Configure the dsh-binding remote",
  configureRemoteHint: "Keep a local remote pointing at the bound repository for manual pushes.",
  lastPush: "Last push",
  pushing: "Pushing…",

  activityCard: "Push activity",
  activityTabPush: "Pushes",
  activityTabCi: "CI",
  noActivity: "No pushes yet.",
  activityPage: "Page {page} / {total} ({shown}-{end} of {totalItems})",
  prevPage: "Previous",
  nextPage: "Next",
  timeNow: "just now",
  timeMinutesAgo: "{n} min ago",
  timeHoursAgo: "{n} h ago",
  timeDaysAgo: "{n} d ago",

  loading: "Loading…",
  statePath: "Bindings are stored in",
  triggerManual: "manual",
  triggerTool: "tool",
  triggerMirror: "session push mirror",
  triggerBind: "bind",
  triggerLogin: "login",
  triggerLogout: "logout",
  triggerRepoCreate: "repository created",
  triggerUnbind: "unbind",
}

/* ======================================================================== */
/* plugin state                                                             */
/* ======================================================================== */

/**
 * One tiny observable shared by the sidebar row and the dialog — they live in
 * different slots, so they cannot share React state directly.
 */
function createUiStore(initial) {
  let state = initial
  const listeners = new Set()
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...patch }
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

const uiStore = createUiStore({ open: false, pushTick: 0 })

/**
 * One transient banner at a time (the Toast owns its own fade timer). `seq`
 * keys the render so re-showing identical text restarts the slide-in/hold/fade
 * cycle instead of being treated as the same mount.
 */
const toastStore = createUiStore({ seq: 0, message: null })

/** Show a Harness-style top-center toast; pass `ok:false` for failures. */
function showToast(text, ok = true) {
  toastStore.set({ seq: toastStore.get().seq + 1, message: { text, ok } })
}

function useUiStore(store) {
  const [value, setValue] = React.useState(store.get)
  React.useEffect(() => store.subscribe(() => setValue(store.get())), [store])
  return value
}

/** Frame-wide host for the `/git-push` banners, mounted beside the dialog. */
function ToastHost() {
  const state = useUiStore(toastStore)
  if (state.message === null) return null
  const { text, ok } = state.message
  return (
    <Toast
      key={state.seq}
      text={text}
      tone={ok ? "success" : undefined}
      icon={ok ? undefined : <GitHubGlyph size={16} />}
      onDone={() => toastStore.set({ message: null })}
    />
  )
}

/** Call one Host method over the authenticated document-relative route. */
async function callRpc(method, params) {
  const response = await fetch(ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params: params ?? {} }),
  })
  if (response.ok === false) throw new Error(`Host route responded ${response.status}`)
  const payload = await response.json()
  if (payload?.ok !== true) throw new Error(String(payload?.error?.message ?? "Host call failed"))
  return payload.value
}

/* ------------------------------------------------------------------ */
/* CI watch — poll one pushed commit's checks until they settle        */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Generation guard: a newer `/git-push` retires any older watch loop. */
let ciGeneration = 0

/**
 * Poll `ci.status` for the session's HEAD commit until it settles, then raise
 * the verdict as a toast and append it to the activity feed via `ci.log`.
 * Silent by design while checks are still queued or running; a repo with no
 * CI at all stays silent forever (`pending` past its grace window). Any error
 * ends the watch quietly — the push itself already reported.
 */
async function watchCi(t, sessionId) {
  const generation = (ciGeneration += 1)
  const startedAt = Date.now()
  let sawChecks = false
  try {
    await sleep(5_000)
    while (Date.now() - startedAt < 300_000) {
      if (generation !== ciGeneration) return
      const status = await callRpc("ci.status", { sessionId })
      const state = String(status?.state ?? "")
      if (state === "success" || state === "failure") {
        const list = state === "failure" ? status.failed ?? [] : status.passed ?? []
        const message = state === "success" ? "CI passed." : `CI failed: ${list.join(", ")}`
        await callRpc("ci.log", { sessionId, ok: state === "success", message }).catch(() => {})
        showToast(state === "success" ? t("ciPassed") : t("ciFailed", { list: list.slice(0, 3).join(", ") }), state === "success")
        uiStore.set({ pushTick: uiStore.get().pushTick + 1 })
        return
      }
      if (state === "running") sawChecks = true
      else if (state === "pending" && sawChecks === false && Date.now() - startedAt > 60_000) return
      else if (state === "unknown") return
      await sleep(5_000)
    }
  } catch {
    /* a failing poll ends the watch; the panel refresh button re-reads anyway */
  }
}

/** Read the plugin snapshot, optionally scoped to one session. */
function useStatus(ctx, sessionId) {
  const [snapshot, setSnapshot] = React.useState({ loading: true, data: null, error: null })
  const [busy, setBusy] = React.useState(0)

  const refresh = React.useCallback(async () => {
    setBusy((value) => value + 1)
    try {
      const data = await callRpc("status", sessionId === undefined ? {} : { sessionId })
      setSnapshot({ loading: false, data, error: null })
    } catch (error) {
      setSnapshot((previous) => ({ loading: false, data: previous.data, error: String(error?.message ?? error) }))
    } finally {
      setBusy((value) => value - 1)
    }
  }, [sessionId])

  React.useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const data = await callRpc("status", sessionId === undefined ? {} : { sessionId })
        if (alive) setSnapshot({ loading: false, data, error: null })
      } catch (error) {
        if (alive) setSnapshot({ loading: false, data: null, error: String(error?.message ?? error) })
      }
    })()
    return () => {
      alive = false
    }
  }, [sessionId])

  return [snapshot, refresh, busy > 0]
}

/** Bind the locale namespace, re-binding whenever the locale changes. */
function useT(ctx) {
  const [version, setVersion] = React.useState(0)
  React.useEffect(() => {
    try {
      return ctx.locale.subscribe(() => setVersion((value) => value + 1))
    } catch {
      return undefined
    }
  }, [ctx])
  return React.useMemo(() => {
    try {
      return ctx.locale.bind(NS)
    } catch {
      return (key) => key
    }
  }, [ctx, version])
}

/* ======================================================================== */
/* views                                                                    */
/* ======================================================================== */

/**
 * The GitHub account card. Signed in it is three lines: avatar, identity,
 * sign-out. Signed out it stacks the three sign-in paths — device flow,
 * pasted token, gh CLI import — each with its own hint.
 */
function AccountCard({ t, snapshot, refresh }) {
  const [error, setError] = React.useState(null)
  const [note, setNote] = React.useState(null)
  const [device, setDevice] = React.useState(null)
  const [deviceState, setDeviceState] = React.useState(null)
  const [tokenDraft, setTokenDraft] = React.useState("")
  const [pending, setPending] = React.useState(null)
  const [copied, setCopied] = React.useState(false)

  const account = snapshot?.account ?? null
  const signedIn = account !== null && account?.login !== undefined

  // Device-flow polling lives in one effect so unmount always stops it.
  React.useEffect(() => {
    if (device === null) return undefined
    let cancelled = false
    const tick = async () => {
      try {
        const result = await callRpc("login.poll", { deviceCode: device.deviceCode })
        if (cancelled) return
        if (result?.status === "ok") {
          setDevice(null)
          setDeviceState(null)
          setNote(`${t("signedInAs")} ${result.account?.login ?? ""}`)
          await refresh()
          return
        }
        if (result?.status === "denied" || result?.status === "expired") {
          setDevice(null)
          setDeviceState(result.status)
          return
        }
        setDeviceState(result?.status ?? "authorization_pending")
      } catch {
        if (!cancelled) setDeviceState("error")
      }
    }
    const timer = window.setInterval(tick, Math.max(3, Number(device.interval) || 5) * 1000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [device, refresh, t])

  const guard = async (label, operation) => {
    setPending(label)
    setError(null)
    setNote(null)
    try {
      const result = await operation()
      await refresh()
      return result
    } catch (failure) {
      setError(String(failure?.message ?? failure))
      return null
    } finally {
      setPending(null)
    }
  }

  return (
    <Card data-dsh-github-push>
      <CardHeader>
        <CardTitle>{t("accountCard")}</CardTitle>
        <CardAction>
          <Badge variant={signedIn ? "default" : "outline"}>{signedIn ? t("signedInAs") : t("notSignedIn")}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        {signedIn ? (
          <div className="flex min-w-0 items-center gap-2.5">
            <AccountAvatar account={account} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{account.login}</div>
              <div className="truncate text-xs text-muted-foreground">
                {t("tokenSource")}: {snapshot?.token?.source ?? "—"}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              disabled={pending !== null}
              onClick={() => guard("signOut", () => callRpc("token.clear"))}
            >
              {t("signOut")}
            </Button>
          </div>
        ) : null}

        {error !== null ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {note !== null ? (
          <Alert>
            <AlertDescription>{note}</AlertDescription>
          </Alert>
        ) : null}

        {signedIn ? null : (
          <div className="flex flex-col gap-3">
            {snapshot?.deviceFlowConfigured === true ? (
              <div className="flex flex-col gap-2">
                <Button
                  className="w-full"
                  disabled={pending !== null || device !== null}
                  onClick={() =>
                    guard("device", async () => {
                      const started = await callRpc("login.start")
                      setDevice(started)
                      setDeviceState("authorization_pending")
                      openExternal(started.verificationUri ?? DEVICE_URL)
                      return started
                    })
                  }
                >
                  {pending === "device" ? <Working>{t("loading")}</Working> : <GitHubGlyph size={14} />}
                  {pending === "device" ? null : t("signInDevice")}
                </Button>
                <FieldDescription className="text-xs">{t("signInDeviceHint")}</FieldDescription>
                {device !== null ? (
                  <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted p-3">
                    <div className="py-0.5 text-center font-mono text-lg font-semibold tracking-widest break-all sm:text-xl">
                      {device.userCode}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="gp-fill min-w-0 flex-1"
                        onClick={async () => {
                          setCopied(await copyText(device.userCode))
                          window.setTimeout(() => setCopied(false), 1600)
                        }}
                      >
                        {copied ? t("copied") : t("copyCode")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gp-fill min-w-0 flex-1"
                        onClick={() => openExternal(device.verificationUri ?? DEVICE_URL)}
                      >
                        {t("openDevicePage")}
                      </Button>
                    </div>
                    <p className="m-0 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Spinner />
                      {deviceState === "denied"
                        ? t("deviceDenied")
                        : deviceState === "expired"
                          ? t("deviceExpired")
                          : t("deviceWaiting")}
                    </p>
                  </div>
                ) : deviceState === "denied" || deviceState === "expired" ? (
                  <FieldError>{deviceState === "denied" ? t("deviceDenied") : t("deviceExpired")}</FieldError>
                ) : null}
              </div>
            ) : (
              <FieldDescription className="text-xs">{t("deviceNeedsClientId")}</FieldDescription>
            )}

            <Separator />

            <Field>
              <FieldLabel htmlFor="gp-token-draft">{t("pasteToken")}</FieldLabel>
              <div className="flex min-w-0 gap-2">
                <Input
                  id="gp-token-draft"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t("tokenPlaceholder")}
                  value={tokenDraft}
                  onChange={(event) => setTokenDraft(event.target.value)}
                />
                <Button
                  className="shrink-0"
                  disabled={pending !== null || tokenDraft.trim() === ""}
                  onClick={() =>
                    guard("token", async () => {
                      const result = await callRpc("token.set", { token: tokenDraft.trim() })
                      setTokenDraft("")
                      setNote(`${t("signedInAs")} ${result?.account?.login ?? ""}`)
                      return result
                    })
                  }
                >
                  {pending === "token" ? <Working>{t("loading")}</Working> : t("signIn")}
                </Button>
              </div>
              <FieldDescription className="flex flex-wrap items-center gap-x-1 text-xs">
                {t("tokenPageHint")}
                <Button variant="link" size="xs" className="h-auto gap-1 px-0" onClick={() => openExternal(TOKEN_NEW_URL)}>
                  {t("tokenPage")}
                  <ExternalLinkIcon />
                </Button>
              </FieldDescription>
            </Field>

            <div className="flex flex-col gap-1.5">
              <Button
                variant="outline"
                className="gp-fill w-full"
                disabled={pending !== null}
                onClick={() =>
                  guard("cli", async () => {
                    const result = await callRpc("token.importCli")
                    setNote(`${t("signedInAs")} ${result?.account?.login ?? ""}`)
                    return result
                  })
                }
              >
                {pending === "cli" ? <Working>{t("loading")}</Working> : t("importCli")}
              </Button>
              <FieldDescription className="text-xs">{t("importCliHint")}</FieldDescription>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * The master selector: one shadcn Select over every workspace. A dropdown
 * keeps the rail the same height however many workspaces the profile has —
 * a row per workspace would stretch the dialog — while the bound repository
 * still rides in the option label, so nothing is hidden.
 */
function WorkspacePicker({ t, workspaces, bindingsByPath, selected, onSelect }) {
  const boundCount = workspaces.filter((workspace) => bindingsByPath.has(workspace.path)).length
  const optionLabel = (workspace) => {
    const bound = bindingsByPath.get(workspace.path)
    return bound === undefined
      ? `${workspace.title} · ${t("unbound")}`
      : `${workspace.title} · ${bound.owner}/${bound.repo}`
  }
  const items = workspaces.map((workspace) => ({ value: workspace.path, label: optionLabel(workspace) }))
  return (
    <Card data-dsh-github-push>
      <CardHeader>
        <CardTitle>{t("workspaceCard")}</CardTitle>
        <CardAction>
          {boundCount > 0 ? <Badge variant="secondary">{t("boundBadge", { n: boundCount })}</Badge> : null}
        </CardAction>
      </CardHeader>
      <CardContent>
        {workspaces.length === 0 ? (
          <Empty className="border border-dashed">
            <EmptyHeader>
              <EmptyDescription>{t("noWorkspaces")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Field>
            <Select items={items} value={selected ?? null} onValueChange={onSelect}>
              <SelectTrigger id="gp-workspace" className="gp-fill w-full" aria-label={t("workspaceCard")}>
                <SelectValue />
              </SelectTrigger>
              {/* Base UI portals the popup out of the dialog into the dialog's
                  portal container, so the token scope has to travel with it —
                  `bg-popover`, `ring-foreground/10` and `rounded-md` all
                  resolve to nothing otherwise (measured in a real browser).
                  shadcn's default `alignItemWithTrigger` centres the popup so
                  the *selected option* sits on top of the trigger, native-
                  select style — here the trigger is a labelled field, so the
                  menu must hang below it, left-aligned to its edge. */}
              <SelectContent data-dsh-github-push align="start" alignItemWithTrigger={false}>
                {workspaces.map((workspace) => (
                  <SelectItem key={workspace.path} value={workspace.path} title={workspace.path}>
                    {optionLabel(workspace)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription className="text-xs">{t("workspaceHint")}</FieldDescription>
          </Field>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * The binding editor for the selected workspace: repository (typed or picked
 * from the browse list), branch (or created on GitHub inline — no more
 * `window.prompt`), the three sync switches with their own explanations, and
 * the save / push / unbind actions.
 */
function BindingEditor({ t, workspace, binding, defaults, onChanged }) {
  const path = workspace.path
  const [ownerRepo, setOwnerRepo] = React.useState(binding === undefined ? "" : `${binding.owner}/${binding.repo}`)
  const [branch, setBranch] = React.useState(binding?.branch ?? "")
  const [autoPush, setAutoPush] = React.useState(binding?.autoPush ?? defaults.autoPush === true)
  const [autoCommit, setAutoCommit] = React.useState(binding?.autoCommit ?? defaults.autoCommit === true)
  const [configureRemote, setConfigureRemote] = React.useState(binding?.configureRemote ?? true)
  /** `null` = closed, `"loading"` = fetching, an array = the fetched list. */
  const [repos, setRepos] = React.useState(null)
  const [creating, setCreating] = React.useState(false)
  const [newRepoName, setNewRepoName] = React.useState("")
  const [pending, setPending] = React.useState(null)
  const [result, setResult] = React.useState(null)
  /** The force-push confirmation: open dialog + the risk-acknowledge checkbox. */
  const [forceOpen, setForceOpen] = React.useState(false)
  const [forceAck, setForceAck] = React.useState(false)

  React.useEffect(() => {
    setOwnerRepo(binding === undefined ? "" : `${binding.owner}/${binding.repo}`)
    setBranch(binding?.branch ?? "")
    setAutoPush(binding?.autoPush ?? defaults.autoPush === true)
    setAutoCommit(binding?.autoCommit ?? defaults.autoCommit === true)
    setConfigureRemote(binding?.configureRemote ?? true)
    setRepos(null)
    setCreating(false)
    setNewRepoName("")
    setResult(null)
  }, [
    path,
    binding?.owner,
    binding?.repo,
    binding?.branch,
    binding?.autoPush,
    binding?.autoCommit,
    binding?.configureRemote,
    defaults.autoPush,
    defaults.autoCommit,
  ])

  const act = async (label, operation) => {
    setPending(label)
    setResult(null)
    try {
      const value = await operation()
      setResult({ ok: true, message: typeof value?.summary === "string" ? value.summary : "" })
      await onChanged()
      return value
    } catch (failure) {
      setResult({ ok: false, message: String(failure?.message ?? failure) })
      return null
    } finally {
      setPending(null)
    }
  }

  const segments = splitRepo(ownerRepo)

  const save = () => {
    if (segments === null) {
      setResult({ ok: false, message: t("repoLabel") })
      return Promise.resolve(null)
    }
    return act("save", () =>
      callRpc("bind.set", {
        workspace: path,
        owner: segments.owner,
        repo: segments.repo,
        branch,
        autoPush,
        autoCommit,
        configureRemote,
      }),
    )
  }

  const toggleBrowse = () =>
    act("repos", async () => {
      if (repos !== null) {
        setRepos(null)
        return { summary: "" }
      }
      setRepos("loading")
      const rows = await callRpc("repos.list", {})
      setRepos(Array.isArray(rows) ? rows : [])
      return { summary: "" }
    })

  const createRepo = () =>
    act("create", async () => {
      const name = newRepoName.trim()
      if (name === "") return { summary: "" }
      const created = await callRpc("repo.create", { name, private: true })
      setOwnerRepo(created.fullName)
      if (branch.trim() === "") setBranch(created.defaultBranch ?? "")
      setCreating(false)
      setNewRepoName("")
      return { summary: `${t("createRepo")}: ${created.fullName}` }
    })

  const switchRow = (id, labelKey, hintKey, checked, setChecked) => (
    <Field orientation="horizontal" className="gap-3">
      <FieldContent>
        <FieldLabel htmlFor={id} className="font-medium">
          {t(labelKey)}
        </FieldLabel>
        <FieldDescription className="text-xs">{t(hintKey)}</FieldDescription>
      </FieldContent>
      <Switch id={id} checked={checked} onCheckedChange={setChecked} />
    </Field>
  )

  return (
    <Card data-dsh-github-push data-gp-editor data-bound={binding !== undefined}>
      <CardHeader>
        <CardTitle className="truncate">{workspace.title}</CardTitle>
        <CardDescription className="truncate">{path}</CardDescription>
        <CardAction>
          <Badge variant={binding === undefined ? "outline" : "secondary"}>
            {binding === undefined ? t("unbound") : `${binding.owner}/${binding.repo}`}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3.5">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`gp-repo-${path}`}>{t("repoLabel")}</FieldLabel>
            <div className="flex min-w-0 gap-2">
              <Input
                id={`gp-repo-${path}`}
                placeholder={t("repoPlaceholder")}
                value={ownerRepo}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setOwnerRepo(event.target.value)}
              />
              {/* Default size, not `sm`: the Input is h-9 and the sm button is
                  h-8, and an explicit height defeats the flex row's stretch —
                  side by side they read as a mis-set pair. */}
              <Button
                variant="outline"
                className="gp-fill shrink-0"
                disabled={pending !== null}
                onClick={toggleBrowse}
              >
                {repos === null ? t("browseRepos") : t("hideRepos")}
              </Button>
            </div>
            {repos !== null ? (
              <div className="flex max-h-44 min-w-0 flex-col overflow-y-auto rounded-lg border border-border">
                {repos === "loading" ? (
                  <p className="m-0 inline-flex items-center gap-2 px-2.5 py-2 text-xs text-muted-foreground">
                    <Spinner />
                    {t("reposLoading")}
                  </p>
                ) : repos.length === 0 ? (
                  <p className="m-0 px-2.5 py-2 text-xs text-muted-foreground">{t("noRepos")}</p>
                ) : (
                  repos.map((repo) => (
                    <button
                      key={repo.fullName}
                      type="button"
                      className="flex min-w-0 items-center justify-between gap-2 border-b border-border bg-transparent px-2.5 py-1.5 text-left text-xs transition-colors last:border-b-0 hover:bg-muted"
                      onClick={() => {
                        setOwnerRepo(repo.fullName)
                        if (branch.trim() === "") setBranch(repo.defaultBranch ?? "")
                        setRepos(null)
                      }}
                    >
                      <span className="truncate font-medium">{repo.fullName}</span>
                      <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                        <span className="font-mono">{repo.defaultBranch}</span>
                        <span>{repo.private ? t("repoPrivate") : t("repoPublic")}</span>
                      </span>
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </Field>

          <Field>
            <FieldLabel htmlFor={`gp-branch-${path}`}>{t("branchLabel")}</FieldLabel>
            <div className="flex min-w-0 gap-2">
              <Input
                id={`gp-branch-${path}`}
                placeholder={t("branchPlaceholder")}
                value={branch}
                spellCheck={false}
                onChange={(event) => setBranch(event.target.value)}
              />
              <Button
                variant="outline"
                className="gp-fill shrink-0 gap-1"
                disabled={pending !== null}
                onClick={() => setCreating(!creating)}
              >
                <PlusIcon />
                {t("createRepo")}
              </Button>
            </div>
            {creating ? (
              <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted p-2.5">
                <div className="flex min-w-0 gap-2">
                  <Input
                    aria-label={t("createRepoName")}
                    placeholder={t("createRepoName")}
                    value={newRepoName}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => setNewRepoName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault()
                        void createRepo()
                      }
                    }}
                  />
                  <Button
                    className="shrink-0"
                    disabled={pending !== null || newRepoName.trim() === ""}
                    onClick={createRepo}
                  >
                    {pending === "create" ? <Working>{t("loading")}</Working> : t("create")}
                  </Button>
                  <Button variant="ghost" className="shrink-0" onClick={() => setCreating(false)}>
                    {t("cancel")}
                  </Button>
                </div>
                <FieldDescription className="text-xs">{t("createRepoHint")}</FieldDescription>
              </div>
            ) : null}
          </Field>
        </FieldGroup>

        <Separator />

        <div className="flex flex-col gap-3">
          {switchRow(`gp-auto-${path}`, "autoPush", "autoPushHint", autoPush, setAutoPush)}
          {switchRow(`gp-commit-${path}`, "autoCommit", "autoCommitHint", autoCommit, setAutoCommit)}
          {switchRow(`gp-remote-${path}`, "configureRemote", "configureRemoteHint", configureRemote, setConfigureRemote)}
        </div>

        {binding?.lastPushMessage !== undefined && binding?.lastPushMessage !== null ? (
          binding.lastPushStatus === "ok" ? (
            <FieldDescription className="text-xs">
              {t("lastPush")} · <time title={timeOf(binding.lastPushAt)}>{relTime(t, binding.lastPushAt)}</time> ·{" "}
              {binding.lastPushMessage}
            </FieldDescription>
          ) : (
            <FieldError className="text-xs">
              {t("lastPush")} · <time title={timeOf(binding.lastPushAt)}>{relTime(t, binding.lastPushAt)}</time> ·{" "}
              {binding.lastPushMessage}
            </FieldError>
          )
        ) : null}

        {result !== null && result.message !== "" ? (
          <Alert variant={result.ok ? "default" : "destructive"}>
            <AlertDescription>{result.message}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button disabled={pending !== null} onClick={save}>
          {pending === "save" ? <Working>{t("loading")}</Working> : binding === undefined ? t("bind") : t("save")}
        </Button>
        <Button
          variant="outline"
          className="gp-fill"
          disabled={pending !== null || binding === undefined}
          onClick={() => act("push", () => callRpc("push.now", { workspace: path }))}
        >
          {pending === "push" ? <Working>{t("pushing")}</Working> : t("pushNow")}
        </Button>
        <Button
          variant="outline"
          className="gp-fill text-destructive hover:text-destructive"
          disabled={pending !== null || binding === undefined}
          onClick={() => {
            setForceAck(false)
            setForceOpen(true)
          }}
        >
          {pending === "force" ? <Working>{t("pushing")}</Working> : t("forcePush")}
        </Button>
        <Button
          variant="destructive"
          className="ml-auto"
          disabled={pending !== null || binding === undefined}
          onClick={() => act("unbind", () => callRpc("bind.remove", { workspace: path }))}
        >
          {t("unbind")}
        </Button>
      </CardFooter>

      {/* Two-step confirmation for the destructive push: the dialog itself is
          the first step, the risk-acknowledge checkbox gates the final button
          as the second. The host force-pushes with `--force-with-lease`, so a
          remote that moved outside this client's view still refuses. */}
      <Dialog open={forceOpen} onOpenChange={(open) => !open && setForceOpen(false)}>
        <DialogContent showCloseButton data-dsh-github-push>
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">{t("forceConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("forceConfirmBody", { repo: `${binding?.owner ?? ""}/${binding?.repo ?? ""}`, branch: binding?.branch || "-" })}
            </DialogDescription>
          </DialogHeader>
          <label className="flex min-w-0 cursor-pointer items-start gap-2 rounded-md border border-border p-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 accent-destructive"
              checked={forceAck}
              onChange={(event) => setForceAck(event.target.checked)}
            />
            <span>{t("forceConfirmAck")}</span>
          </label>
          <DialogFooter className="flex flex-wrap gap-2">
            <Button variant="ghost" disabled={pending === "force"} onClick={() => setForceOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              className="ml-auto"
              disabled={!forceAck || pending === "force"}
              onClick={async () => {
                const outcome = await act("force", () => callRpc("push.now", { workspace: path, force: true }))
                if (outcome !== null) setForceOpen(false)
              }}
            >
              {pending === "force" ? <Working>{t("pushing")}</Working> : t("forceConfirmGo")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

/**
 * The workspace activity feed, split into two tabs: pushes (every record that
 * is not a CI verdict) and CI checks. Rows are scoped to the selected
 * workspace — a record without a `workspacePath` (login, repo-create) belongs
 * to no workspace and shows in neither tab. Each tab pages independently by
 * fixed `ACTIVITY_PAGE` chunks, with prev/next buttons and a page counter.
 */
const ACTIVITY_TABS = [
  { key: "push", labelKey: "activityTabPush", match: (entry) => entry.trigger !== "ci" },
  { key: "ci", labelKey: "activityTabCi", match: (entry) => entry.trigger === "ci" },
]

function ActivityCard({ t, activity, workspacePath }) {
  const [tab, setTab] = React.useState("push")
  const [page, setPage] = React.useState(1)

  // A different workspace or tab restarts paging at the first page.
  React.useEffect(() => {
    setPage(1)
  }, [workspacePath, tab])

  const rows = activity.filter((entry) => entry.workspacePath === workspacePath && ACTIVITY_TABS.find((x) => x.key === tab).match(entry))
  const totalPages = Math.max(1, Math.ceil(rows.length / ACTIVITY_PAGE))
  const safePage = Math.min(page, totalPages)
  const start = (safePage - 1) * ACTIVITY_PAGE + 1
  const end = Math.min(safePage * ACTIVITY_PAGE, rows.length)
  const visible = rows.slice((safePage - 1) * ACTIVITY_PAGE, safePage * ACTIVITY_PAGE)

  React.useEffect(() => {
    if (safePage !== page) setPage(safePage)
  }, [safePage, page])

  return (
    <Card data-dsh-github-push data-gp-activity>
      <CardHeader>
        <CardTitle>{t("activityCard")}</CardTitle>
        <CardAction>
          {/* Segmented tab strip: one button per feed, active row filled. */}
          <div role="tablist" className="inline-flex items-center gap-0.5 rounded-md border border-border p-0.5">
            {ACTIVITY_TABS.map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={tab === item.key}
                data-gp-tab={item.key}
                className={`rounded-[calc(var(--radius-md)-2px)] px-2 py-0.5 text-xs transition-colors ${
                  tab === item.key ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setTab(item.key)}
              >
                {t(item.labelKey)}
              </button>
            ))}
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="gap-2">
        {rows.length === 0 ? (
          <Empty className="border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <RefreshCwIcon />
              </EmptyMedia>
              <EmptyDescription>{t("noActivity")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <ItemGroup className="gap-1">
              {visible.map((entry, index) => (
                <Item key={`${entry.at}-${index}`} size="xs" variant="outline" data-ok={entry.ok === true} className="min-w-0">
                  <ItemMedia variant="icon" className="size-4 shrink-0 bg-transparent">
                    <span className="gp-dot" />
                  </ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle className="truncate">{entry.repo ?? triggerLabel(t, entry.trigger)}</ItemTitle>
                    {entry.message !== undefined && entry.message !== null && entry.message !== "" ? (
                      <ItemDescription className="line-clamp-1">{entry.message}</ItemDescription>
                    ) : null}
                  </ItemContent>
                  <ItemActions>
                    <time
                      className="shrink-0 text-xs text-muted-foreground tabular-nums"
                      title={timeOf(entry.at)}
                    >
                      {relTime(t, entry.at)}
                    </time>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
            <div className="flex min-w-0 flex-wrap items-center justify-center gap-2">
              <FieldDescription className="text-xs">
                {t("activityPage", { page: safePage, total: totalPages, shown: start, end, totalItems: rows.length })}
              </FieldDescription>
              <Button
                variant="outline"
                size="xs"
                className="gp-fill"
                data-gp-prev-page
                disabled={safePage <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                {t("prevPage")}
              </Button>
              <Button
                variant="outline"
                size="xs"
                className="gp-fill"
                data-gp-next-page
                disabled={safePage >= totalPages}
                onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
              >
                {t("nextPage")}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** Loading stand-in shaped like the real grid, so nothing jumps when it fills. */
function LoadingSkeleton({ t }) {
  return (
    <div className="grid min-w-0 grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        {[0, 1].map((key) => (
          <Card key={key} data-dsh-github-push>
            <CardHeader>
              <CardTitle>{key === 0 ? t("accountCard") : t("workspaceCard")}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2.5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        {[0, 1].map((key) => (
          <Card key={key} data-dsh-github-push>
            <CardHeader>
              <CardTitle>{key === 0 ? t("repoLabel") : t("activityCard")}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2.5">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-16 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

/** The sidebar row above the Settings seat; opens the dialog. */
function SidebarAction({ ctx, wide }) {
  const t = useT(ctx)
  const state = useUiStore(uiStore)
  const label = t("openPanel")
  return (
    <button
      type="button"
      className="gp-foot-row"
      data-dsh-github-push
      data-slot="github-push-launcher"
      data-wide={wide === true}
      data-open={state.open === true}
      title={label}
      aria-haspopup="dialog"
      aria-expanded={state.open === true}
      onClick={() => uiStore.set({ open: !uiStore.get().open })}
    >
      <span className="gp-foot-icon">
        <GitHubGlyph size={wide === true ? 16 : 18} />
      </span>
      {wide === true ? (
        <span className="gp-foot-label">{label}</span>
      ) : (
        <span className="sr-only">{label}</span>
      )}
    </button>
  )
}

/** The dialog: left rail (account, workspaces), right column (editor, activity). */
function SettingsDialog({ ctx }) {
  const t = useT(ctx)
  const state = useUiStore(uiStore)
  const [snapshot, refresh, refreshing] = useStatus(ctx, undefined)

  // The `/git-push` menu row runs the push outside this dialog; when it
  // settles it bumps `pushTick`, and the panel re-reads the snapshot so the
  // fresh activity row and last-push status are on screen without a manual
  // refresh.
  const seenPushTick = React.useRef(state.pushTick)
  React.useEffect(() => {
    if (state.pushTick === seenPushTick.current) return
    seenPushTick.current = state.pushTick
    void refresh()
  }, [state.pushTick, refresh])

  const data = snapshot.data
  const bindings = data?.bindings ?? []
  const bindingsByPath = React.useMemo(() => {
    const map = new Map()
    for (const binding of bindings) map.set(binding.workspacePath, binding)
    return map
  }, [bindings])
  const workspaces = React.useMemo(() => {
    const rows = [...(data?.workspaces ?? [])]
    for (const binding of bindings) {
      if (rows.some((workspace) => workspace.path === binding.workspacePath)) continue
      rows.push({
        id: binding.workspaceId ?? binding.workspacePath,
        path: binding.workspacePath,
        title: binding.workspaceTitle ?? binding.workspacePath,
        sessionIds: [],
      })
    }
    return rows
  }, [data?.workspaces, bindings])

  const [selected, setSelected] = React.useState(null)

  // Keep the selection on something real: a bound workspace first, else the first.
  React.useEffect(() => {
    if (workspaces.length === 0) return
    if (selected !== null && workspaces.some((workspace) => workspace.path === selected)) return
    const bound = workspaces.find((workspace) => bindingsByPath.has(workspace.path))
    setSelected((bound ?? workspaces[0]).path)
  }, [workspaces, bindingsByPath, selected])

  const selectedWorkspace = workspaces.find((workspace) => workspace.path === selected) ?? null
  const selectedBinding = selected === null ? undefined : bindingsByPath.get(selected)
  const activity = data?.activity ?? []

  return (
    <Dialog open={state.open} onOpenChange={(open) => uiStore.set({ open })}>
      <DialogContent
        showCloseButton={false}
        data-dsh-github-push
        data-gp-panel
        aria-label={t("title")}
        className="gp-dialog-panel"
      >
        {/* The popup itself is the one scroller: a native `overflow-y: auto`
            box clamped by `max-height`. The earlier design nested a shadcn
            ScrollArea inside a flex/min-height:0/percentage chain — several
            layered utilities that had to all hold at once, and on a real page
            one of them lost and the dialog simply stopped scrolling. Native
            scrolling has no chain to break: worst case the sticky header
            scrolls away, but the content stays reachable. */}
        <DialogHeader className="gp-dialog-head">
          <DialogTitle className="text-base font-semibold">
            {t("title")}
            <span className="ml-1.5 align-middle text-xs font-normal text-muted-foreground tabular-nums">
              v1.3.0
            </span>
          </DialogTitle>
          <DialogDescription className="text-xs leading-4">{t("subtitle")}</DialogDescription>

          {/* Both corner actions live inside the sticky header so they ride
              it: close at top-4/right-4, refresh one 32px step to its left. */}
          <Button
            variant="ghost"
            size="icon-sm"
            className="gp-refresh"
            data-gp-action="refresh"
            title={t("refresh")}
            aria-label={t("refresh")}
            aria-busy={refreshing}
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            {refreshing ? <Spinner /> : <RefreshCwIcon />}
          </Button>
          <DialogClose
            render={
              <Button variant="ghost" size="icon-sm" className="gp-close" title={t("close")} />
            }
          >
            <XIcon />
            <span className="sr-only">{t("close")}</span>
          </DialogClose>
        </DialogHeader>

        <div className="gp-dialog-body">
          {snapshot.error !== null ? (
            <Alert variant="destructive">
              <AlertDescription>{snapshot.error}</AlertDescription>
            </Alert>
          ) : null}

          {snapshot.loading && data === null ? (
            <LoadingSkeleton t={t} />
          ) : (
            <>
              <div className="grid min-w-0 grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
                <div className="flex min-w-0 flex-col gap-4">
                  <AccountCard t={t} snapshot={data} refresh={refresh} />
                  <WorkspacePicker
                    t={t}
                    workspaces={workspaces}
                    bindingsByPath={bindingsByPath}
                    selected={selected}
                    onSelect={setSelected}
                  />
                </div>

                <div className="flex min-w-0 flex-col gap-4">
                  {selectedWorkspace === null ? null : (
                    <BindingEditor
                      key={selectedWorkspace.path}
                      t={t}
                      workspace={selectedWorkspace}
                      binding={selectedBinding}
                      defaults={data?.defaults ?? { autoPush: true, autoCommit: true }}
                      onChanged={refresh}
                    />
                  )}
                  <ActivityCard t={t} activity={activity} workspacePath={selected ?? ""} />
                </div>
              </div>

              {/* Diagnostic footnote: where the bindings live. It belongs to
                  the plugin, not to the account, so it sits at the bottom of
                  the whole panel. */}
              <p className="m-0 text-xs text-muted-foreground break-all">
                {t("statePath")} {data?.statePath ?? "—"}
              </p>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ======================================================================== */
/* plugin                                                                   */
/* ======================================================================== */

const plugin = {
  inject: ["slots", "locale"],

  /**
   * Inject the compiled stylesheet, register the dictionaries, the sidebar row,
   * the dialog it opens, and the floating commit/push buttons above the
   * composer input. Every resource is owned by `ctx.effect` /
   * `ctx.slots.inject`, so unloading removes all of them.
   */
  apply(ctx) {
    ctx.effect(() => {
      const tag = document.createElement("style")
      tag.setAttribute("data-dsh-plugin", NS)
      tag.textContent = css
      document.head.appendChild(tag)
      return () => tag.remove()
    }, "github-push: styles")

    ctx.effect(() => ctx.locale.register(NS, { zh, en }), "github-push: dictionaries")

    /** Translator for the non-React surfaces (the `/git-push` menu row copy). */
    const t = (() => {
      try {
        return ctx.locale.bind(NS)
      } catch {
        return (key) => key
      }
    })()

    // Sidebar foot: its own full-width row directly above the Settings seat.
    ctx.slots.inject("sidebar.footer.action", () =>
      ctx.slots.register({ name: "sidebar.footer.action", id: "github-push", order: 40 }, (props) => (
        <SidebarAction {...props} ctx={ctx} />
      )),
    )

    // Frame-wide overlay: the dialog that row opens, plus the toast host for
    // the `/git-push` banners (it must live outside the dialog so a push from
    // the menu still reports with the panel closed).
    ctx.slots.inject("shell.overlay", () =>
      ctx.slots.register({ name: "shell.overlay", id: "github-push", order: 50 }, (props) => (
        <SettingsDialog {...props} ctx={ctx} />
      )),
    )
    ctx.slots.inject("shell.overlay", () =>
      ctx.slots.register({ name: "shell.overlay", id: "github-push-toast", order: 60 }, () => <ToastHost />),
    )

    // The `/git-push` slash-menu row. This is the client-command surface
    // (`ctx.commandUi`), not a Host command: it is client-owned, so the menu
    // renders its own localized title ("推送") and the GitHub glyph, and the
    // invocation never enters the message history. A contribution colliding by
    // name with a Host command fails loud, hence the distinct `git-push` name.
    ctx.inject(["commandUi"], (commandCtx) => {
      const commandUi = commandCtx.get("commandUi")
      if (commandUi === undefined || typeof commandUi.register !== "function") return

      commandCtx.effect(
        () =>
          commandUi.register({
            name: "git-push",
            label: () => t("cmdLabel"),
            description: () => t("cmdDesc"),
            icon: GitHubGlyph,
            available: () => true,
            ui: {
              kind: "action",
              run: (session) => {
                // Push over the same RPC the dialog buttons use, with a
                // Harness toast at each turn: one when it starts, one when it
                // settles. A successful push then hands off to `watchCi`,
                // which polls the pushed commit's checks and reports the
                // verdict when it lands. No panel popup — but if the settings
                // panel happens to be open, the `pushTick` bumps re-read the
                // snapshot so fresh rows land without a manual refresh.
                showToast(t("pushStarted"))
                void (async () => {
                  try {
                    const outcome = await callRpc("push.now", { sessionId: session.sessionId })
                    showToast(typeof outcome?.summary === "string" && outcome.summary !== "" ? outcome.summary : t("pushSucceeded"), true)
                    void watchCi(t, session.sessionId)
                  } catch (failure) {
                    showToast(String(failure?.message ?? failure), false)
                  } finally {
                    uiStore.set({ pushTick: uiStore.get().pushTick + 1 })
                  }
                })()
              },
            },
          }),
        "github-push: /git-push menu row",
      )
    })

  },
}

export default plugin
