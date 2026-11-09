# Multi-source 架构设计文档

状态：**设计提案（未实施）**
日期：2026-11-09
分支建议：`feature/multi-source`（从 `main` 切出）

---

## 0. 摘要与结论

本文档为 adrify 引入多音源（multi-source）能力提供完整的接口设计、数据模型迁移方案和分期任务表。

**核心结论：**

1. **不采用 musicdl 作为代码依赖。** musicdl 采用 PolyForm Noncommercial 1.0.0，与 adrify 的 GPL-3.0-only 存在不可调和的许可冲突（详见 §1.1）。其价值在于**加密算法的公开规格**，而这些算法本身不构成版权，可独立实现。
2. **保留 yt-dlp**，但将其从"唯一的字节来源"降级为"youtube provider 的实现细节"（详见 §1.2）。
3. **后端复杂度不会因多音源而降低**，反而会升高。新增的成本集中在**前端数据模型**——`videoId` 目前是全应用主键，需要迁移为复合键（详见 §4）。
4. **渐进式播放机制（`progressive.rs`）已经与音源解耦**，这是本次改造最重要的有利条件（详见 §3.3）。
5. **Spotify 与 Apple Music 只能作为"搜索/元数据源"**，无法作为播放源（DRM 限制，非实现难度问题）。

**补充决策（2026-11-09 第二轮，见 §11）：**

1. **移除 music-video 模块。** 不再播放视频。这不仅删掉一个功能，还**顺带消灭了 `SourceKind` 概念**（ATV/OMV 版本切换），使 `provider` 成为唯一的"来源"概念，大幅降低 §4 的迁移成本。
2. **需要跨 provider 的曲目匹配与打分机制**，但必须复用现有的 `evaluate()` 评分逻辑（`innertube/alternate-source.ts`），而不是另起炉灶。
3. **当前播放曲目的切源能力保留并改造**——原 Song↔Video 切换的 UI 位置、播放位置保持逻辑全部复用，改为 YouTube↔网易云 切换。
4. **付费歌曲走"自己的 VIP 账号 cookie + 官方 API"路径**，不走 musicdl 的第三方解灰 API 链。理由见 §11.4。

---

## 1. 前置决策

### 1.1 musicdl 许可冲突（阻断性）

|               | adrify                 | musicdl                                                                                                                                                            |
| ------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 许可证        | GPL-3.0-only           | PolyForm Noncommercial 1.0.0                                                                                                                                       |
| 商业使用      | 允许                   | **禁止**                                                                                                                                                           |
| 再授权 / 链接 | GPL §5(b) 要求整体 GPL | **禁止**（No Other Rights）                                                                                                                                        |
| 衍生作品分发  | 必须 GPL-3.0           | 必须 PolyForm NC                                                                                                                                                   |
| 分发二进制    | 允许（README 承诺）    | **明确禁止**："Redistribution, resale, or bundling of this software (or any derivative packaged distribution) without explicit permission is strictly prohibited." |

**结论**：任何形式的 vendor、链接、子模块引用或随包分发，都要求 adrify 整体降级为非商业 + PolyForm NC，与现有 GPL-3.0 承诺直接冲突。

**规避方式**：仅参考其算法规格，独立实现。加密算法与密钥是平台公开协议的一部分，任何实现方产出的结果一致，不构成对 musicdl 版权作品的复制。

**参考来源**（仅作算法对照，不复制代码）：

- `musicdl/modules/utils/neteaseutils.py` — eapi / weapi 加密
- `musicdl/modules/sources/migu.py` — 咪咕响应解密
- `musicdl/modules/sources/qq.py` — QQ 音乐 filename/guid 构造
- `musicdl/modules/utils/youtubeutils.py` — YouTube EJS solver（现有 yt-dlp 已覆盖）

### 1.2 yt-dlp 的去留

**保留。** 理由：

- YouTube 的 extractor 会频繁损坏，yt-dlp 72 小时自更新机制是这个项目**已在生产验证**的解法（见 `src-tauri/src/ytdlp.rs`）
- 项目已有的两个非显然经验必须保留：
  - `visionos` client 优先（`tv_samsung` 带前贴片广告导致 googlevideo 403，见 `progressive::FAST_CLIENT`）
  - macOS 用目录版 bundle 而非 onefile（onefile 每次启动重新解压 dylib，签名缓存永不命中，30s → 0.3s）
- 替换 yt-dlp 意味着要在 Rust 里重写 YouTube 的 PoToken / visitor_data / 签名挑战流程——musicdl 自己也是用 **Node.js + yt-dlp 的 EJS solver**（`nodejs-wheel` 依赖）才解决的

**改造目标**：yt-dlp 从"应用级依赖"变成"youtube provider 的内部实现"。届时若要替换，只需改动一个 provider，不影响其他源。

### 1.3 pymusiclibrary / ncm_music_api.dll 路线评估

**结论：跳过。**

MusicLibrary（`2061360308/MusicLibrary`，MIT）的实际架构是：

```text
NeteaseCloudMusicApi (Node) → webpack bundle (app.bundle.js)
                            → qjsc 编译 → quickjs-ng 引擎执行 → C 接口导出
```

评估要点：

1. **eapi 加密在该 bundle 里就是 §5.1 描述的 30 行 AES+MD5**，逆向出来得到的是同样的东西，不需要 quickjs、不需要 DLL
2. "从 DLL 提取 JS 源码"得到的是**压缩后的 webpack bundle**，不是可读源码
3. 真正的增量价值在 **route 表（100+ 接口）**，但播放器只需要约 10 个
4. **评论相关路由对音乐播放器没有价值**，且需完整用户上下文（eapi + 登录态 + 分页游标）

**替代方案**：

- 直接依赖 `ncm-api-rs`（WTFPL，9444 行，weapi/eapi/linuxapi 三种加密齐全，带 axum server feature）
- 或照着 §5.1 手写 40 行 eapi

两者都比"提取 JS 源码再还原"快一个数量级，且无许可风险。

### 1.4 音源能力矩阵

| 音源          | 搜索 | 元数据 | 播放（直链） | 歌词           | 认证要求                    | 备注         |
| ------------- | ---- | ------ | ------------ | -------------- | --------------------------- | ------------ |
| YouTube Music | ✅   | ✅     | ✅ (yt-dlp)  | ✅ (InnerTube) | 可选                        | 现状保留     |
| 网易云        | ✅   | ✅     | ✅ (eapi)    | ✅ (强)        | 匿名可搜；每日推荐需 cookie | **首选新增** |
| 咪咕          | ✅   | ✅     | ✅           | ✅             | 匿名                        | 解密仅 10 行 |
| QQ 音乐       | ✅   | ✅     | ✅           | ✅             | 匿名 / VIP cookie           |              |
| 酷狗          | ✅   | ✅     | ✅           | ✅             | 匿名                        |              |
| Spotify       | ✅   | ✅     | ❌ **DRM**   | ⚠️ 仅第三方    | Premium                     | 只能做搜索源 |
| Apple Music   | ✅   | ✅     | ❌ **DRM**   | ⚠️ 仅第三方    | 订阅 + 开发者 token         | 只能做搜索源 |

**Spotify / Apple Music 的 DRM 说明**：musicdl 自己的 `spotify.py` 中 `_parsewithofficialapiv1` 方法体是 `pass  # TODO: Solve DRM Issues in Spotify`——只能搜索，下载路径是绕到第三方 Spotube 服务再从 YouTube 拉。Apple Music 需要 `amdecrypt` + Bento4 `mp4decrypt` + N_m3u8DL-RE 三个外部 exe，而 musicdl 的分发协议又禁止捆绑这些 exe。**这是 DRM 机制问题，不是实现难度问题。**

---

## 2. 目标与非目标

### 目标

- 抽象出 provider 层，使新增音源不需要修改播放/缓存/队列等核心逻辑
- 引入网易云（及后续咪咕/QQ/酷狗）作为播放源，YouTube 降级为"之一"
- 支持按 provider 的 cookie 登录态（网易云 `MUSIC_U`、QQ `uin`/`qrc_` 等）
- 保留现有的所有播放特性：渐进式 Range 播放、磁盘缓存、预取、交叉淡入淡出、缓存上限淘汰

### 非目标

- 不替换 yt-dlp
- 不实现 DRM 解密（Apple Music / Spotify）
- 不做跨 provider 的歌单同步
- 不在第一阶段做 Spotify / Apple Music

---

## 3. 架构

### 3.1 总体分层

```text
┌─ 前端 (src/lib/providers/) ──────────────────────────────────┐
│                                                              │
│  types.ts          ProviderId / ProviderTrack / Provider      │
│  registry.ts       provider 注册表（能力声明、可用性）        │
│  youtube.ts        ← 现有 src/lib/innertube/* 整体迁入        │
│  netease.ts        eapi 调用                                 │
│  migu.ts / qq.ts / kugou.ts                                   │
│                                                              │
│  search.ts         统一搜索入口（多 provider 并行 + 归并）    │
│  lyrics.ts         统一歌词入口（按 provider 优先级）         │
│  fallback.ts       播放源回退链                               │
└──────────────────────────────────────────────────────────────┘
                    │  invoke("provider_resolve", ...)
                    ▼
┌─ Rust (src-tauri/src/providers/) ────────────────────────────┐
│                                                              │
│  mod.rs            trait SourceResolver + ProviderRegistry    │
│  youtube.rs        YtdlpResolver（封装现有 yt-dlp 逻辑）      │
│  direct.rs         DirectHttpResolver ← 新                    │
│                    网易云/咪咕/QQ 的直链走这条                 │
│  crypto/                                                             │
│    eapi.rs          AES-128-ECB + MD5                          │
│    weapi.rs         AES-CBC × 2 + RSA                         │
│    migu.rs          循环 key XOR + seed                        │
└──────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─ Rust (src-tauri/src/progressive.rs) ── 不变 ────────────────┐
│  ResolvedAudio → fill() → BodyCursor → /stream Range 响应     │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 前端 provider 接口

```ts
// src/lib/providers/types.ts

