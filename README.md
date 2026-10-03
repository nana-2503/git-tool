# @local/dsh-github-push

A persistent Harness bundle that signs in to GitHub, binds a GitHub repository to a DSH
workspace, and pushes that workspace there — including **automatically, every time a
session in that workspace runs `git push`**.

- **Sidebar row + modal** — a full-width *GitHub 设置 / GitHub Settings* row in the left
  sidebar, on its own line directly above the Settings button. It opens the plugin modal: a
  master/detail layout — the left rail holds the account card and the workspace picker (a
  shadcn Select), the right column holds the binding editor for the selected workspace and
  the push-activity feed.
- **`github_push` tool** — the same operations for the agent (`status`, `push`, `bind`,
  `unbind`, `repos`).

## Install

```bash
# the bundle lives in this directory
dsh plugin --profile <profile> add .
```

Or, from a Harness session, use the Plugin Manager with
`action: install_bundle` and `target: <仓库绝对路径>`.

## Sign in

Any one of these, from the plugin modal:

| Path | What happens |
|---|---|
| **Sign in with GitHub** | GitHub OAuth device flow. Needs `clientId` on the plugin row. Opens `github.com/login/device` and polls for the token. |
| **Sign in with a token** | A link opens `github.com/settings/tokens/new` pre-filled with the `repo,read:user` scopes; paste the result into the field. |
| **Reuse the gh CLI session** | Reuses `gh auth token` when this machine already ran `gh auth login`. |

The token is stored through `ctx.credentials` at the reference `GITHUB_PUSH_TOKEN`.
Resolution order for reads is `GITHUB_PUSH_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, then the
`gh` CLI — so an exported variable keeps working without ever touching the modal.

Signing in is **user-only**: the agent tool never authenticates and never accepts a token
argument.

## Bind and push

The modal's left rail picks the workspace with one shadcn Select — the rail stays the same
height however many workspaces the profile has — and the editor column edits the selected
one; the bound repository rides in the option label (`demo · octocat/hello-world`), so the
dropdown still answers "what is bound" without opening the editor. Each binding is stored
per canonical workspace directory:

| Field | Meaning |
|---|---|
| `owner` / `repo` | Target GitHub repository. |
| `branch` | Destination branch; empty means the workspace's current branch (or `main`). |
| `autoPush` | Mirror `git push` from a session in this workspace (default on). |
| `autoCommit` | Commit local changes before pushing, so the push carries the session's work (default on). |
| `configureRemote` | Maintain a `dsh-binding` git remote in the workspace. |

Push runs `git push <https url> HEAD:refs/heads/<branch>`. The token never reaches `argv`:
it travels as a one-shot `GIT_CONFIG_*` `http.extraHeader` environment variable, and every
message is scrubbed of token-shaped text.

### Force push (double-confirmed)

The binding editor has a **Force push** button that overwrites a non-fast-forward remote
history. It is destructive, so it takes two steps: the confirmation dialog, then an
"understand the risk" checkbox that gates the final button. Under the hood it pushes with
`--force-with-lease`, reading the remote's current SHA first — so it still refuses if the
remote moved between that check and the push, rather than silently clobbering a collaborator's
fresh commits. The `/git-push` slash command never forces; force is only ever explicit from the panel.

### CI verification after push

A successful push (from the panel or `/git-push`) starts a background poll of the pushed
commit's GitHub check-runs. When they settle, a Harness toast reports pass/fail and the result
is appended to the workspace's activity feed (the **CI** tab). Checks that are still running stay
silent, and a repository with no CI at all ends quietly after a grace window.

Bindings and the push log live in `$DSH_HOME/github-push.json`.

## Row config

```yaml
- id: github-push
  name: '@local/dsh-github-push'
  config:
    clientId: ''                              # OAuth App client id for the device flow
    apiBase: 'https://api.github.com'         # GitHub REST base (GitHub Enterprise too)
    gitBase: 'https://github.com'             # git remote base (GitHub Enterprise too)
    autoPushDefault: true
    autoCommitDefault: true
    gitTimeoutMs: 180000
