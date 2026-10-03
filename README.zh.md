# @local/dsh-github-push

一个持久化的 Harness bundle，用于登录 GitHub、把 GitHub 仓库绑定到 DSH 工作区，并把该工作区推送到仓库 —— 包括 **自动推送：每当该工作区的会话执行 `git push` 时，都会自动同步一次**。

- **侧边栏行 + 弹窗** — 左侧边栏里有一整行的 *GitHub 设置 / GitHub Settings*，正好在 Settings 按钮之上。点击后打开插件弹窗：master/detail 布局 —— 左侧栏是账户卡片和工作区选择器（一个 shadcn Select），右侧栏是选中工作区的绑定编辑器，以及推送活动流。
- **`github_push` 工具** — 供 agent 使用的同构操作（`status`, `push`, `bind`, `unbind`, `repos`）。

## 安装

```bash
# bundle 就放在当前目录
dsh plugin --profile <profile> add .
```

或者，在 Harness 会话里通过 Plugin Manager 使用
`action: install_bundle`，`target: <仓库绝对路径>`。

## 登录

在插件弹窗里，三种方式任选其一：

| 方式 | 说明 |
|---|---|
| **Sign in with GitHub** | GitHub OAuth device flow。需要在插件行配置 `clientId`。会打开 `github.com/login/device` 并轮询获取 token。 |
| **Sign in with a token** | 会打开 `github.com/settings/tokens/new`，并预先填好 `repo,read:user` 权限；把生成的 token 粘贴到输入框即可。 |
| **Reuse the gh CLI session** | 复用本机已执行过 `gh auth login` 保存的 `gh auth token`。 |

Token 通过 `ctx.credentials` 存储在引用 `GITHUB_PUSH_TOKEN` 下。
读取时的优先级顺序是：`GITHUB_PUSH_TOKEN`、`GH_TOKEN`、`GITHUB_TOKEN`，最后回退到 `gh` CLI —— 所以只要导出了环境变量，就无需打开弹窗也能一直工作。

登录是 **user-only** 的：agent 工具不会自行认证，也不会接受 token 参数。

## 绑定与推送

弹窗左侧栏用一个 shadcn Select 选择工作区 —— 无论 profile 有多少个工作区，左侧栏高度都保持一致；右侧栏编辑选中工作区的绑定。已绑定的仓库会显示在下拉选项的 label 里（`demo · octocat/hello-world`），因此不用打开编辑器也能看出“当前绑定的是什么”。

每个绑定按规范工作区目录分别存储：

| 字段 | 含义 |
|---|---|
| `owner` / `repo` | 目标 GitHub 仓库。 |
| `branch` | 目标分支；为空时表示使用工作区当前分支（或 `main`）。 |
| `autoPush` | 镜像该工作区会话里的 `git push`（默认开启）。 |
| `autoCommit` | 推送前先提交本地改动，让 push 带上会话的工作（默认开启）。 |
| `configureRemote` | 在工作区里维护一个 `dsh-binding` git remote。 |

推送执行的是 `git push <https url> HEAD:refs/heads/<branch>`。Token 不会出现在 `argv` 里：它通过一次性 `GIT_CONFIG_*` `http.extraHeader` 环境变量传递，并且所有日志信息都会抹掉 token 格式的文本。

### 强制推送（二次确认）

绑定编辑器里有 **强制推送** 按钮，用于覆盖非快进的远端历史。它是破坏性操作，所以需要两步确认：先弹出确认对话框，再勾选「我已了解风险」才会点亮最终按钮。底层使用 `--force-with-lease`，并在推送前先读取远端当前 SHA —— 因此如果在检查与推送之间远端又前进了，它会拒绝而不是悄悄覆盖协作者的新提交。`/git-push` 斜杠命令永远不会强推；强推只能从面板显式发起。

### 推送后验证 CI

推送成功后（无论来自面板还是 `/git-push`），会在后台轮询该提交的 GitHub check-runs。出结果后用 Harness Toast 报告通过/失败，并写入该工作区活动流的 **CI** 标签页。仍在运行的检查保持安静；完全没有 CI 的仓库会在宽限期后静默结束。