/** Stable provider identifier. Persisted in queues and caches. */
export type ProviderId =
  "youtube" | "netease" | "migu" | "qq" | "kugou" | "spotify" | "apple";

/**
 * A track as it exists in one provider.
 *
 * `id` is the provider's own id (YouTube videoId, NetEase song id,
 * Migu contentId, QQ songmid). It is NOT globally unique — the same
 * song has different ids in every provider, so a track's identity in
 * the app is the (provider, id) pair.
 */
export type ProviderTrackId = {
  provider: ProviderId;
  id: string;
};

/** A track, normalized across providers. */
export type ProviderTrack = {
  provider: ProviderId;
  /** The provider's own id for this track. */
  id: string;
  title: string;
  artists?: { id?: string; name: string }[];
  album?: string;
  /** Duration in seconds, when the provider reports one. */
  duration?: number;
  thumbnails: Thumbnail[];
  /** Provider-specific id for the album/artist, for deep links. */
  albumId?: string;
  artistIds?: string[];
  explicit?: boolean;
};

export type ProviderCapabilities = {
  search: boolean;
  /** Can produce a playable audio URL. */
  playback: boolean;
  /** Can return lyrics keyed by the provider's own track id. */
  lyrics: boolean;
  /** Requires user cookies for the basic (search) flow to work. */
  requiresAuth: boolean;
  /** Supports per-user playlists / library. */
  library: boolean;
};

export type Provider = {
  id: ProviderId;
  label: string;
  capabilities: ProviderCapabilities;

  /** Search across this provider. Returns normalized tracks. */
  search(query: string, opts?: { limit?: number }): Promise<ProviderTrack[]>;

  /** Resolve a track to a playable URL. Only for providers with playback. */
  resolve(track: ProviderTrackId): Promise<ResolvedPlayback>;
};

export type ResolvedPlayback = {
  /** The local stream-server URL the <audio> element should load. */
  streamUrl: string;
  /** MIME type, for the element's `type` attribute. */
  mime: string;
};
```

### 3.3 后端 resolver trait

```rust
// src-tauri/src/providers/mod.rs

use std::path::PathBuf;

/// A direct media URL with everything needed to fetch byte ranges.
#[derive(Clone, Debug)]
pub struct ResolvedAudio {
    pub url: String,
    pub size: u64,
    pub mime: &'static str,
    pub headers: Vec<(String, String)>,
    /// Unix time before which the URL answers 403 (NetEase/Migu ad gates).
    pub available_at: Option<u64>,
}

/// Resolves a provider track into a directly-fetchable audio URL.
///
/// The contract is deliberately narrow: a resolver hands back a URL and a
/// known size. Everything downstream — the background filler, the Range
/// response, the disk cache — is source-agnostic (see progressive.rs).
pub trait SourceResolver: Send + Sync {
    /// Provider this resolver serves.
    fn provider(&self) -> &'static str;

    /// Resolve to a direct URL + exact size. `None` means this source
    /// cannot play the track (e.g. DRM-protected, or region-locked) —
    /// the caller then tries the next resolver in the chain.
    async fn resolve(
        &self,
        track_id: &str,
        ctx: &ResolveContext,
    ) -> Result<ResolvedAudio, ResolveError>;

    /// Whether this resolver can serve the track at all (cheap pre-check).
    fn can_resolve(&self, track_id: &str) -> bool;
}

pub struct ResolveContext {
    /// Cookies for this provider, decrypted from the app's jar.
    pub cookies: Option<String>,
    /// The user's proxy, if configured.
    pub proxy: Option<String>,
}

pub enum ResolveError {
    /// The source has no playable form for this track (DRM, region lock).
    NotPlayable,
    /// Transient — worth retrying later.
    Transient(String),
    /// The provider's API changed or the request was rejected.
    Rejected(String),
}
```

**关键设计点**：trait 只要求"直链 + 大小"。这正是 `progressive.rs` 现在需要的全部：

```rust
// src-tauri/src/progressive.rs（现有）
pub struct ResolvedAudio {
    pub url: String,
    pub size: u64,
    pub mime: &'static str,
    pub headers: Vec<(String, String)>,
    pub available_at: Option<u64>,
}
```

**字段完全一致**——这意味着 `DirectHttpResolver` 几乎零成本接入现有的 `fill()` / `BodyCursor` / `respond()`。

### 3.4 直链解析的差异处理

各 provider 的直链获取方式不同，但归一化后只有两类：

| 类型              | 例子                                         | 处理                                 |
| ----------------- | -------------------------------------------- | ------------------------------------ |
| **标准 HTTP CDN** | 网易云 `*.music.126.net`、咪咕 `*.migu.cn`   | 直接用现有 `open_range()` / `fill()` |
| **需特殊 header** | QQ 音乐需要 `Referer`、部分需要 `Range` 预热 | 填进 `ResolvedAudio.headers`         |

网易云的直链 URL 自带 `?param=` 或路径段形式的音质标识（如 `xxx.flac`、`xxx.m4a`），**不需要**额外解密——`eapi/song/enhance/player/url/v1` 返回的就是可直接下载的 CDN URL。咪咕需要解密的是**搜索/元数据响应**（`signature: 1` header + `\xab\xcd\x01` magic），不是音频直链。

### 3.5 缓存键的迁移（Rust 侧）

现在缓存文件是 `<videoId>.webm`，`/stream/:video_id` 路由的参数也是 videoId。

**新方案**：

```text
缓存文件：<provider>_<escaped_id>.webm
         例：netease_1234567890.webm
             youtube_dQw4w9WgXcQ.webm
         （escaped：把 / \ : 等路径分隔符替换掉）

路由：    /stream/:provider/:track_id
预取：    /prefetch/:provider/:track_id
```

**迁移策略**：

- 旧文件（纯 videoId 命名）在启动时**不自动重命名**（无法区分 provider 和普通 id）
- 首次访问 `/stream/youtube/<videoId>` 时，Rust 侧检查旧路径 `<videoId>.webm` 是否存在，存在则**移动**到新路径并删除旧文件
- 这是惰性迁移，只在用户播放旧缓存曲目时发生

### 3.6 前端 URL 构造的迁移

```ts
// src/lib/stream.ts（现有）
export async function streamUrlFor(videoId: string): Promise<string> {
  const base = await getStreamBaseUrl();
  return `${base}/stream/${encodeURIComponent(videoId)}`;
}
```

**新方案**：

```ts
export async function streamUrlFor(track: ProviderTrackId): Promise<string> {
  const base = await getStreamBaseUrl();
  const provider = encodeURIComponent(track.provider);
  const id = encodeURIComponent(track.id);
  return `${base}/stream/${provider}/${id}`;
}
```

`prefetchStream` 同理。

**`/video/:video_id` 路由直接删除**——music-video 模块已移除（详见 §11.1）。

---

## 4. 数据模型迁移（前端，主要成本）

### 4.1 `videoId` 是全应用主键

统计：`videoId` 出现在 **46 个文件**中。关键位置：

| 文件                                 | 用法                             | 迁移方式                                                  |
| ------------------------------------ | -------------------------------- | --------------------------------------------------------- |
| `store/playback.ts`                  | `QueueTrack.videoId`             | → `QueueTrack.track: ProviderTrackId`                     |
| `store/track-source.ts`              | `byVideoId` 映射（ATV/OMV 切换） | **整体改造为 `byTrackKey` + `ProviderRef`**（见 §11.3.2） |
| `store/track-meta.ts`                | `byId` 元数据缓存                | → 键改为复合键字符串                                      |
| `store/dislikes.ts`                  | `ids` 记录                       | → 键改为复合键字符串                                      |
| `track-match.ts`                     | `findActiveIndex` 匹配           | 见 §4.3                                                   |
| `like-actions.ts`                    | 收藏/喜欢                        | provider 分派                                             |
| `lastfm/scrobbler.ts`                | scrobble 上报                    | 字段不变（Last.fm 不关心来源）                            |
| `deep-link.ts` / `use-deep-links.ts` | `adrify://watch?v=`              | 加 provider 段                                            |
| `storage-tab.tsx`                    | 缓存管理（22 处引用）            | 见 §4.4                                                   |
| `innertube/*`（15 文件）             | 所有 builder                     | 迁入 `providers/youtube.ts`                               |

**移除 music-video 后的简化**：`store/track-source.ts` 原本需要为同一 track 维护 `song`/`video` 两个别名指向同一 record，移除视频后每个 track 只需一条记录。详见 §11.1.2。

### 4.2 复合键的表示

**建议用字符串编码，而非嵌套对象**——因为需要用作 Map 键、localStorage 键、IndexedDB 键。

```ts
/**
 * Composite key for a track across providers. "provider:id".
 *
 * The separator is a character that cannot appear in any provider's own
 * id, so the key round-trips without ambiguity. NetEase ids are numeric,
 * Migu contentIds are numeric, QQ songmids are base64-ish, YouTube
 * videoIds are [A-Za-z0-9_-]{11} — none contain ':'.
 */
export function trackKey(t: ProviderTrackId): string {
  return `${t.provider}:${t.id}`;
}

export function parseTrackKey(key: string): ProviderTrackId | null {
  const i = key.indexOf(":");
  if (i <= 0) return null;
  const provider = key.slice(0, i);
  const id = key.slice(i + 1);
  if (!id) return null;
  return { provider: provider as ProviderId, id };
}
```

