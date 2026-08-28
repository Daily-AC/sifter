# sifter

[English](./README.md)

资源帖到处都是，但基本没法用。

X 上有人列了十五个值得收藏的网站，你把帖子存下来。两个月后你需要其中一个，
却想不起来是哪条帖子；四个链接已经死了；三个其实是同一个站的不同域名；而真正
会用到这些资源的编码 agent，根本看不见它们。

`sifter` 把这些散落的帖子和书签夹变成一份索引：跨来源去重、验活、用站点自己的
话描述、并且能通过 MCP 被 agent 检索。

```
$ sifter add https://x.com/someone/status/2092937412490260513
  + beautifului.dev
  + beui.dev
  + rareui.com
  + transitions.dev
  + ui.shadcn.com

$ sifter refresh
  ● beautifului.dev    Beautiful UI — Crafted primitives for AI-native interfaces
  ● rareui.com         Rare UI — Rare Animated React Components
  ⇢ godly.website merged into recent.design

$ sifter search "动画组件"
● Rare UI — Rare Animated React Components
  https://rareui.com/
  A free, open-source registry of rare animated React components...
  2 sources · 审美 设计相关
```

索引可以直接浏览：**[sifter.z10.dev](https://sifter.z10.dev)**（大陆访问走
[sifter.lab.z10.dev](https://sifter.lab.z10.dev) 更快）。页面里的检索跑的就是 CLI 那份
`search.mjs`——构建时原样拷过去，不是重写一遍。

## 和 awesome-list 有什么不同

awesome-list 是一个人手工编辑的文本文件。它会无声地烂掉：链接失效、网站改名、
同一个工具出现在三个小节里，而那句描述是提交者 2021 年随手写的。

sifter 的每一行都是推导出来的，所以这些不会累积。

**它会合并本来就是同一个东西的条目。** `www.beautifului.dev` 和
`beautifului.dev` 是一条。`zh.z-library.sk` 和 `z-library.sk` 也是。
`godly.website` 和 `recent.design` 同样是——因为前者现在会跳转到后者，这次改名
会在下一轮 refresh 被发现，而两个名字都还能搜到。

**它知道什么还活着，并且不在这件事上撒谎。** 最直觉的写法是判断 HTTP 200，其余
一律算死。拿真实的资源链接一测就知道这会删掉能用的站：最先测的九个里有两个返回
403，只是因为 Cloudflare 不喜欢机器人。所以 `blocked` 是独立的一档，既不是
`alive` 也不是 `dead`。

**它用站点自己的话来描述它。** 帖子说"Rare UI —— 最好的动画组件"，站点自己的
标题是"Rare UI — Rare Animated React Components"，meta 描述里写清了它用什么技术
栈。索引按后者检索，把前者作为出处留着——于是你能同时看到"别人宣称的"和"实际
是什么"。

**它统计交叉印证。** 同一个站既来自帖子又来自你的书签，这件事会被记下来——
`2 sources`。多个互相独立的人指向同一个东西，是比 star 数更好的信号，而任何手写
清单都没有这个数据。

**agent 能直接查它。** 这是 awesome-list 结构上做不到的：5000 行的 README 只能
整篇读进上下文，而 MCP server 面对"animated react components"会返回八条排好序的
结果。

## 安装

```sh
npx @z10/sifter search "design inspiration"    # 什么都不用装
```

这在一台干净机器上就能跑：仓库自带一份已验活的索引，所以你敲的第一条命令就有
结果，而不是面对一个空库。

想攒自己的库就 clone：

```sh
git clone https://github.com/Daily-AC/sifter && cd sifter
./bin/sifter.mjs --help
```

Node 20+。零依赖、不需要 API key、没有常驻服务。

## 采集

**从帖子采。** 不需要登录、不需要 API key——sifter 走公开通道读帖子，并且优先用
返回完整正文的那条通道：

```sh
sifter add https://x.com/user/status/123456789
sifter add https://x.com/user/status/123 https://example.com/some-tool
```

> 官方 syndication 接口会截断长帖。在催生这个项目的那条帖子上，它只返回了 341 个
> 字符中的 176 个、5 个链接中的 2 个——后三个网站会就这样无声地不存在。sifter 按
> 顺序尝试多条通道，优先采信返回完整答案的那条。

**从书签采。** sifter 只读**你点名的那一个文件夹**，拒绝遍历整棵书签树：

```sh
sifter chrome --list                        # 有哪些文件夹
sifter chrome --folder "审美 设计相关" --tag design
```

这个"拒绝"本身就是设计。书签栏不是一份精选清单——它是设计画廊挨着公司后台、
JIRA 工单和路由器登录页。把整棵树都索引了再发布出去，就是这样泄露你在哪上班的。
说清楚你要哪个文件夹。

**搜索帖子**需要登录态，sifter 没有。装了
[omnireach](https://github.com/Daily-AC/omnireach) 就会用它；没装就自己把链接
丢进来。

## 验活与富化

```sh
sifter refresh              # 一周内没检查过的
sifter refresh --all
```

每个条目只抓一次，同时拿到：存活状态、真实标题、真实描述、语言，GitHub 仓库还会
拿到 star、topics、license 和是否已归档。通过重定向发现的改名也在这一步合并。

## 检索

```sh
sifter search "animated react components"
sifter search "网页设计灵感"          # 中英文互通
sifter search "shader" --limit 3 --json
```

检索是线性扫描 + BM25 打分，中日韩按二元组切分，英文做保守的词干归一，外加一份
可编辑的小型双语词表（`src/lexicon.mjs`）。clone 下来就能跑——不需要 embedding
API，没有任何要配的东西。交叉印证数、star 数和存活状态会微调排序，但不会盖过相
关性；失效条目是沉底，不是消失。

## 接进你的 agent

```json
{
  "mcpServers": {
    "sifter": {
      "command": "npx",
      "args": ["-y", "--package=@z10/sifter", "sifter-mcp"],
      "env": { "SIFTER_DB": "/path/to/your/resources.jsonl" }
    }
  }
}
```

三个工具：`sifter_search`、`sifter_list`、`sifter_get`。不设 `SIFTER_DB` 时，
server 会直接服务仓库里自带的公开索引——所以在你还没采集任何东西之前，agent 就
已经有东西可查了。

## 上报资源

任何人都可以给这份共享索引提名网站：

```sh
npx @z10/sifter submit https://example.com --note "它比同类好在哪"
```

提名会**先在你自己机器上跑完验证，再变成别人的负担**：隐私筛查、验活、抓站点
自述的标题和描述、以及跟现有索引查重。到维护者手里的是一条已验证的记录而不是
一个光秃秃的链接；过不了的当场就被拒绝，代价是一个人十秒钟，而不是审阅者十分钟。

```
✗ That looks like a personal or logged-in page (host-prefix:console, path:/billing).
✗ That URL is not reachable (dns-failure).
● Magic UI  https://magicui.design/
  already indexed as magicui.design — submitting adds one more independent mention
```

在你亲手打开那个链接之前，什么都不会被发送。加 `--open` 直接提交，加
`--from <推文URL>` 记录你是在哪看到的。没有 Node 就用
[issue 表单](.github/ISSUE_TEMPLATE/submit.yml)，机器人会在帖子里跑同一套检查。

agent 也能上报——MCP server 暴露了 `sifter_submit`，它只负责验证并返回 issue
链接交给人，绝不自己提交。

提名以 issue 形式汇集，由维护者合并进索引。收录标准见
[CONTRIBUTING.md](CONTRIBUTING.md)。

## 发布

```sh
sifter export               # 产出 index/resources.json + index/README.md
```

`index/README.md` 是一份真正可浏览的 awesome-list，但由数据生成。没通过筛查的
条目不会被发布：

| 拦下 | 原因 |
|---|---|
| `private` | 登录页、控制台、内网地址 |
| 无独立来源的 `demoted` | 私密深链降级来的公开父页，但没有别的来源为它背书 |
| `legal_risk` | 影子图书馆、盗版影视站、破解软件 |
| `dead` | 上次检查时不可达 |

风险是**打标记，不是丢弃**。本地库保留你真正看到过的一切，由 export 决定发布
什么。以后改主意只是换一个 flag 过滤条件，不用重新爬一遍。不同意就加
`--allow-risk`——仓库是你的，司法辖区也是你的。

风险筛查是启发式的，而且刻意宁可多标。它会读整条帖子的语境，而不只是链接所在的
那一行，因为证据通常在那儿：那十五个影视站没有一个自称盗版，但清单上方那句话写
着"不想花钱，又想看书、追剧、听歌？"

## 数据

每行一个 JSON 对象，放在 git 里，于是一天的变化读起来是一份可审阅的 diff——新增
四个站、一个被标记为失效——而不是一坨二进制。

```json
{
  "key": "recent.design",
  "url": "https://recent.design/",
  "aliases": ["godly.website"],
  "title": "Recent — Design Inspiration",
  "names": ["Recent — Design Inspiration", "Godly - Astronomically good web design inspiration"],
  "sections": ["审美 设计相关"],
  "liveness": { "status": "alive", "code": 200, "checked_at": "2026-08-28T..." },
  "sources": [{ "type": "chrome", "folder": "..." }, { "type": "x", "author": "..." }],
  "mentions": 2
}
```

`SIFTER_DB` 指向它，默认是 `data/resources.jsonl`。

## 隐私

- 只读你点名的一个文件夹，绝不遍历整棵书签树。
- 被判为 `private` 的条目只存在本地，**绝不**联网探测、绝不导出、绝不通过 MCP
  提供。
- 私密深链会降级到它的公开父页，而那个父页只有在另有独立公开来源背书时才会发布
  ——否则从公司登录页往上走一层，发布的就是公司域名。
- 什么都不会上传。索引是你自己的一个文件。

## 开发

```sh
npm test        # 24 个回归测试，不联网
```

里面每一条测试都对应这条管线在真实数据上真的犯过的错，而且每一个都是无声的：
活着的站被判死、法语描述在撇号处被截断、一整条帖子的盗版影视站排队等着发布。

## License

MIT