```

The bundle declares no `Config` schema, so the row's `config` is read as a plain object and
every field is optional. Setting `apiBase` and `gitBase` points the plugin at a GitHub
Enterprise host.

## Implementation notes

- **Host half** (`index.js`) imports only `node:` builtins, so it resolves from any profile
  without profile-installed dependencies. It registers one `github_push` tool, one
  `POST /api/github-push.rpc` route inside Connection's authentication fence, and one
  `tools/result` listener for the automatic mirror.
- **Client half** (`client.js`) is a **built artifact** — do not edit it by hand. It is
  produced by the build workspace in `client-build` and registers two things: the
  `sidebar.footer.action` row and the `shell.overlay` dialog it opens.

### The Client half is the official shadcn components

`client.js` contains shadcn's own component code, not a lookalike. The components are
installed by **shadcn's own CLI** — the command the shadcn MCP returns for these registry
items:

```bash
npx shadcn@latest add @shadcn/button @shadcn/card @shadcn/badge @shadcn/input @shadcn/label \
  @shadcn/separator @shadcn/switch @shadcn/spinner @shadcn/alert @shadcn/empty @shadcn/field \
  @shadcn/dialog @shadcn/select @shadcn/scroll-area @shadcn/skeleton @shadcn/item \
  --yes --overwrite --cwd client-build