**迁移期兼容**：现有持久化数据（queue、dislikes、track-meta）里的裸 videoId 会被解析成 `{provider:"youtube", id: videoId}`。这需要一个惰性升级函数，在 store 的 `migrate` 钩子里跑一次。

### 4.3 跨 provider 的曲目匹配

现有的兜底匹配逻辑可以直接复用：

```ts
// src/lib/track-match.ts（现有核心）
const sameAlbum =
  !!t.albumId && !!current.albumId && t.albumId === current.albumId;
const sameLength =
  !!t.duration && !!duration && Math.abs(t.duration - duration) <= 3;
if (!sameAlbum && !sameLength) continue;
if (found >= 0) return -1; // 多个候选 → 宁可不标记
```

**新增**：`findActiveIndex` 需要先按 `provider + id` 精确匹配，失败后**只在同一 provider 内**做模糊匹配。跨 provider 的匹配属于另一个概念——"同一首歌在不同源的可切换版本"——应当是**显式的**功能（见 §11.3），而不是隐式的兜底。

理由：网易云的《十年》和 YouTube 的《十年》可能时长差 1 秒（不同版本），隐式匹配会导致播放列表高亮错位。

**跨 provider 的匹配有专门的实现**（§11.2），复用 `innertube/alternate-source.ts` 里已有的 `evaluate()` 评分器。

### 4.4 缓存管理页

`storage-tab.tsx` 有 22 处 `videoId` 引用。迁移后需要：

- 列表项显示 `provider` 标签（YTM / 网易云 / 咪咕 / QQ…）
- 清理操作按 provider 过滤
- 缓存统计按 provider 分组

### 4.5 深链

现有格式：

```text
adrify://watch?v=<videoId>
adrify://artist/<channelId>
adrify://album/<browseId>
adrify://playlist/<playlistId>
```

**新格式**（保留旧格式兼容）：

```text
adrify://watch?v=<videoId>                 → youtube（默认）
adrify://watch?p=netease&id=<songId>       → 新增
adrify://artist/<channelId>                → youtube only
adrify://album/<browseId>                  → youtube only
adrify://playlist/<playlistId>             → youtube only
```

`ID_RE = /^[A-Za-z0-9_-]{6,}$/` 需要放宽以容纳 provider 段。分享页（`docs/s/`）也需同步。

### 4.6 命名冲突：`SourceKind` vs `ProviderId`

```ts
// src/lib/store/track-source.ts（现有）
export type SourceKind = "song" | "video";
```

这个 "source" 指的是**同一首歌的 ATV（音频版）vs OMV（MV 版）**，与新概念"音源/provider"冲突。

**✅ 已解决**：移除 music-video 模块后，`SourceKind` 整个概念消失，不再有命名冲突。新概念统一叫 **provider**（`ProviderId`）。

`track-source.ts` 文件名可以保留以避免大范围重命名的 diff 噪音，但内部概念建议改为 `ProviderRef`（见 §11.3.2）。

---

## 5. 各 provider 的实现要点

### 5.1 网易云（eapi）

**加密算法**（独立实现，不复制 musicdl 代码）：

```text
aes_key  = "e82ckenh8dichen8"        (16 bytes)
iv       = n/a (ECB)
padding  = PKCS7
output   = hex(lowercase)

url_path = urlparse(url).path.replace("/eapi/", "/api/")
payload_json = compact JSON (serde_json::to_string, 无空格)
digest   = md5_hex(f"nobody{url_path}use{payload_json}md5forencrypt")
params   = f"{url_path}-36cd479b6b5-{payload_json}-36cd479b6b5-{digest}"
cipher   = AES-128-ECB(PKCS7(params))
```

**关键不变量**：算 digest 的 JSON 字符串和塞进 `params` 的必须是**同一个字节序列**。因此 `serde_json::to_string` 只调用一次，结果复用。

**Rust 依赖**：`aes` + `ecb` + `cipher`（`BlockEncryptMut` + `Pkcs7`）或 `aes-gcm` 之外的低阶 crate；`md-5`；`hex`。

**关键路由**（播放器实际需要的约 8 个）：

| 用途         | 路由                                                                          | 加密       |
| ------------ | ----------------------------------------------------------------------------- | ---------- |
| 搜索         | `POST /api/search/pc` 或 `/api/cloudsearch/pc`                                | weapi      |
| 歌曲详情     | `POST /api/v3/song/detail`                                                    | 普通       |
| 播放地址     | `POST /eapi/song/enhance/player/url/v1`                                       | **eapi**   |
| 歌词         | `POST /api/song/lyric`                                                        | 普通       |
| 每日推荐歌单 | `POST /eapi/discovery/recommend/songs` 或 `/api/v1/discovery/recommend/songs` | weapi/eapi |
| 歌单详情     | `POST /api/v6/playlist/detail`                                                | 普通       |
| 用户歌单     | `POST /api/user/playlist`                                                     | weapi      |
| 收藏/喜欢    | `POST /api/song/like` 等                                                      | weapi      |

**音质枚举**：`standard` / `exhigh` / `dolby` / `lossless` / `hires` / `sky` / `jyeffect` / `jymaster`

**cookie**：`MUSIC_U` 是核心（匿名可用一个公共值，但每日推荐需要真实登录态）。应复用现有的 `secure_store` 加密 jar 机制（见 `src-tauri/src/lib.rs` 的 `accounts/<id>/cookies.enc`），**按 provider 分账号**。

### 5.2 网易云 weapi

```text
iv        = "0102030405060708"
preset_key= "0CoJUm6Qyw8W8jud"
rsa_pub   = "00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b7251
             52b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312e
             cbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d8
             13cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7"
e         = 0x10001

sec_key   = 16 个随机 hex 字符（注意：生成后取反序用于第二层 AES）
inner     = base64(AES-CBC-PKCS7(json, preset_key, iv))
outer     = base64(AES-CBC-PKCS7(inner, sec_key[::-1], iv))
encSecKey = hex(RSA_no_padding(sec_key))
```

**注意 musicdl 的实现细节**：`createsecretkey` 生成的是 `hex(ord(x))` 拼接后截取 16 字符——即每个字符来自一个随机字节的 hex 表示。RSA 加密的是 `sec_key[::-1]`（反序）。这些细节必须一致，否则服务端会拒绝。

### 5.3 咪咕

**响应解密**（不是音频直链解密，是搜索/元数据响应）：

```text
magic = b"\xab\xcd\x01"
key   = b"Jk8qzuePiJ1qE3mDYhLQ3T73DtDoAhLP"

if response.headers["signature"] == "1" or body.startswith(magic):
    seed = body[3]
    plain = bytes((b + seed - key[i % len(key)]) & 0xFF for i, b in enumerate(body[4:]))
    json = parse(plain)
else:
    json = parse(body)
```

**音质提升 hack**（可直接抄的思路）：把 URL 里的 `MP3_128_16_Stero` 替换成 `MP3_320_16_Stero`。

**直链获取**：`GET https://c.musicapp.migu.cn/strategy/listen-url/h5/v2.4`，参数 `contentId` / `copyrightId` / `resourceType` / `netType=01` / `toneFlag`（音质）。

### 5.4 QQ 音乐

**直链**：

```text
GET /musicu.fcg?format=json&filename = [{quality_prefix}{song_id}{song_id}{quality_suffix}]
                      &guid = {uuid}
                      &songmid = {songmid}
                      &songtype = 0
```

部分接口需要 `qrc_` 参数（来自登录态）。

**歌词**：QQ 音乐提供**逐字歌词**（含 `Lyric` 字段的逐字时间戳），质量优于 LRCLIB。

### 5.5 YouTube（现状保留）

InnerTube 全部逻辑迁入 `providers/youtube.ts`，接口不变。唯一变化：

- `resolveStream`（`innertube/player.ts`）目前**是死代码**（见 `docs/tech-debt.md`）——迁移时可一并删除或接回新接口
- yt-dlp 调用移入 Rust 的 `providers/youtube.rs`

### 5.6 歌词的统一入口

现有 `src/lib/lyrics/sources.ts` 已经是一个多 provider 并行 + 择优的架构（ytmusic / lrclib / musixmatch / genius），**只需要新增一个 provider 插槽**：

```ts
export const SOURCE_ORDER: LyricsSource[] = [
  "ytmusic", // YouTube（按 videoId，精确）
  "netease", // 网易云（按 songId，精确）  ← 新增
  "migu", // 咪咕（按 contentId，精确）  ← 新增
  "lrclib", // 按文本匹配
  "musixmatch",
  "genius",
];
```

**关键**：网易云/咪咕的歌词是**按 provider 自己的 track id 精确匹配**的，不像 LRCLIB 那样靠字符串模糊匹配——这解决了 `docs/fork-feature-notes.md` 里提到的"歌词串歌"问题（"Строже отбрасывать lyrics от другой песни"）。

现有的错误语义（`lyrics/http.ts` 的 `LyricsTimeoutError` / `LyricsRateLimitError` / `LyricsTransportError` 三分类）应当被新 provider 复用，不要重写。

### 5.7 fallback 链

用户播放一首曲目时，如果首选 provider 拿不到可播放直链，应自动回退：

```text
播放请求(track)
  → provider.playback 可用？ 否 → 下一个
  → resolver.resolve() → Ok？ 否 → 下一个
  → 全部失败 → 报错
```