绑定数据和推送日志都保存在 `$DSH_HOME/github-push.json`。

## Row 配置

```yaml
- id: github-push
  name: '@local/dsh-github-push'
  config:
    clientId: ''                              # Device flow 用的 OAuth App client id
    apiBase: 'https://api.github.com'         # GitHub REST 地址（也支持 GitHub Enterprise）
    gitBase: 'https://github.com'             # git remote 地址（也支持 GitHub Enterprise）
    autoPushDefault: true
    autoCommitDefault: true
    gitTimeoutMs: 180000
```

这个 bundle 没有声明 `Config` schema，因此 row 的 `config` 会按普通对象读取，所有字段都是可选的。设置 `apiBase` 和 `gitBase` 就可以把插件指向 GitHub Enterprise 主机。

## 实现说明

- **Host 端**（`index.js`）只导入 `node:` 内置模块，因此不需要 profile 安装额外依赖就能解析。它注册了一个 `github_push` 工具、一个在 Connection 认证围墙内的 `POST /api/github-push.rpc` 路由，以及一个用于自动镜像的 `tools/result` 监听器。
- **Client 端**（`client.js`）是**构建产物** —— 不要手工编辑。它由 `client-build` 构建工作区生成，注册了两样东西：`sidebar.footer.action` 行和它打开的 `shell.overlay` 弹窗。

### Client 端使用的是官方 shadcn 组件

`client.js` 里包含的是 shadcn 自己的组件源码，不是仿制品。这些组件通过 **shadcn 官方 CLI** 安装 —— 命令就是 shadcn MCP 为这些 registry items 返回的那条：

```bash
npx shadcn@latest add @shadcn/button @shadcn/card @shadcn/badge @shadcn/input @shadcn/label \
  @shadcn/separator @shadcn/switch @shadcn/spinner @shadcn/alert @shadcn/empty @shadcn/field \
  @shadcn/dialog @shadcn/select @shadcn/scroll-area @shadcn/skeleton @shadcn/item \
  --yes --overwrite --cwd client-build
```

| 部分 | 来源 |
|---|---|
| 组件 | `base-vega` 风格的 `@shadcn` registry —— 你要求用的 **Base UI** 底座 |
| 行为 | `@base-ui/react`（Dialog 的 portal + focus trap + Escape，Select 的 listbox，Switch） |
| 变体 | `shadcn/tailwind.css` 预设（`data-open`、`data-closed`、`data-checked` …） |
| 动效 | `tw-animate-css`（`animate-in`、`fade-in-0`、`zoom-in-95`、`slide-in-from-*`） |
| 类名合并 | `cn` 包（`github.com/shadcn-ui/cn`） |

**没有 style layer。** 当前 Base UI 组件只命名 Tailwind utilities（`bg-popover`、`ring-1`、`size-8`、`h-9`），因此 shadcn 的 `cn-*` recipe 层并不在链里。早期版本确实带了 `cn-*` class，那一层原本要从 `.style-vega { … }` 作用域里拆出来 —— Base UI 会把 dialog 弹窗 portal 到 `document.body`，导致我们没有任何祖先元素能带上这个作用域，每个 recipe 编译出的选择器都匹配不到任何东西，结果是 dialog 曾经完全透明渲染。这个问题现在已经不存在了。

除了 `react`、`react-dom` 和 `react/jsx-runtime` 这三个由 shell 在平台模块表里 seeded 的依赖之外，所有内容都被打包进单一 artifact，因此插件安装时仍然不需要额外依赖。构建方式如下：

```bash
cd client-build
npm install          # 只需执行一次
npm run vendor       # 运行 shadcn CLI，然后执行下面两个 rewrite
npm run css          # tailwind -> dist/shadcn.css
npm run bundle       # esbuild -> ../client.js
node tests/render.mjs
node scripts/check-css.mjs
node tests/verify-vendor.mjs
```

### 构建做了什么改动，以及为什么

shadcn 的组件要在插件里运行，而不是在一个完整应用里运行，有三处改动是不可避免的。每一项都在 `src/styles.css` 里有标记：