```

| Piece | Where it comes from |
|---|---|
| Components | the `base-vega` style of the `@shadcn` registry — the **Base UI** base, as asked for |
| Behaviour | `@base-ui/react` (Dialog portals + focus trap + Escape, the Select listbox, Switch) |
| Variants | the `shadcn/tailwind.css` preset (`data-open`, `data-closed`, `data-checked` …) |
| Motion | `tw-animate-css` (`animate-in`, `fade-in-0`, `zoom-in-95`, `slide-in-from-*`) |
| Class merging | the `cn` package (`github.com/shadcn-ui/cn`) |

**There is no style layer.** The current Base UI components name only Tailwind utilities
(`bg-popover`, `ring-1`, `size-8`, `h-9`), so shadcn's `cn-*` recipe layer is not part of the
chain at all. An earlier revision of these components did carry `cn-*` classes, and that layer
had to be unwrapped from its `.style-vega { … }` scope — Base UI portals the dialog popup into
`document.body`, so no ancestor of ours could carry the scope and every recipe compiled to a
selector that matched nothing, which is how the dialog once rendered with no background at
all. That whole failure mode is gone.

Everything except `react`, `react-dom` and `react/jsx-runtime` — which the shell seeds in its
platform module table — is bundled into the single artifact, so the plugin still installs with
no dependencies. Build it with:

```bash
cd client-build
npm install          # once
npm run vendor       # the shadcn CLI, then the two rewrites below
npm run css          # tailwind -> dist/shadcn.css
npm run bundle       # esbuild -> ../client.js
node tests/render.mjs
node scripts/check-css.mjs
node tests/verify-vendor.mjs
```

### What the build changes, and why

Three adaptations are unavoidable when shadcn's components run inside a plugin rather than
in an application. Each is marked in `src/styles.css`:

1. **Token values are scoped, not global.** shadcn's `globals.css` declares `--background`,
   `--card`, `--radius`, … on `:root`. A plugin that did the same would fight the host and
   every other shadcn-based plugin, so the same variable *names* live on
   `[data-dsh-github-push]` and are bound to `--dsw-alias-*` tokens. **Every Base UI surface
   this plugin renders must carry that attribute** — including the ones Base UI *portals*
   out of the tree. The dialog popup carries it, and so does `SelectContent`: Base UI sends
   the select popup into the dialog's portal container rather than into the dialog popup,
   so without the attribute `bg-popover`, `text-popover-foreground`, `ring-foreground/10`
   and `rounded-md` all resolve to nothing. Measured in a real browser before the fix: a
   fully transparent background, `border-radius: 0px`, no ring — the dropdown looked like a
   bare native list. Both are asserted in the mount test, and the real-browser check
   measures the popup's computed background, radius and ring. The picker also passes
   `align="start"` + `alignItemWithTrigger={false}`: shadcn's default centres the popup so
   the *selected option* overlays the trigger (native-select style), which reads as a
   misaligned menu when the trigger is a labelled field; the menu must hang below it,
   left-aligned and at the trigger's width — measured to the pixel in the browser check.
2. **`dark:` never matches.** The Harness switches themes by swapping `--dsw-*` values and
   setting `color-scheme`; it puts no `.dark` class anywhere, so shadcn's `dark:`
   declarations are unreachable. The token values therefore carry both themes, and the one
   recipe that needs its `dark:` branch — the outline button — is substituted with
   `.gp-fill` at the bottom of the file.
3. **Geometry that meets a shadcn part uses Tailwind's spacing scale.**
   `top-4` compiles to `calc(var(--spacing) * 4)`, not a literal 16px, so the plugin's
   corner action is written `top: calc(var(--spacing) * 4)` too — the refresh and shadcn's
   close then share a line at any root font size.

Two rewrites the installer needs, both in `scripts/codemod.mjs`: `"use client"` is a Next
directive and is stripped, and the installer's sibling imports go through this project's `ui`
alias (`vendor/ui/button`), which becomes `./button` in one flat directory.

One more, forced by not importing preflight (which would rewrite the host's own UI):
**preflight's form-control and typographic resets are repeated, scoped and layered.**
Tailwind's preflight gives `button`/`input`/`select`/`textarea` `background-color: transparent`,
`color: inherit`, `font: inherit` and `border-radius: 0`, and zeroes the UA margins on headings
and paragraphs. Without them a button keeps the UA stylesheet — a grey `ButtonFace` background
and black `buttontext`. shadcn's ghost buttons set no background of their own (`bg-clip-padding`
only sets `background-clip`), so the floated close and the refresh corner action rendered as
**grey squares with black icons**, and in the Harness's dark theme those icons would have stayed
black. The same gap let the UA `h2 { font-size: 1.5em; margin: .83em 0 }` reach the dialog title
and `p { margin: 1em 0 }` the description, which is what made the old header a ~120px band of
dead space. The resets live in `@layer base`, so `bg-primary` / `text-primary-foreground` /
`rounded-md` / `text-base` still outrank them, exactly as they outrank preflight — including
`border-transparent`: the default `border-color` is supplied from the base layer too, because an
unlayered one would beat the utility and give every ghost button a visible border (measured).
Alongside them, the `--radius-*` scale is declared as real variables:
`@theme inline` inlines `rounded-md` correctly, but shadcn's icon buttons use the arbitrary
value `rounded-[min(var(--radius-md),10px)]`, and Tailwind does not look inside an arbitrary
value for a theme variable — so without the declaration that `min()` is invalid and every
`size-icon-*` button gets square corners.

Two more, for the plugin's own surfaces: the dialog is full-bleed (the dialog contributes no
padding, the header and scrolling body carry the insets) so the scrollbar lands on the window
edge; and the sidebar row copies the Harness's own Settings-row geometry, with one
`:has()` rule to give it a line of its own.

### The dialog is responsive

shadcn's popup is `grid w-full max-w-md gap-6 p-6` with **no height limit**, and the Harness
shell has no width breakpoints of its own, so the shipped recipe is not usable at phone width:

- the popup grows to its content, so on a narrow screen the cards stack taller than the
  viewport and `top-1/2 -translate-y-1/2` centres a box overflowing both ends — the floated
  close button ends up **above the top edge** and the card footers below the bottom edge,
  with nothing able to reach them, because the popup is `fixed` and the page behind the
  overlay does not scroll;
- `max-w-md` is a desktop cap, and the popup's own `p-6` would double the insets the header
  and body already carry.

`.gp-dialog-panel` therefore bounds the height by the viewport (`height: fit-content` +
`max-height: calc(100dvh - 2rem)`, with a `vh` base for engines without `dvh`), widens the
desktop cap to `min(1040px, 100vw - 2rem)` so the 300px rail and the editor column fit side
by side, makes the panel a flex column, and drops the popup's padding and gap. It also drops
shadcn's *centring*: `inset: 1rem` + `margin: auto` + `translate: none` centre the box with
no transform at all, because iOS WebKit mis-hits touches on a `fixed` element that carries
one (see below).

The composition is shadcn's own parts with Tailwind's responsive utilities, and because the
popup is `fixed` the viewport breakpoints describe its width exactly:

| Width | What changes |
|---|---|
| base (phone) | one column, in reading order: account, workspace picker, editor, activity; the card footer wraps; header `p-4 pr-24` |
| `sm:` | header `p-6` |
| `lg:` | master/detail: `lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]` — the rail (account + workspace picker) beside the editor + activity column |

The scroller is the **popup itself**: one native `overflow-y: auto` box clamped by
`max-height`, with `overscroll-behavior: contain` and an explicit `touch-action: pan-y`.
The header is `position: sticky` inside that scrollport and painted with the popup's own
`--popover` surface, so the title and both corner buttons stay on screen while the body
scrolls under them. An earlier revision used shadcn's **ScrollArea** inside a
flex-column + `min-height: 0` + percentage-height chain — every link of that chain was a
layered utility, and on a live page one of them lost its cascade and the dialog stopped
scrolling on desktop and touch alike (the same code measured scrollable in isolation).
Native scrolling has no chain to break: worst case the sticky header scrolls away, but the
content always stays reachable. The activity feed is shadcn's **Item** rows at `size="xs"` —
status dot, repository (or trigger), one truncated message line, and a relative timestamp
that falls back to a date past 30 days — with long histories collapsed behind a "show all"
toggle; the loading state uses shadcn's **Skeleton**, shaped like the real grid so nothing
jumps.

Why the popup itself and not Base UI's ScrollArea, recorded because the symptom was silent:
ScrollArea's viewport is `height: 100%`, which resolves against the ScrollArea root's height —
and that height comes from flex inside an auto-height column, so it is *indefinite* and the
percentage degrades to `auto`. The viewport then grows to its content and overflows the
clipping root: measured, a 638px root holding a 1624px viewport with
`scrollHeight === clientHeight`, nothing scrollable, and the bottom of the dialog simply cut
off. Patching that (root as flex column, viewport as its shrinkable flexible child) worked in
isolation, but the full chain — popup flex column → wrapper `flex-1 min-h-0` → ScrollArea
`flex-1 min-h-0` → override rules — depended on several *layered* utilities all winning their
cascades at once, and on a live page one of them did not: the dialog stopped scrolling on
desktop and touch alike while every isolated check still passed. The frame now uses exactly
one mechanism — the fixed popup's own `overflow-y: auto` — and the sticky header is plain
`position: sticky`. Both are asserted in the mount test and measured in the real-browser
check.

### The dialog is scrollable by touch, on phones

Four phone-only bugs hid behind the desktop checks (a mouse wheel scrolls even when a
finger cannot), and all four are now fixed and regression-tested with real touch events:

- **The overlay's `backdrop-filter` swallowed the finger.** iOS WebKit does not deliver
  touch panning to a fixed dialog that sits over a full-bleed `backdrop-filter` element —
  the wheel works, the finger does nothing. The plugin drops the blur for its own overlay
  (`div:has(> [data-gp-panel]) > [data-slot="dialog-overlay"]`); the dim stays.
- **A transform on the `fixed` popup offsets its own touch hit-tests** on iOS WebKit once
  the URL bar collapses — touches land where the box is not. The frame centres with
  `inset` + `margin: auto` and writes `translate: none` over shadcn's `-translate-*`
  utilities, so the popup carries no transform at all.
- **`vh` is the LARGE viewport on engines without `dvh`** (older WebView/XWeb, e.g. WeChat;
  Edge on iOS is WebKit and has `dvh`, Edge on Android is Chromium and has it too).
  A popup clamped to `100vh - 2rem` and centred vertically then hangs past the visible
  area at both ends — the bottom hides behind the browser UI and the top cannot be reached.
  Under `@supports not (height: 100dvh)` the popup anchors to the top instead (`margin:
  0 auto`); modern engines keep `dvh` centring.
- **The popup's own scrollport sets `overscroll-behavior: contain` and `touch-action: pan-y`**,
  so a pan that reaches the end of the dialog's content cannot chain outward and be cancelled
  by an unscrollable ancestor, and the vertical gesture is named explicitly for WebKit.

The avatar falls back the same way it renders: `avatars.githubusercontent.com` is often
unreachable from mobile networks even while the API itself works, so the photo's `onError`
swaps it for the GitHub-mark circle instead of a broken-image icon (and it sends no
referrer).

### Known cosmetic issue

shadcn v4 targets React 19, where a function component accepts `ref` as a prop. The Harness
seeds **React 18.3**, so Base UI's `Close` rendering shadcn's `Button` logs
`Function components cannot be given refs`. The button still dismisses the dialog — the
mount test asserts it — so this is a console warning, not a behaviour loss.

The same limitation rules out a shadcn **Tooltip** for the icon-only refresh button: Base UI's
`render` prop attaches a ref, shadcn's Button is a plain function component, so the ref is
lost and the popup never opens (verified with a standalone probe before deciding). The button
keeps `title` + `aria-label` instead.

## Verification

```bash
node tests/host-smoke.mjs   # Host half against a fake Cordis context
node tests/push-engine.mjs  # real `git push` into local bare repos
cd client-build
node tests/render.mjs        # the built Client half, mounted in a real DOM
node scripts/check-css.mjs   # every named class is defined in the compiled CSS
node tests/verify-vendor.mjs # the files match a fresh official install, byte for byte
```

- **Host smoke test** — mounts `apply` against a fake Cordis context and drives the RPC
  route: status, bind validation, session→workspace resolution, the tool's own `execute`,
  the mirror listener, unbind, and persistence.
- **Push-engine end-to-end test** — points `gitBase` at a local directory of bare
  repositories and runs real `git push`es: first push, auto-commit carrying uncommitted
  work, `dsh-binding` remote configuration, branch resolution, the non-fast-forward hint,
  credential redaction in both messages and the state file, `configureRemote: false`, and
  the session-push mirror reusing the same engine.
- **Client mount test** — loads the built artifact into jsdom with real `react` +
  `react-dom/client`, and drives it the way a person does: it clicks the sidebar row,
  asserts the dialog mounts through Base UI's portal with shadcn's `data-slot` parts,
  checks the official Card/Field/FieldGroup/Switch/Badge/Separator/Item, confirms
  the workspace picker is Base UI's listbox (no `<select>` element), that opening it portals
  a popup carrying the token scope with one option per workspace, and that choosing an
  option moves the editor, then closes
  with **Escape** and with **shadcn's X button**. It also asserts that a rule which
  *matches* the popup paints its surface (the reachability guard, with a self-test that the
  guard rejects a rule the popup cannot match), that every token resolves to a
  `--dsw-alias-*`, that the UA heading margins are reset inside the plugin scope, and that
  the refresh and close offsets agree on one line. Its
  **responsive** section states the bug as a fact about shadcn's own recipe (no `max-height`
  at all), then asserts the frame's fix — popup bounded by `max-height`, made the native
  scrollport (`overflow: hidden auto`, `overscroll-behavior: contain`, `touch-action: pan-y`),
  centred transform-free (`inset` + `margin: auto` + `translate: none`), header sticky with an
  opaque background and both corner actions inside it — and that the frame's rules are
  unlayered so they outrank the utilities layer.
- **Coverage check** — `node scripts/check-css.mjs` proves every class the vendored
  components and the plugin name is defined in the compiled stylesheet (a silently missing
  Tailwind utility is a real visual bug).
- **Provenance check** — `node tests/verify-vendor.mjs` stands up a throwaway project with
  the same `components.json`, runs the official installer again, applies the shared codemod,
  and diffs. Identical bytes mean `vendor/ui/` is the registry output plus that codemod and
  nothing else. (It mirrors `src/styles.css` too, because the installer reads it to decide
  which font classes to inject.)
- **Real-browser layout check** — `npm run browser` loads the built artifact into Chromium
  with the same module table, the same stylesheet and emulated Harness tokens, and measures
  the actual geometry at 1280×800, 768×1024, 390×844 and 390×500: the popup against the
  viewport, its computed `overflow-y`/`overscroll`/`touch-action`/`translate`, whether the
  popup really scrolls to its end, whether the last row is reachable, and whether the sticky
  header is still pinned at the end. It also opens the
  workspace picker and checks the portaled popup's computed background, radius and ring,
  lists every workspace, and confirms choosing an option moves the editor — and checks the
  corner and footer buttons for the UA-stylesheet leakage described above. A final
  **touch pass** opens the dialog on a 390×668 `hasTouch` viewport and drives a real
  `Input.dispatchTouchEvent` swipe: the popup must fit the viewport and carry no transform,
  the overlay must have no `backdrop-filter`, the popup must be the native scrollport and
  `contain` the pan, the finger must actually scroll the content, and the sticky header must
  still be pinned at the end. Screenshots land in `.browser/`. This is the check that catches
  what jsdom cannot: it is how the ghost-button border, heading-margin and touch-scrolling
  bugs were all found and confirmed fixed.

Visual confirmation in the browser is the remaining manual step — the automated checks above
cover structure, provenance and layout geometry, not the final look.