**回退的前提是同一首歌在另一个 provider 有对应条目**。这需要跨 provider 的曲目匹配（§11.2）。

**建议**：第一阶段**不做自动 fallback**。先让用户手动切源（§11.3），等每个源的直链解析稳定后再考虑自动回退。自动回退会掩盖问题，且在源质量差异大时可能给出用户不想要的版本。

**✅ 详细论证见 §11.3.3。**

**但有一个例外**：网易云每日推荐场景（§11.2.3 模式 2）本质上是"发现源 + 播放源"的分工，不是 fallback——网易云明确只负责发现，播放由 YouTube 承担。这是有意的架构选择，不是失败后的兜底。

---

## 6. 前端改动清单

### 6.1 新增文件

```text
src/lib/providers/
  types.ts          ProviderId / ProviderTrack / Provider / 能力声明
  registry.ts       provider 注册表 + 启用/禁用状态
  keys.ts           trackKey / parseTrackKey / 惰性迁移
  match.ts          scoreMatch() ← 泛化自 innertube/alternate-source.ts
  search.ts         统一搜索（多 provider 并行 + 归并去重）
  lyrics.ts         歌词 provider 插槽（复用现有 sources.ts 架构）
  youtube.ts        ← 从 innertube/ 迁入
  netease.ts
  migu.ts
  qq.ts
  kugou.ts
```

### 6.2 需要修改的现有文件（按工作量排序）

| 文件                                 | 改动                                               | 工作量       |
| ------------------------------------ | -------------------------------------------------- | ------------ |
| `store/playback.ts`                  | `QueueTrack.videoId` → `track: ProviderTrackId`    | 中           |
| `store/track-meta.ts`                | 键改复合键                                         | 小           |
| `store/dislikes.ts`                  | 键改复合键                                         | 小           |
| `store/track-source.ts`              | → `byTrackKey` + `ProviderRef`（见 §11.3.2）       | 中           |
| `audio-engine.ts`                    | `resolveStreamId` → provider 感知                  | 中           |
| `stream.ts`                          | URL 加 provider 段；删 `videoUrlFor`               | 小           |
| `track-match.ts`                     | 精确匹配加 provider，模糊匹配限同源                | 中           |
| `like-actions.ts`                    | 按 provider 分派到不同 mutation                    | 中           |
| `deep-link.ts` / `use-deep-links.ts` | 深链加 provider 段                                 | 小           |
| `storage-tab.tsx`                    | 缓存列表加 provider 标签                           | 中           |
| `innertube/alternate-source.ts`      | 删 `findAlternateVideoId`，保留并泛化 `evaluate()` | 小           |
| `innertube/*`（15 文件）             | 迁移到 `providers/youtube.ts`                      | 大（但机械） |
| `lyrics/sources.ts`                  | 加 provider 插槽                                   | 小           |
| `lastfm/scrobbler.ts`                | 基本不变                                           | 无           |
| `playback-notifications.ts`          | 不变                                               | 无           |

**删除的文件**（详见 §11.1.1）：
`components/layout/immersive-video.tsx`、`lib/use-source-switch.ts`。

### 6.3 Rust 侧改动

```text
src-tauri/src/providers/
  mod.rs            trait SourceResolver / ProviderRegistry
  youtube.rs        封装现有 spawn_downloader / progressive::resolve_audio
  direct.rs         DirectHttpResolver（网易云/咪咕/QQ 直链）
  crypto/
    eapi.rs
    weapi.rs
    migu.rs

src-tauri/src/lib.rs
  - 路由改为 /stream/:provider/:track_id
  - 缓存文件命名改为 <provider>_<id>.webm
  - cookie jar 按 provider 分账号
```

### 6.4 能力声明（`src-tauri/capabilities/default.json`）

新增 provider 的域名必须在此白名单，否则 `tauri-plugin-http` 会在 Rust 边界拒绝请求（**在发起任何网络调用之前**）：

```jsonc
{ "url": "https://music.163.com/*" },
{ "url": "https://interface3.music.163.com/*" },
{ "url": "https://m.music.163.com/*" },
{ "url": "https://c.musicapp.migu.cn/*" },
{ "url": "https://app.c.nf.migu.cn/*" },
{ "url": "https://y.qq.com/*" },
{ "url": "https://u.y.qq.com/*" },
{ "url": "https://c.y.qq.com/*" }
```

**注意**：现有的 `hosts.test.ts` 之类的守卫测试会需要扩展。

---

## 7. 分期任务表

### P0 — 抽象层落地（纯重构，零行为变更）

**目标**：让现有 YTM 成为 `provider: "youtube"`，行为完全不变。

> **注意**：本节是**第一版**的任务表。第二轮合并了"移除 music-video"，修订后的版本见 **§11.6**。以 §11.6 为准。

| 任务                                            | 文件                                     | 验收                         |
| ----------------------------------------------- | ---------------------------------------- | ---------------------------- |
| 定义 provider 类型与注册表                      | `providers/types.ts`, `registry.ts`      | 类型检查通过                 |
| 迁移 `innertube/*` → `providers/youtube.ts`     | 15 文件                                  | `pnpm test` 全绿，行为不变   |
| `QueueTrack.videoId` → `track: ProviderTrackId` | `store/playback.ts`                      | 现有播放/队列/持久化测试通过 |
| 复合键 + 惰性迁移                               | `providers/keys.ts`                      | 老版本持久化的队列能正确读回 |
| `stream.ts` URL 加 provider 段                  | `stream.ts` + Rust 路由                  | 播放不回归                   |
| Rust 缓存键改 `<provider>_<id>`                 | `lib.rs`                                 | 旧缓存惰性迁移生效           |
| 复合键迁移其余 store                            | `track-meta`, `dislikes`, `track-source` | 收藏/不喜欢在重启后仍生效    |

**风险点**：`QueueTrack` 是持久化结构，键类型变更影响 IndexedDB 里的老数据。迁移函数必须幂等且可测试。

**这是后续一切的前提。** 如果 P0 没做扎实，每加一个源都在还债。

### P1 — 网易云

| 任务               | 内容                                                                                |
| ------------------ | ----------------------------------------------------------------------------------- |
| Rust eapi 加密     | `crypto/eapi.rs` + 单元测试（用固定 payload 的已知密文）                            |
| Rust weapi 加密    | `crypto/weapi.rs` + 单元测试                                                        |
| 网易云 cookie 登录 | 复用 `secure_store`，按 provider 分账号                                             |
| 搜索               | 前端 `providers/netease.ts`                                                         |
| 播放直链           | Rust `providers/netease.rs`，复用 `progressive::fill`                               |
| 权限判定           | 读 `privileges`（`st` / `fee` / `freeTrialInfo` / `maxBrLevel`），区分可播/试听/VIP |
| 歌词               | 接入 `lyrics/sources.ts`（按 songId 精确匹配）                                      |
| 每日推荐           | Explore 页新增 section（需登录态 cookie）                                           |
| 跨 provider 匹配   | `scoreMatch()` + YouTube 搜索（§11.2）                                              |
| 收藏/喜欢          | 按 provider 分派                                                                    |
| 设置页             | 新增"音源"tab：启用哪些 provider、源优先级、各源登录态                              |

**验收**：网易云搜索 → 播放 → 缓存 → 歌词 → 收藏 → 重启后状态保持，整链路通过。

### P2 — 咪咕 + QQ

验证抽象层是否真的可插拔（这两个源直链形态与网易云不同：咪咕需响应解密，QQ 需 guid/filename/sign 构造）。

**修订**：QQ 的鉴权复杂度显著高于网易云（§11.4.4），建议 QQ 单独排期。修订后的顺序见 §11.6。

### P3 — 酷狗

### P4 — Spotify / Apple Music（仅搜索/元数据）

**注意**：这两个源**永远不能作为播放源**。UI 上必须明确标注"仅用于搜索"，避免用户点进去发现无法播放。

### P5 — 统一 fallback + 源优先级设置

延后到 P1–P3 都稳定之后。理由见 §5.7 与 §11.3.3。

---

## 8. 风险与开放问题

### 8.1 已知风险

| 风险                     | 影响                 | 缓解                                                                                      |
| ------------------------ | -------------------- | ----------------------------------------------------------------------------------------- |
| **网易云 eapi 密钥变更** | 播放地址解析失败     | 密钥是公开常量，变更通常伴随 API 版本号变化；错误信息需能区分"密钥失效"与"网络故障"       |
| **接口路由变更**         | 搜索/歌词失效        | 现有 InnerTube 客户端已证明"全树递归解析"策略有效——新 provider 也应避免硬编码深层路径     |
| **风控 / IP 限流**       | 搜索结果为空         | 各 provider 需要独立的失败计数与退避，不能共用一个熔断                                    |
| **cookie 过期**          | 需登录的功能静默失效 | 沿用现有 `session-gate.ts` 的"登录态就绪"同步机制                                         |
| **存储膨胀**             | 多 provider 缓存叠加 | 现有 `enforce_cache_limit` 已是 provider 无关的，扩展即可；但缓存上限要能按 provider 分配 |

### 8.2 开放问题