1. **Token values 是作用域的，不是全局的。** shadcn 的 `globals.css` 在 `:root` 上声明 `--background`、`--card`、`--radius` …… 如果插件也这么做，就会和 host 以及其它 shadcn-based 插件冲突。因此这里把相同的变量名挂在 `[data-dsh-github-push]` 上，并绑定到 `--dsw-alias-*` token。**这个插件渲染的每一个 Base UI surface 都必须带上这个属性** —— 包括那些被 Base UI *portal* 到组件树外部的元素。dialog 弹窗带上了，`SelectContent` 也带上了：Base UI 把 select 弹窗发到 dialog 的 portal 容器里，而不是 dialog 弹窗本身，所以如果没有这个属性，`bg-popover`、`text-popover-foreground`、`ring-foreground/10` 和 `rounded-md` 都会解析不到值。在真实浏览器里测量过修复前的情况：背景完全透明，`border-radius: 0px`，没有 ring —— 下拉看起来像一个裸的 native list。这两点在 mount test 里都有断言，真实浏览器检查也会测量弹窗的 computed background、radius 和 ring。picker 还传了 `align="start"` + `alignItemWithTrigger={false}`：shadcn 默认把弹窗居中，导致 *选中项* 会覆盖 trigger（native-select 风格），当 trigger 是一个带标签的字段时，菜单看起来会对不齐；菜单必须挂在 trigger 下方，左对齐，宽度和 trigger 一致 —— 在浏览器检查里按像素测量。

2. **`dark:` 永远不会匹配。** Harness 切换主题的方式是替换 `--dsw-*` 值并设置 `color-scheme`；它不会在任何地方加 `.dark` class，因此 shadcn 的 `dark:` 声明是不可达的。所以 token 值同时承载了两个主题，唯一需要 `dark:` 分支的 recipe —— outline button —— 在文件底部用 `.gp-fill` 替代。

3. **和 shadcn part 相关的几何尺寸使用 Tailwind 的 spacing scale。** `top-4` 编译成 `calc(var(--spacing) * 4)`，而不是字面量 16px，因此插件自己的 corner action 也写成 `top: calc(var(--spacing) * 4)` —— 这样 refresh 和 shadcn 的 close 在任何 root font size 下都对齐在同一行。

安装器还需要两个 rewrite，都在 `scripts/codemod.mjs` 里：`"use client"` 是 Next 的指令，需要 stripping；安装器的兄弟导入通过项目的 `ui` alias（`vendor/ui/button`）进行，在扁平目录里变成 `./button`。

还有一条，是因为不导入 preflight（否则会改写 host 自己的 UI）而被迫加上的：**preflight 的 form-control 和 typographic resets 被重复声明、scoped 和 layered。** Tailwind preflight 给 `button`/`input`/`select`/`textarea` 设置 `background-color: transparent`、`color: inherit`、`font: inherit`、`border-radius: 0`，并把 headings 和 paragraphs 的 UA margin 清零。没有这些的话，button 会保留 UA stylesheet —— 一个灰的 `ButtonFace` 背景和黑色 `buttontext`。shadcn 的 ghost button 自己并不设背景（`bg-clip-padding` 只设 `background-clip`），所以 floated close 和 refresh corner action 会渲染成 **带黑色图标的灰色方块**；在 Harness 的深色主题下，图标也会一直是黑色。同样的缺口让 UA 的 `h2 { font-size: 1.5em; margin: .83em 0 }` 能到达 dialog title，`p { margin: 1em 0 }` 能到达 description，这就是旧版 header 变成 ~120px 死空间的原因。这些 resets 放在 `@layer base` 里，因此 `bg-primary` / `text-primary-foreground` / `rounded-md` / `text-base` 仍然能覆盖它们，正如它们覆盖 preflight 一样 —— 包括 `border-transparent`：默认的 `border-color` 也在 base layer 里提供，因为如果不放 layer 里，它会 beat 掉 utility，让每个 ghost button 都有可见边框（已测量）。同时，`--radius-*` scale 被声明为真实变量：`@theme inline` 能让 `rounded-md` 正确内联，但 shadcn 的 icon button 用的是任意值 `rounded-[min(var(--radius-md),10px)]`，Tailwind 不会在任意值内部查找 theme variable —— 所以没有这个声明的话 `min()` 就是无效的，每个 `size-icon-*` button 都会变成方角。

还有两条关于插件自有 surface 的：dialog 是全出血的（dialog 本身不带 padding，header 和滚动 body 负责 inset），因此 scrollbar 落在窗口边缘；sidebar row 复制了 Harness 自己的 Settings-row 几何，带一条 `:has()` 规则让它独占一行。

### 弹窗是响应式的

shadcn 的弹窗是 `grid w-full max-w-md gap-6 p-6`，**没有高度限制**，而 Harness shell 自己也没有宽度断点，因此 shipped recipe 在手机宽度下不可用：

- 弹窗会随内容长高，窄屏下卡片会堆得比视口还高，`top-1/2 -translate-y-1/2` 会把一个两端都溢出的框垂直居中 —— floated close 按钮会跑到视口上边缘之上，卡片 footer 跑到下边缘之下，而且没有任何东西能触达它们，因为弹窗是 `fixed` 的，遮罩背后的页面不会滚动；
- `max-w-md` 是桌面端上限，弹窗自己的 `p-6` 会和 header / body 已经带上的 inset 叠加成双重内边距。

`.gp-dialog-panel` 因此把高度限制在视口内（`height: fit-content` + `max-height: calc(100dvh - 2rem)`，不支持 `dvh` 的引擎退回 `vh`），把桌面端宽度上限扩大到 `min(1040px, 100vw - 2rem)`，让 300px 左侧栏和编辑器列能并排，把弹窗变成 flex column，并去掉弹窗的 padding 和 gap。它还去掉了 shadcn 的 *居中*：`inset: 1rem` + `margin: auto` + `translate: none` 让框居中但没有 transform  altogether，因为 iOS WebKit 对带 transform 的 `fixed` 元素的 touch hit-test 有偏移问题（见下文）。

这个组合是 shadcn 自己的 part + Tailwind 响应式 utilities，因为弹窗是 `fixed` 的，所以视口断点精确描述它的宽度：

| 宽度 | 变化 |
|---|---|
| base（手机） | 单列，阅读顺序：account、workspace picker、editor、activity；card footer 换行；header `p-4 pr-24` |
| `sm:` | header `p-6` |
| `lg:` | master/detail：`lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]` —— 左侧栏（account + workspace picker）和右侧栏（editor + activity）并排 |

Scroller 就是**弹窗本身**：一个被 `max-height` 限制的原生 `overflow-y: auto` 框，带 `overscroll-behavior: contain` 和显式的 `touch-action: pan-y`。Header 在这个 scrollport 里是 `position: sticky`，用弹窗自己的 `--popover` surface 绘制，因此标题和两个 corner button 在 body 滚动时仍然留在屏幕上。早期版本在 flex-column + `min-height: 0` + percentage-height chain 里用了 shadcn 的 **ScrollArea** —— 这个链上的每一层都是一个 layered utility，在真实页面上某一层会在级联里输掉，导致 dialog 在桌面和 touch 上都停止滚动（隔离检查却仍然通过）。Native scrolling 没有链会断：最差情况是 sticky header 滚走，但内容总是可达的。Activity feed 是 shadcn 的 **Item** 行，`size="xs"` —— status dot、repository（或 trigger）、一行截断的 message、相对 timestamp，超过 30 天退回日期；长历史被 "show all" toggle 折叠；loading 状态用 shadcn 的 **Skeleton**，形状和真实 grid 一致，避免跳动。