1. **provider 之间的曲目去重**：用户在网易云搜到《十年》，在 YouTube 也有《十年》。全局搜索结果里要不要合并？合并的置信度阈值定多少？（§11.2 的匹配逻辑可复用，但需要避免误合并不同版本）
2. **队列持久化的向后兼容**：老版本写入的 IndexedDB 数据里是裸 videoId。是否需要在升级时主动重写，还是惰性读取时转换？惰性更安全但会让存储里长期混杂两种格式。
3. ~~**`track-source.ts` 的 ATV/OMV 切换是否泛化**~~ → **已由 §11.1.2 解决**（移除视频后 `SourceKind` 消失）。
4. **YouTube 侧是否也要 provider 化**：如果 P0 把 YTM 迁到 `providers/youtube.ts`，`innertube/` 目录是否保留作为过渡？建议直接迁走，避免两套路径。
5. **移除视频后，YouTube 搜索的 "Videos" tab 如何处理**：见 §11.1.1 的决策点 A/B。建议 A（保留 tab 但不可直接播放，点击时去其他源找可播放版本）。
6. **§11.7 的其余开放问题**（匹配错误率目标、每日推荐的登录态缺失、QQ qimei、provider 优先级默认值）。

---

## 9. 参考资料

- musicdl（**仅作算法对照，不可作为依赖**）：[github.com/CharlesPikachu/musicdl](https://github.com/CharlesPikachu/musicdl)
  - 许可：PolyForm Noncommercial 1.0.0 — 与 GPL-3.0-only 冲突
- NeteaseCloudMusicApi（算法源头，MIT-ish）：[github.com/Binaryify/NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi)
- `ncm-api-rs`（Rust 移植，WTFPL）：[crates.io/crates/ncm-api-rs](https://crates.io/crates/ncm-api-rs)
- `netease-music`（Rust，状态式 client）：[crates.io/crates/netease-music](https://crates.io/crates/netease-music)
- MusicLibrary（MIT，quickjs 路线，本文建议跳过）：[github.com/2061360308/MusicLibrary](https://github.com/2061360308/MusicLibrary)
- 现有 YTM 客户端经验：见 `src/lib/innertube/shared.ts` 顶部注释与 `src-tauri/src/progressive.rs` 的 `FAST_CLIENT` 说明

---

## 10. 变更记录

| 日期       | 变更                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------- |
| 2026-11-09 | 初稿。基于 musicdl v2.14.2、MusicLibrary、crates.io 现状分析。                               |
| 2026-11-09 | 第二轮：加入 music-video 移除方案、跨 provider 匹配打分、切源改造、付费歌曲鉴权路径（§11）。 |
| 2026-11-09 | 第二轮决策落定：移除 Videos tab、每日推荐按 provider 优先级链选源、先做 P0 纯删除（§11.8）。 |

---

## 11. 第二轮决策详解

### 11.1 移除 music-video 模块

#### 11.1.1 影响范围盘点

功能本身跨 3 层，但**结构上比预想的干净**——`SourceKind` 的存在让"同一首歌的两个版本"与"不同音源"这两个概念纠缠在一起，移除视频正好解开这个结。

##### 前端 — 删除

| 文件/符号                               | 说明                                                                                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/layout/immersive-video.tsx` | 整个文件。双槽位 `<video>` 切换 + 音频时钟同步逻辑（约 260 行），全部作废                                                                           |
| `components/layout/source-switch.tsx`   | `SourceSwitch` 导出（`QualitySwitch` 保留，见下）                                                                                                   |
| `lib/use-source-switch.ts`              | 整个文件。`useSourceSwitch` hook + `useMissingSources` store                                                                                        |
| `lib/innertube/alternate-source.ts`     | `findAlternateVideoId` 函数。**但 `evaluate()` 评分函数要保留**——见 §11.2                                                                           |
| `lib/stream.ts`                         | `videoUrlFor()` 函数                                                                                                                                |
| `lib/store/track-source.ts`             | `SourceKind`、`TrackSources.selected`、`setSelected`、`setAlternate`、`byVideoId` 中的 `video` 字段。**`resolveStreamId()` 保留并改造**（见 §11.3） |
| `lib/store/settings.ts`                 | `VideoQuality` 类型、`videoQuality` 状态、`setVideoQuality`                                                                                         |
| `lib/store/dislikes.ts`                 | 不涉及                                                                                                                                              |

##### 前端 — 修改

| 文件                                      | 改动                                                                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/layout/fullscreen-player.tsx` | 移除 `ImmersiveVideo` 渲染、`SourceSwitch` 控件、`wantsVideo` 状态、`failedId` 追踪。**新增** provider 切换控件（§11.3）                       |
| `components/layout/player-more-menu.tsx`  | "切换到 Music Video" 菜单项 → 改为"切换音源"                                                                                                   |
| `components/shared/track-list.tsx`        | `videoSourceSelected` 属性 → 改为 `providerLabel`                                                                                              |
| `components/settings/appearance-tab.tsx`  | 删除"视频画质"行                                                                                                                               |
| `components/settings/settings-index.ts`   | 删除 `videoQuality` 条目                                                                                                                       |
| `lib/audio-engine.ts`                     | `resolveStreamId` → provider 感知的解析                                                                                                        |
| `lib/i18n/dictionaries/*.ts`              | 删除 `player.video`、`player.noVideoAvailable`、`player.noSongVersionFound`、`player.playbackSource`、`settings.appearance.videoQuality*` 等键 |

##### 前端 — 保留但需要区分语义

| 位置                               | 说明                                                                                                                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `innertube/shared.ts:820`          | `kind = ratio > 1.4 ? "video" : "song"` —— 这是**从搜索结果推断 item 类型**，不是"播放视频"。保留，但 `kind: "video"` 的条目应当**不显示为可播放曲目**，或者显示但标记为"仅音频" |
| `innertube/search.ts`              | `SearchGroup` 含 `"video"`，搜索 tab 含 `"videos"`                                                                                                                               |
| `components/shared/shelf-card.tsx` | `isVideo = item.kind === "video"` → 图标/角标区分                                                                                                                                |

**⚠️ 关键决策点：搜索结果里的 "video" 条目怎么处理？**

YouTube 搜索有独立的 "Videos" tab，返回的条目 `kind: "video"`。移除播放能力后有两种选择：

- **A（推荐）**：保留 Videos tab，但条目**不可点击播放**，点击时用该视频的标题+艺人去其他 provider 搜索可播放版本。这实际上变成了"用 MV 当搜索线索"，体验合理。
- **B**：直接移除 Videos tab，搜索只返回音频曲目。改动更小但丢失了发现能力。

建议 A。因为 YouTube 的 "Videos" 结果常常带有更好的封面和更准确的艺人信息，可以作为 §11.2 匹配机制的输入。

**✅ 已决策（2026-11-09）：选 B —— 直接移除 Videos tab。** 搜索只返回音频曲目。

理由：既然不再播放视频，Videos tab 的存在意义只剩"提供匹配线索"，而这个价值不足以抵消 UI 复杂度——用户点进一个不能播的 tab 是明确的坏体验。跨 provider 匹配（§11.2）会直接在各 provider 的**音频**搜索结果里做，不需要 MV 条目作为输入。

**连带影响**：

- `innertube/search.ts` 的 `SearchGroup` 移除 `"video"`，`GROUP_FILTER` 删除 `video: "videos"`
- `innertube/search.ts` 里把 `kind: "song"` 重标为 `"video"` 的两处逻辑（`classifyAllRow` 的 videos tab 处理、search.test.ts 相关断言）一并删除
- `innertube/locale-tokens.ts` 的 `Video: "video"` / `视频: "video"` 映射删除
- `innertube/shared.ts:820` 的 `kind = ratio > 1.4 ? "video" : "song"` 简化为恒为 `"song"`
- `innertube/types.ts` 的 `ShelfItem.kind` 移除 `"video"`
- `components/shared/shelf-card.tsx` / `shelf-carousel.tsx` 的 `isVideo` 分支删除

##### Rust — 删除

| 位置                   | 说明                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src-tauri/src/lib.rs` | `video_handler`、`spawn_video_downloader`、`video_quality()`、`video_format()`、`VIDEO_CACHE_KEEP`、`.video.mp4` 清理逻辑、`/video/:video_id` 路由 |
| `src-tauri/src/lib.rs` | `AUDIO_FORMAT` 相关的视频分支                                                                                                                      |

**保留**：`sanitize_video_id()` 还被音频路径复用（用于校验 youtube videoId），不能删。

**收益**：删除约 **800 行**代码（前端 ~500 + Rust ~300），且消除了一个独立的失败面（视频下载 300 秒超时、双槽位同步、画质降级链）。

#### 11.1.2 `SourceKind` 消失后的语义释放

移除视频后，`track-source.ts` 的 `SourceKind = "song" | "video"` **整个概念不再需要**：

```ts
// 现状
export type SourceKind = "song" | "video";
export type TrackSources = {
  song: string;
  video?: string;
  selected: SourceKind;
};

// 移除视频后
export type TrackSources = {
  /** The provider currently serving this track. */
  provider: ProviderId;
  /** The provider's own id for this track (may differ from the queue id). */
  providerTrackId: string;
};
```

**这大幅简化 §4 的迁移**：原本 `byVideoId` 需要同时维护 song/video 两个别名指向同一 record，移除后每个 track 只需一条记录。

**命名建议**：`track-source.ts` 文件名可以保留（避免大范围重命名的 diff 噪音），但内部概念改为 `TrackProviderRef`。或者干脆重命名为 `provider-ref.ts`——移除视频后没有历史包袱了。

---

### 11.2 跨 provider 的曲目匹配与打分

#### 11.2.1 现有实现可以直接复用

这是本轮最重要的发现。`innertube/alternate-source.ts` 里已经有一个**设计良好的评分器**：

```ts
// src/lib/innertube/alternate-source.ts（现有，保留）
function evaluate(
  item: ShelfItem,
  hint: AlternateHint,
  currentVideoId: string,
  targetKind: SourceKind,
): number | null {
  // 1. Title: nearly every meaningful word of the original must be there,
  //    and the candidate must not announce a different version.
  const want = significant(hint.title);
  const got = new Set(significant(item.title));
  if (want.length === 0) return null;
  const coverage = want.filter((t) => got.has(t)).length / want.length;
  if (coverage < 0.75) return null;
  const wantSet = new Set(want);
  for (const t of got) {
    if (VARIANT.has(t) && !wantSet.has(t)) return null;
  }

  // 2. Artist.
  let artistFrac = 0;
  if (names.length > 0) {
    artistFrac = names.filter((n) => haystack.includes(n.toLowerCase())).length / names.length;
  }
  const artistOk = artistFrac >= 0.5;

  // 3. Duration: a music video can run a little long (intro, outro) but a
  //    big gap means a different recording or a compilation.
  const diff = known ? Math.abs(d0 - d1) : Infinity;
  const tol = Math.max(25, (d0 ?? 0) * 0.15);
  if (known && diff > tol) return null;

  // Title alone never decides: either the artist agrees, or the length is
  // all but identical.
  if (!artistOk && !(known && diff <= 5)) return null;

  let total = coverage * 3 + artistFrac * 2;
  total += known ? (diff <= 3 ? 2 : 1) : 0.3;
  ...
}
```

**这个评分器的所有设计都对跨 provider 适用**：

- `NOISE` 词表（official/video/mv/remastered…）—— 跨 provider 依然是要过滤的噪音
- `VARIANT` 词表（remix/live/acoustic/cover…）—— **跨 provider 更重要**，因为网易云有大量"翻唱版""Live版"混在搜索结果里
- 覆盖率阈值 0.75
- 艺人匹配阈值 0.5
- 时长容差 `max(25, duration * 0.15)`

**改造点**：把 `ShelfItem` 换成 provider 通用的 `ProviderTrack`，把 `targetKind` 参数去掉（不再区分 song/video），把 `currentVideoId` 换成 `ProviderTrackId`。

```ts
// src/lib/providers/match.ts（新）
export type MatchHint = {
  title: string;
  artists?: string[];
  duration?: number;
};

/**
 * Judge one candidate against the track we're looking for. Returns null
 * when it is not convincingly the same recording, otherwise a score.
 *
 * Every gate must pass: a wrong track with right-sounding words in the
 * title is worse than no track at all, so near-misses are rejected rather
 * than ranked. Cross-provider this matters even more than within
 * YouTube — NetEase results carry covers, live cuts and "DJ" remixes
 * under the same title as the original.
 */
export function scoreMatch(
  candidate: ProviderTrack,
  hint: MatchHint,
): number | null;
```

#### 11.2.2 需要补强的两处

##### （a）中文歌名的 token 化

现有 `tokens()` 用 `\p{L}` 匹配，中文汉字会被当**单个 token**（因为 `\p{L}` 是逐字符的，且 `split(" ")` 按空格切）：

```ts
const tokens = (s: string): string[] =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ") // ← 汉字之间没有空格，会连成一整串
    .split(" ")
    .filter(Boolean);
```

"稻香" → `["稻香"]`，"周杰伦" → `["周杰伦"]`。这对**完全相同的歌名**没问题（覆盖率 100%），但对"稻香 (Live版)" vs "稻香"这种，也能工作（`稻香` ⊂ `稻香`）。

**风险**：网易云的搜索结果常带 "【高音质】"、"完整版"、"HQ" 等前缀，`NOISE` 词表是英文的，中文噪音词需要补：

```ts
const NOISE = new Set([
  ...existing,
  // 中文噪音词（网易云/咪咕/QQ 的搜索结果前缀）
  "高音质",
  "超清",
  "无损",
  "完整版",
  "官方",
  "高品",
  "超品",
  "臻品",
  "全景声",
  "母带",
  "试听",
  "纯享",
  "伴奏",
  "消音",
]);

const VARIANT = new Set([
  ...existing,
  // 中文变体标记
  "翻唱",
  "cover",
  "现场",
  "live",
  "钢琴",
  "伴奏",
  "纯音乐",
  "加速",
  "减速",
  "音效",
  "影视",
  "抖音",
  "卡点",
]);
```

##### （b）时长容差要收紧

现有容差 `max(25, duration * 0.15)` 是为 **MV** 设计的（MV 可能有 intro/outro 差几十秒）。但**跨 provider 的纯音频曲目，时长差 15% 往往意味着不同版本**：

- 网易云《十年》= 268s，YouTube 官方音轨 = 269s → 差 1s ✓
- 网易云《稻香 Live 版》= 245s，YouTube 原版 = 269s → 差 24s ✗（应该被拒绝）

**建议**：跨 provider 用**更紧的容差**：

```ts
// 跨 provider：两个平台的音频文件应当几乎等长
const tol = Math.max(5, (hint.duration ?? 0) * 0.03); // 3% 或 5 秒
```

保留原来的宽松容差给同 provider 内部用（MV 那种）。

#### 11.2.3 匹配策略：谁发起匹配？

三个场景，策略不同：

| 场景                | 发起方             | 搜索范围                     | 是否自动                  |
| ------------------- | ------------------ | ---------------------------- | ------------------------- |
| **A. 每日推荐歌单** | 网易云给出曲目列表 | 每首歌在其他 provider 搜一遍 | 可选（默认关）            |
| **B. 播放时兜底**   | 当前曲目解析失败   | 其他 provider 搜同歌         | **不建议自动**（§11.3.3） |
| **C. 用户手动切源** | 用户点击           | 其他 provider 搜同歌         | 手动，必需                |

**场景 A 是你的主场景**（"每日歌单"是网易云的核心价值）。设计：

```text
网易云每日推荐 → 30 首歌
  ↓ 对每首歌（并发，限流 3-4）
  在 YouTube 搜索 "歌名 歌手" → 最高分匹配
  ↓
每首歌得到 { netease: {id}, youtube: {id}?, confidence }
```

**关键问题：匹配失败怎么办？**

选项 1：只播放网易云版本（即使 VIP 拿不到直链 → 播放失败）
选项 2：**匹配到 YouTube 就用 YouTube 播放**（网易云仅作为"发现"源）
选项 3：**按用户配置的 provider 优先级依次尝试**

**✅ 已决策（2026-11-09）：选 3 —— 按 provider 优先级尝试。**

这是三个选项里最通用的：它把"用哪个源播"从每日推荐的特殊逻辑，提升为**全应用的统一策略**。每日推荐只是众多曲目来源之一，不需要特殊对待。

具体设计：

```text
网易云每日推荐 → 30 首歌（每首带 netease 自身的 id）
  ↓ 用户点击某首
  按 provider 优先级（默认 youtube > netease > migu > kugou > qq）依次尝试：
    1. 解析 youtube 的匹配结果 → 能拿到直链？ → 用它
    2. 否则解析 netease 直链 → 能拿到直链？ → 用它
    3. ... 直到某个源成功，或全部失败
  ↓
记录本次实际使用的 provider，供"切源"UI 展示
```

**优先级的意义**：

- YouTube 排第一是因为**无 VIP 门槛**（免费音源覆盖最广）
- 网易云排第二是因为它有用户自己的 VIP cookie 时音质最好（lossless/hires）
- 用户可以在设置里改这个顺序

**关键设计点：优先级顺序只在"能拿到直链"时生效，不是"能搜索到"时。** 解析失败的源自动让位给下一个，这与 §11.3.3 的"不做自动 fallback"**不矛盾**——区别在于：

|                               | 播放失败后的行为                                                               |
| ----------------------------- | ------------------------------------------------------------------------------ |
| §11.3.3 的 fallback（不建议） | 曲目已在播放中，源挂了才换源 → 掩盖问题、质量倒退                              |
| 本节的优先级链（采用）        | **选源发生在播放之前**，用户还没听到任何声音，换源是"选了个能播的"，不是"救场" |

换句话说：优先级链是**播放前的源选择**，不是**播放中的救场**。§11.3.3 反对的是后者。

**这个模式还有一个副产品**："切源"功能天然可用——每首歌都已经有了多个候选，用户想换就换。

**⚠️ 前提：跨 provider 匹配必须先完成。** 上面的流程依赖 §11.2 的匹配器把"一首歌"关联到多个 provider 的 id。所以 P1 的实施顺序是：匹配器 → 优先级链 → 每日推荐 UI。

#### 11.2.4 性能考量

30 首歌 × 1 个 provider 搜索 = 30 次 YouTube InnerTube 搜索请求。这个量不小。

**优化**：

- **并发限制**：3-4 个并发（InnerTube 有速率限制）
- **缓存**：同一首歌的匹配结果持久化（IndexedDB），key = `歌名+歌手` 的规范化哈希
- **懒加载**：只匹配用户实际播放过的歌，不预先匹配全部 30 首。即：用户点第 7 首时，才去 YouTube 搜匹配

**懒加载是更好的设计**——避免了 30 次无用请求，且用户真正需要的往往就是前几首。

---

### 11.3 当前曲目的切源

#### 11.3.1 现有机制完全可复用

原 Song↔Video 切换的实现是一套成熟的"同一 track 的多 id + 保持播放位置"机制：

```ts
// src/lib/store/track-source.ts（现有）
export type TrackSources = {
  song: string;
  video?: string;
  selected: SourceKind;
};
```

```ts
// src/lib/audio-engine.ts（现有，核心逻辑）
const streamVideoId = useTrackSourceStore((s) =>
  videoId ? resolveStreamId(videoId, s.byVideoId) : undefined,
);

// Same queue slot as last time, but a different stream id than the one
// loaded: the user flipped Song ↔ Video on the playing track.
const isSourceSwitch =
  !!prevTrack &&
  videoId !== undefined &&
  prevTrack.videoId === videoId &&
  prevTrack.index === index &&
  !!streamVideoId &&
  !!loadedId &&
  loadedId !== streamVideoId;
```

```ts
// src/lib/audio-engine.ts（现有，保持播放位置）
if (isSourceSwitch) {
  const pos = el.currentSrc
    ? el.currentTime
    : usePlaybackStore.getState().position;
  if (pos > 0.5 && videoId !== undefined) {
    resumeRef.current = { videoId, index, seconds: pos };
  }
}
```

**这套机制与"版本"无关，它关心的是"同一个队列槽位换了一个 stream id"**。把 `SourceKind` 换成 `ProviderId`，把 `byVideoId` 换成 `byTrackKey`，逻辑一字不改。

#### 11.3.2 改造后的形态

```ts
// src/lib/store/provider-ref.ts（新）
export type ProviderRef = {
  /** The provider serving this track right now. */
  provider: ProviderId;
  /** The provider's own id for this track. */
  providerTrackId: string;
};

type State = {
  /** Keyed by the ORIGINAL track key (the one in the queue). */
  byTrackKey: Record<string, ProviderRef>;
  /** Point this track at a different provider's version. */
  setProvider: (trackKey: string, ref: ProviderRef) => void;
};

/**
 * Resolve the id we should actually stream given the displayed (queue) id.
 * A provider switch keeps the same track but a different provider id.
 */
export function resolveStreamId(
  displayedKey: string,
  byTrackKey: Record<string, ProviderRef>,
): string | undefined {
  const ref = byTrackKey[displayedKey];
  if (!ref) return displayedKey;
  return `${ref.provider}:${ref.providerTrackId}`;
}
```

**UI 位置**：原 `SourceSwitch` 药丸控件在 fullscreen-player 里的位置，改为 **provider 切换药丸**：

```text
┌─────────────────────────────────────────┐
│  ♫  稻香                                │
│     周杰伦 · 魔杰座                       │
│                                         │
│         [封面]                            │
│                                         │
│    ●───────  ← 音频进度                    │
│                                         │
│  [⏮] [▶] [⏭]   [🔊]     [音源: 网易云 ▾]  │
└─────────────────────────────────────────┘
```

`GlowPill` 组件本身（`source-switch.tsx` 里的）**完全可复用**——它是个通用的"折叠胶囊 + 展开选项"控件，只是选项从 Song/Video 变成了 YouTube/网易云/咪咕/QQ。

**选项列表内容**：

- 每个已知的 provider 版本（带图标 + 名称）
- "在网易云搜索…"（如果还没匹配过）
- 不可用的源置灰（`dim: true`）

#### 11.3.3 不做自动 fallback（重要）

**不要**在解析失败时自动切到另一个源。原因：

1. **掩盖问题**：网易云 VIP 歌曲拿不到直链 → 自动切 YouTube → 用户不知道发生了什么，只知道"网易云那首播不了"
2. **质量倒退**：YouTube 的同一首歌可能是 128kbps，而网易云是 320kbps
3. **匹配可能错**：§11.2 的打分是启发式的，自动 fallback 会放大误匹配的后果

**替代方案**：解析失败时**提示用户**并给出"在 YouTube 找同曲"的按钮。用户点一下，走 §11.2 的匹配逻辑，但这次匹配是**用户主动触发**的，所以匹配错了用户能立刻察觉并切回来。

#### 11.3.4 队列里的 provider 标记

`QueueTrack` 需要携带 provider 信息：

```ts
export type QueueTrack = {
  /** The provider this track came from. */
  provider: ProviderId;
  /** The provider's own id. */
  trackId: string;
  title: string;
  ...
};
```

UI 上建议在曲目行的角标显示 provider（一个小图标或文字标签），让用户知道哪些歌是网易云的。

---

### 11.4 付费歌曲的鉴权处理

#### 11.4.1 musicdl 的做法（实测代码）

musicdl 的 `netease.py` 里有一个明确的两阶段设计：

```python
'''_parsewiththirdpartapis'''
def _parsewiththirdpartapis(self, search_result, request_overrides=None):
    # 有 cookie 就完全不用第三方 API —— 走官方 eapi
    if (cookies := self.default_cookies or request_overrides.get('cookies')) and (cookies != DEFAULT_COOKIES):
        return SongInfo(source=self.source, raw_data={'quality': MUSIC_QUALITIES[-1]})
    # 没 cookie 才用第三方解灰链，按"账号等级"分层
    l1_parser_funcs = [...]  # svip
    l2_parser_funcs = [...]  # svip, but unstable accounts
    l3_parser_funcs = [...]  # vip
    l4_parser_funcs = [...]  # vip, but unstable accounts
```

而官方路径 `_parsewithofficialapiv1` 用的是标准 eapi：

```python
params = {'ids': [song_id], 'level': music_quality, 'encodeType': ..., 'header': ...}
params = EapiCryptoUtils.encryptparams(
    url='https://interface3.music.163.com/eapi/song/enhance/player/url/v1',
    payload=params)
(cookies := {"os": "pc", "appver": "", "osver": "", "deviceId": "pyncm!"}).update(copy.deepcopy(self.default_cookies))
(resp := self.post('https://interface3.music.163.com/eapi/song/enhance/player/url/v1',
                   data={"params": params}, cookies=cookies)).raise_for_status()
```

**关键观察**：musicdl 的"解灰"不是靠逆向鉴权参数，而是靠**调用第三方的公开 API 服务**（`nextmusic.toubiec.cn`、`musicapi.haitangw.net`、`music.rrvenn.cn`、`music.znnu.com` 等 20+ 个），这些服务在服务器端持有自己的会员账号。

**这些第三方服务不稳定、随时会挂、且可能违反平台条款。** 不建议作为主路径。

#### 11.4.2 网易云的鉴权模型（这是真正的答案）

网易云的权限信息在 `/eapi/song/enhance/player/url/v1` 的响应里，通过 `privileges` 对象表达：

| 字段                                        | 含义                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------- |
| `st`                                        | 资源状态。`st < 0` = 灰色歌曲（无版权/不可播）；`st = 0` = 可播                  |
| `fee`                                       | `0`=免费 / `1`=VIP 歌曲 / `4`=需购买专辑 / `8`=非会员可播低音质，会员可播高音质  |
| `payed`                                     | `1` = 已购买                                                                     |
| `freeTrialInfo`                             | 试听区间。`{start, end}`，收费歌常见 `end=30`（只给 30 秒）；免费歌通常为 `null` |
| `maxbr` / `playMaxbr` / `downloadMaxbr`     | 各级音质码率上限（kbps）                                                         |
| `maxBrLevel` / `playMaxBrLevel` / `flLevel` | 最高音质 / 当前用户可播音质 / 免费用户可播音质                                   |
| `toast`                                     | 是否"由于版权保护，您所在的地区暂时无法使用"                                     |
| `freeTrialPrivilege`                        | `cannotListenReason` / `playReason` / `freeLimitTagType` —— **具体的不可播原因** |

**所以"鉴权参数"其实很简单**：

1. **请求头**：`os=pc`, `appver=""`, `osver=""`, `deviceId="pyncm!"` + 你的 `MUSIC_U` cookie
2. **请求体**：`eapi` 加密的 `{ids, level, encodeType, header}`
3. **响应判定**：读 `privileges` 判断能不能播、能播到什么音质

**没有需要逆向的东西**——这些字段是服务端返回的明文语义，逆向的意义只在于"知道字段什么意思"。

#### 11.4.3 推荐方案：用你自己的 VIP 账号

**这是最干净、也最可持续的路径。**

```text
网易云 VIP 账号的 MUSIC_U cookie
  → eapi 请求带这个 cookie
  → 服务端识别为 VIP
  → 返回 lossless/hires 直链 + privileges.st = 0
```

**优点**：

- **合规**：用自己的账号访问自己有权访问的内容，与网易云客户端行为一致
- **无第三方依赖**：不依赖任何会挂的解灰 API
- **音质最好**：VIP 账号能拿 `lossless`/`hires`
- **稳定**：官方接口，接口变更频率远低于第三方解灰服务

**限制**（必须诚实告知用户）：

- 需要用户自己有网易云 VIP（没有就是低音质/试听）
- cookie 会过期，需要重新登录
- **不能**帮你绕过付费墙

**没有 VIP 怎么办？** 那就走 §11.2.3 的模式 2：**网易云负责"发现"，YouTube 负责"播放"**。这才是无 VIP 用户的正确路径。

#### 11.4.4 QQ 音乐的鉴权（顺带）

QQ 音乐的鉴权更复杂，musicdl 的 `qqutils.py` 展示了全貌：

```python
SECRET = "ZdJqM15EeO2zWc08"
APP_KEY = "0AND0HD6FE4HY80F"
PUBLIC_KEY = """-----BEGIN PUBLIC KEY-----...-----END PUBLIC KEY-----"""
```

**两条请求路径**：

| 路径      | endpoint                                | 音质                                   | 说明                                                                             |
| --------- | --------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------- |
| 普通 vkey | `https://u.y.qq.com/cgi-bin/musicu.fcg` | `F000`(flac), `M800`(mp3), `C600`(m4a) | 响应 `music.vkey.GetVkey.UrlGetVkey.data.midurlinfo[0].purl`                     |
| 加密 vkey | `https://u.y.qq.com/cgi-bin/musics.fcg` | `F0M0`(mflac), `O800`(mgg)             | 需要 `sign` 参数，响应 `music.vkey.GetEVkey.CgiGetEVkey.data.midurlinfo[0].ekey` |

**`sign` 算法**（musicdl 的实现，可直接移植）：

```python
@staticmethod
def sign(request: dict) -> str:
    PART_1_INDEXES = [23, 14, 6, 36, 16, 40, 7, 19]
    PART_2_INDEXES = [16, 1, 32, 12, 19, 27, 8, 5]
    SCRAMBLE_VALUES = [89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179]
    hash = hashlib.sha1(orjson.dumps(request)).hexdigest().upper()
    part1 = "".join(hash[i] for i in PART_1_INDEXES)
    part2 = "".join(hash[i] for i in PART_2_INDEXES)
    part3 = bytearray(20)
    for i, v in enumerate(SCRAMBLE_VALUES):
        part3[i] = v ^ int(hash[i*2 : i*2+2], 16)
    b64_part = re.sub(rb"[\\/+=]", b"", base64.b64encode(part3)).decode()
    return f"zzc{part1}{b64_part}{part2}".lower()
```

**登录态**（`Credential`）：`musicid`(uin) + `musickey`(从 cookie 的 `qqmusic_key` 或 `musickey` 取) + `loginType`。有 musickey 才有 VIP 音质。

**`qimei` 设备指纹**：QQ 音乐要求 `QIMEI36` 参数，来源是 `api.tencentmusic.com` 的 `GetQimei` 接口（RSA + AES 混合加密）。musicdl 里有完整的 `obtainqimei()` 实现。**但这也是最容易变的一环**——建议第一版先固定一个 qimei 值（musicdl 的 fallback 值 `6c9d3cd110abca9b16311cee10001e717614`），等真跑不通再实现动态获取。

**结论**：QQ 音乐的鉴权复杂度**显著高于**网易云。建议把 QQ 排在网易云和咪咕**之后**。

#### 11.4.5 各源鉴权复杂度对照

| 源          | 鉴权方式                            | 复杂度         | 建议顺序 |
| ----------- | ----------------------------------- | -------------- | -------- |
| **网易云**  | `MUSIC_U` cookie + eapi             | **低**         | 第 1 个  |
| **咪咕**    | 匿名即可                            | **无**         | 第 2 个  |
| **酷狗**    | 匿名 / `kg_music_id` cookie         | 低             | 第 3 个  |
| **QQ 音乐** | `musickey` + `sign` + `qimei` + RSA | **高**         | 最后     |
| Spotify     | OAuth + DRM                         | 不可行（播放） | 不做     |
| Apple Music | 开发者 token + DRM                  | 不可行（播放） | 不做     |

---

### 11.5 关于"个人使用 / 非商业"的澄清

你在问题 4 里提到项目是个人使用、更新只做开发者之间的功能测试。我理解这意味着**你自己不盈利、不分发商业产品**。

但这里有个需要澄清的技术点：

**PolyForm Noncommercial 的判定不是"你收不收钱"，而是"这个软件被用于什么目的"。** PolyForm 官方 FAQ 的立场是：非商业使用包括个人学习、私人娱乐、研究、公益组织、教育机构——**但如果你把软件分发给别人，分发行为本身需要"Distribution License"覆盖，而该许可证要求以 PolyForm NC 分发**。

具体到你的情况：

| 场景                                        | 是否可接受 musicdl              |
| ------------------------------------------- | ------------------------------- |
| 你自己 clone 下来研究、参考它的算法思路     | ✅ 可以（不构成"分发"或"链接"） |
| 你在 GitHub 上发布 adrify 的 release 二进制 | ❌ 若 vendor/link 了 musicdl    |
| 开发者之间分享 release 二进制做功能测试     | ⚠️ 仍是"分发"，仍需 PolyForm NC |
| 你自己 clone 下来研究、参考它的算法思路     | ✅ 可以（不构成"分发"或"链接"） |

**所以关键不在于你的用途，而在于你是否把 musicdl 的代码带进了产物。** 只要是：

- **读它的源码，理解算法，在 Rust 里独立实现** → 不受 musicdl 许可证约束（算法不是版权作品）
- **复制它的代码片段** → 受约束

这就是为什么 §1.1 的结论是"**只参考规格，独立实现**"。这条路线下，你的项目可以继续是 GPL-3.0，可以继续在 GitHub 上发 release，**与你的用途无关**。

**补充**：GPL-3.0 本身也允许商业使用，这个项目保持 GPL-3.0 完全没问题，不需要因为"非商业"而降级。

#### 11.5.1 网易云 cookie 的存储

现有项目已有 DPAPI 加密的 cookie jar（`accounts/<id>/cookies.enc`，Windows 用 DPAPI，Linux 用 Secret Service，macOS 用 Keychain）。**网易云的 `MUSIC_U` 应该走同一套机制**，按 provider 分账号：

```text
app_data/
  accounts/
    <account-id>/
      cookies.enc        ← YouTube cookies
  providers/
    netease/
      account.enc        ← MUSIC_U（独立加密）
```

**注意**：网易云 cookie 的加密存储要复用 `secure_store` 模块，不要另起炉灶。

---

### 11.6 第二轮后修订的分期任务表

#### P0 — 抽象层 + 移除 music-video（合并，含删除与重构）

| 任务                                                                                       | 说明         |
| ------------------------------------------------------------------------------------------ | ------------ |
| 删除 `immersive-video.tsx`、`use-source-switch.ts`、`videoUrlFor`                          | 前端清理     |
| 删除 Rust 的 `video_handler` / `spawn_video_downloader` / `video_quality` / `video_format` | 后端清理     |
| 删除 `SourceKind` / `TrackSources.selected` / `setSelected` / `setAlternate`               | 概念释放     |
| 删除 `videoQuality` 设置项与 i18n 键                                                       | 设置清理     |
| **保留并泛化 `evaluate()` → `scoreMatch()`**                                               | §11.2 的基础 |
| 定义 `ProviderId` / `ProviderTrack` / `ProviderTrackId`                                    | 类型         |
| `QueueTrack` → 复合键                                                                      | 数据模型     |
| `byVideoId` → `byTrackKey`（`ProviderRef`）                                                | 切源存储     |
| Rust 缓存键 → `<provider>_<id>`                                                            | 缓存         |
| 路由 → `/stream/:provider/:track_id`                                                       | 流服务       |

**顺序建议**：**先做删除**（纯删代码，零风险，可独立成一个 commit），**再做抽象**。这样 P0 的 diff 可读，且删除部分不需要 review 抽象设计。

#### P1 — 网易云：发现 + 播放（修订版）

| 任务                                            | 说明                                        |
| ----------------------------------------------- | ------------------------------------------- |
| Rust `crypto/eapi.rs` + `crypto/weapi.rs`       | 加密，含单元测试（固定 payload → 已知密文） |
| `providers/netease.ts`                          | 搜索、详情、每日推荐                        |
| Rust `providers/netease.rs`                     | 直链解析（含 `privileges` 判定）            |
| 网易云 cookie 登录（复用 `secure_store`）       | `MUSIC_U`                                   |
| 权限判定 UI                                     | 区分"可播/试听30秒/需VIP/灰色"              |
| 跨 provider 匹配（`scoreMatch` + YouTube 搜索） | §11.2                                       |
| **每日推荐页 = 网易云发现 + YouTube 播放**      | §11.2.3 模式 2                              |

#### P2 — 咪咕（修订版，最简单，验证抽象层）

#### P3 — 酷狗（修订版）

#### P4 — QQ 音乐（修订版，鉴权最复杂）

#### P5 — 切源 UI 完善 + 音质偏好设置（修订版）

---

### 11.7 修订后的开放问题

1. **跨 provider 匹配的错误率目标**是多少？如果误匹配率 > 5%，基于优先级的选源体验会很糟。**建议先做离线评估**：拿 50 首网易云歌，用 §11.2 的打分器跑 YouTube 搜索，人工核对命中率，再决定阈值。
2. **网易云每日推荐需要登录**（`MUSIC_U`）。没有登录态时，Explore 页的网易云 section 展示什么？空态提示 + "登录网易云"按钮？
3. **QQ 音乐的 `qimei` 动态获取**是否要做？固定值能撑多久？
4. ~~**provider 优先级设置**：默认播哪个？~~ → **已决策（2026-11-09）**：按 provider 优先级链尝试，默认 `youtube > netease > migu > kugou > qq`（因为 YouTube 无 VIP 门槛）。详见 §11.2.3。**剩余问题**：优先级里应不应该把"该源是否已登录"也作为因素？例如用户有网易云 VIP 时，是否应把 netease 提到 youtube 之前（音质更好）？
5. ~~**移除视频后 `/video/:video_id` 路由是否保留兼容**？~~ → **已决策**：直接删除（个人项目，无历史包袱）。
6. **YouTube 侧是否也 provider 化**：`innertube/` 目录是否迁到 `providers/youtube.ts`？建议 P0 抽象阶段迁走，避免两套路径并存。

---

### 11.8 已决策事项汇总（2026-11-09）

| 议题                    | 决策                              | 影响面                                                                                                     |
| ----------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| YouTube 搜索 Videos tab | **移除**                          | `innertube/search.ts`、`locale-tokens.ts`、`shared.ts`、`types.ts`、`shelf-card.tsx`、`shelf-carousel.tsx` |
| 每日推荐的播放源选择    | **按 provider 优先级链**          | §11.2.3、`providers/registry.ts`（优先级配置）、设置页新增"音源优先级"                                     |
| 首个实施阶段            | **P0 纯删除**（移除 music-video） | 前端 ~500 行 + Rust ~300 行，零行为变更风险                                                                |