为什么用弹窗自身而不是 Base UI 的 ScrollArea，记录一下症状：ScrollArea 的 viewport 是 `height: 100%`，它解析为 ScrollArea root 的高度 —— 而那个高度来自 auto-height column 里的 flex，因此是 *indefinite* 的，percentage 会退化成 `auto`。viewport 于是长到它的内容，并溢出 clipping root：测量过，一个 638px 的 root 装着 1624px 的 viewport，`scrollHeight === clientHeight`，不可滚动，dialog 底部直接被切掉。补丁（root 作为 flex column，viewport 作为可 shrink 的 flexible child）在隔离状态下有效，但完整链 —— 弹窗 flex column -> wrapper `flex-1 min-h-0` -> ScrollArea `flex-1 min-h-0` -> override rules —— 依赖几层 layered utilities 同时赢下级联，在真实页面上某一层没有赢：dialog 在桌面和 touch 上都停止滚动，而每个隔离检查都仍然通过。现在 frame 只用一种机制 —— fixed 弹窗自己的 `overflow-y: auto` —— sticky header 就是普通 `position: sticky`。两点都在 mount test 里断言，真实浏览器检查也会测量。

### 弹窗在手机上可以通过 touch 滚动

四只在桌面检查下藏着的 phone-only bug（鼠标滚轮能在手指不能滚的时候滚动），现在全部修复并通过真实 touch event 回归测试：

- **遮罩的 `backdrop-filter` 吞掉了手指。** iOS WebKit 不会把 touch panning 传给一个盖在 full-bleed `backdrop-filter` 元素上的 fixed dialog —— wheel 能用，手指没反应。插件为自己的遮罩去掉了 blur（`div:has(> [data-gp-panel]) > [data-slot="dialog-overlay"]`）；dim 保留。
- **`fixed` 弹窗上的 transform 在 iOS WebKit 上会偏移自己的 touch hit-test** —— URL bar 折叠后，touch 落到的位置和框的位置不一致。Frame 用 `inset` + `margin: auto` 居中，并用 `translate: none` 覆盖 shadcn 的 `-translate-*` utilities，因此弹窗完全不带 transform。
- **没有 `dvh` 的引擎上 `vh` 是 LARGE viewport**（ older WebView / XWeb，比如 WeChat；Edge on iOS 是 WebKit 并且有 `dvh`，Edge on Android 是 Chromium 也有）。一个被限制在 `100vh - 2rem` 并垂直居中的弹窗，两端都会超出可见区域 —— 底部躲在浏览器 UI 后面，顶部也触不到。在 `@supports not (height: 100dvh)` 下，弹窗改为锚定到顶部（`margin: 0 auto`）；现代引擎保留 `dvh` 居中。
- **弹窗自己的 scrollport 设置了 `overscroll-behavior: contain` 和 `touch-action: pan-y`**，因此到达内容末尾的 pan 不会链式传递给外层不可滚动的祖先被取消，垂直手势也被显式命名给 WebKit。

头像的回退逻辑和渲染逻辑一致：`avatars.githubusercontent.com` 从移动网络经常不可达，而 API 本身可能正常工作，因此照片的 `onError` 会在 broken-image icon 和 GitHub mark circle 之间切换（并且不发送 referrer）。

### 已知外观问题

shadcn v4 针对 React 19，其中 function component 可以把 `ref` 当 prop 接收。Harness 提供的是 **React 18.3**，因此 Base UI 的 `Close` 渲染 shadcn 的 `Button` 时会打印 `Function components cannot be given refs`。按钮仍然能关闭弹窗 —— mount test 断言了这一点 —— 所以这只是 console warning，不是行为损失。

同样的限制导致无法给 icon-only refresh button 用 shadcn **Tooltip**：Base UI 的 `render` prop 会附加 ref，shadcn 的 Button 是普通 function component，因此 ref 丢失，弹窗永远不会打开（在决定之前用独立 probe 验证过）。这个按钮保留 `title` + `aria-label`。

## 验证

```bash
node tests/host-smoke.mjs   # Host 端针对假 Cordis context
node tests/push-engine.mjs  # 真实 `git push` 到本地 bare repos
cd client-build
node tests/render.mjs        # 构建好的 Client 端，mount 到真实 DOM
node scripts/check-css.mjs   # 每个命名的 class 都在编译后的 CSS 里定义
node tests/verify-vendor.mjs # 文件和全新官方安装逐字节一致
```

- **Host smoke test** — 把 `apply` mount 到假 Cordis context，驱动 RPC 路由：status、bind 校验、session -> workspace 解析、工具自身的 `execute`、mirror listener、unbind、持久化。
- **Push-engine 端到端测试** — 把 `gitBase` 指向本地 bare 仓库目录，运行真实的 `git push`：首次推送、auto-commit 携带未提交工作、`dsh-binding` remote 配置、分支解析、non-fast-forward hint、消息和状态文件里的凭证脱敏、`configureRemote: false`，以及 session-push mirror 复用同一引擎。
- **Client mount test** — 把构建好的 artifact 加载进 jsdom，配上真实的 `react` + `react-dom/client`，按真实用户操作驱动：点击侧边栏行，断言 dialog 通过 Base UI 的 portal mount，带有 shadcn 的 `data-slot` parts，检查官方 Card/Field/FieldGroup/Switch/Badge/Separator/Item，确认 workspace picker 是 Base UI 的 listbox（没有 `<select>` 元素），打开它 portal 出一个带 token scope 的弹窗，每个 workspace 一个 option，选择 option 会移动 editor，然后用 **Escape** 和 **shadcn 的 X button** 关闭。它还断言一条能匹配弹窗的规则会绘制它的 surface（reachability guard，带一个自测试：guard 会拒绝弹窗无法匹配的规则），每个 token 都能解析到 `--dsw-alias-*`，UA heading margins 在插件作用域内被 reset，refresh 和 close 的偏移量对齐在同一行。它的 **responsive** 部分把 bug 作为 shadcn 自己 recipe 的事实来断言（根本没有 `max-height`），然后断言 frame 的修复 —— 弹窗被 `max-height` 限制，成为原生 scrollport（`overflow: hidden auto`、`overscroll-behavior: contain`、`touch-action: pan-y`），无 transform 居中（`inset` + `margin: auto` + `translate: none`），header sticky 带 opaque background，两个 corner actions 都在 header 里 —— 以及 frame 的规则是 unlayered 的，因此能赢过 utilities layer。
- **Coverage check** — `node scripts/check-css.mjs` 证明 vendored 组件和插件命名的每个 class 都在编译后的样式表里定义了（一个静默缺失的 Tailwind utility 就是真实视觉 bug）。
- **Provenance check** — `node tests/verify-vendor.mjs` 用相同的 `components.json` 起一个临时项目，再次运行官方安装器，应用共享 codemod，然后 diff。字节一致意味着 `vendor/ui/` 就是 registry 输出加上那个 codemod，没有别的东西。（它也 mirror `src/styles.css`，因为安装器会读它来决定注入哪些 font classes。）
- **真实浏览器布局检查** — `npm run browser` 把构建好的 artifact 加载进 Chromium，用相同的 module table、相同的样式表和模拟 Harness tokens，在 1280×800、768×1024、390×844 和 390×500 下测量真实几何：弹窗和视口的关系、computed `overflow-y` / `overscroll` / `touch-action` / `translate`、弹窗是否真的能滚动到底、最后一行是否可达、sticky header 在最后是否仍然 pinned。它还打开 workspace picker，检查 portaled 弹窗的 computed background、radius 和 ring，列出每个 workspace，确认选择 option 会移动 editor —— 并检查 corner 和 footer buttons 是否存在上面描述的 UA-stylesheet leakage。最后一步 **touch pass** 在 390×668 的 `hasTouch` 视口下打开弹窗，驱动真实的 `Input.dispatchTouchEvent` swipe：弹窗必须适配视口且不带 transform，遮罩不能有 `backdrop-filter`，弹窗是原生 scrollport 并且 `contain` 住 pan，手指必须真的能滚动内容，sticky header 在最后仍然 pinned。截图放在 `.browser/`。这个检查捕捉的是 jsdom 无法捕捉的东西：ghost-button border、heading-margin 和 touch-scrolling bug 都是这样被发现和确认修复的。

最后的视觉确认留给人工作业 —— 上面的自动化检查覆盖结构、来源和布局几何，不覆盖最终观感。
