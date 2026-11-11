# YouTube → 网易云 歌曲匹配算法（移植规格书）

> **本文是一份自包含的移植规格书。** 它不依赖任何特定语言的代码库，可以直接照着
> 在 Android（Kotlin/Java）项目里实现。所有阈值、词表、正则、判定顺序都写全了，
> 实现时不需要再回头看别的文档。
>
> **实测成绩**：对 22 条人工确认的 YouTube→网易云 ground truth，**22/22 = 100%**
> （用户设定的目标是 > 90%）。
>
> **配套产物**：本文档描述的算法在 TypeScript 桌面端有一份等价实现
> （`src/lib/providers/match/`），并配了 22 条 ground truth 的**离线回放**测试
> （`src/lib/providers/match/ground-truth.test.ts`，数据在 `tests/fixtures/`）。
> Android 端移植后应当用同一份 ground truth 复现同样的 22/22。

---

## 目录

1. [要解决的问题](#1-要解决的问题)
2. [总体流水线](#2-总体流水线)
3. [数据结构](#3-数据结构)
4. [文本归一化](#4-文本归一化)
5. [标题变体与署名拆分](#5-标题变体与署名拆分)
6. [各维度一致性（分级 tier）](#6-各维度一致性分级-tier)
7. [级联排序与硬门](#7-级联排序与硬门)
8. [置信度判定](#8-置信度判定)
9. [查询计划与候选合并](#9-查询计划与候选合并)
10. [缓存](#10-缓存)
11. [网易云 eapi 搜索接口](#11-网易云-eapi-搜索接口)
12. [完整伪代码](#12-完整伪代码)
13. [移植注意事项（Android / Kotlin）](#13-移植注意事项android--kotlin)
14. [Ground truth 与验收](#14-ground-truth-与验收)
15. [已知边界与失败模式](#15-已知边界与失败模式)
16. [实现清单](#16-实现清单)

---

## 1. 要解决的问题

同一首歌在不同平台上以不同的字符串存在。要在另一个平台上找到**同一个录音**，
不是一次字符串比较，而是一次判断。

判断错误的代价是**可听见的**：匹配到错误录音会播放同一首歌的错误版本——翻唱、
Live 版、30 秒片段——而用户除了"听着不对"之外无从察觉。

因此算法刻意保守，并把两个问题分开：

- **排序** — 哪个候选是最佳匹配？
- **接纳** — 有没有候选好到可以使用？

### 1.1 为什么不能用加权求和

一个直觉的做法是给每个相似度一个权重，然后求和。**这个做法有结构性缺陷**，
不是调参能解决的：

各信号**不可通约**，而且证据本身是**离散的**：

- 标题要么带 feat 署名，要么不带。
- 专辑要么匹配，要么不匹配。
- 时长要么差 1 秒内，要么差 4 秒。

离散证据不能被连续权重折算。真实案例：`We Don't Talk Anymore` 有两个网易云
发行版——带 `(feat. Selena Gomez)` 的（搜索排名 5）和不带的（排名 0）。加权求和下：

| 候选 | rank 加分 | credit 加分 | 合计 |
|------|-----------|------------|------|
| `We Don't Talk Anymore (feat. Selena Gomez)` | 0.070 | 0.065 | 0.135 |
| `We Don't Talk Anymore` | 0.140 | 0.000 | **0.140** |

**rank 的加分把 credit 的加分抵消了**，于是平台排序更高但**错误**的版本胜出。

正确做法是**字典序比较（级联）**：最强的信号先比，弱信号只有在强信号打平时
才有发言权。弱信号**永远不能**推翻强信号。

---

## 2. 总体流水线

```
源歌曲
  │
  ├─(A) 取原始字段：title / artists[] / album / duration / sourceId
  │
  ├─(B) 清洗标题（保留 feat 署名，剥掉上传物家具）  ← 关键，见 §5.3
  │
  ├─(C) 归一化（繁→简 / NFKC / 去标点 / 去噪音词 / 记版本词）  §4
  │
  ├─(D) 生成标题变体集合（拆分署名 + 剥注释 + 分段）  §5
  │
  ├─(E) 查询缓存命中？ → 命中直接返回  §10
  │
  ├─(F) 发搜索请求（分级升级）  §9
  │
  ├─(G) 候选归一化 → 逐个打分  §6/§7
  │
  ├─(H) 硬门过滤 → 字典序排序  §7
  │
  ├─(I) 置信度判定（含次优领先幅度）  §8
  │
  └─(J) 输出 neteaseId + confidence + reason，写缓存
```

---

## 3. 数据结构

### 3.1 源歌曲（SourceSong）

```kotlin
data class SourceSong(
    val title: String,             // 原始标题（含 feat 署名、含上传物家具）
    val artists: List<String>,     // 已拆分的艺人名
    val album: String?,            // 可空
    val durationSeconds: Int?,     // 秒，可空（用户上传可能没有）
    val sourceId: String?,         // YouTube videoId 等，用于缓存键
)
```

### 3.2 候选歌曲（CandidateSong）

```kotlin
data class CandidateSong(
    val id: Long,                  // 网易云 song id
    val title: String,
    val artists: List<String>,
    val album: String?,
    val durationSeconds: Int?,     // 网易云返回毫秒，除 1000
    val aliases: List<String>,     // 网易云 alias 数组（可空）
    val rank: Int,                 // 平台自己的搜索排名，0-based
)
```

### 3.3 匹配结果（MatchResult）

```kotlin
enum class Confidence { HIGH, MEDIUM, LOW, FAILED }

data class MatchResult(
    val neteaseId: Long?,
    val confidence: Confidence,
    val key: MatchKey?,            // 比较元组，调试用
    val reason: String?,           // 失败原因 / 兜底原因
)

data class MatchKey(
    val title: Double,
    val credit: Double,
    val artist: Double,
    val version: Double,
    val duration: Double,
    val album: Double,
    val rank: Double,
)
```

### 3.4 归一化后的歌曲（NormalizedSong）

```kotlin
data class NormalizedSong(
    val coreTitle: String,        // 标题主体（无署名），已归一化
    val creditedTitle: String,    // 标题保留署名，已归一化
    val featArtists: List<String>,// 标题里解析出的署名者，已归一化
    val artists: List<String>,    // 平台自己的署名，已归一化
    val forms: List<TitleForm>,   // 所有合法形态（core + feats）
    val album: String?,           // 已归一化（版本限定词已摘）
    val durationSeconds: Int?,
    val versions: List<String>,   // 版本词（live/remix/...）
)

data class TitleForm(
    val core: String,             // 已归一化
    val feats: List<String>,      // 已归一化
)
```

---

## 4. 文本归一化

### 4.1 基本折叠顺序（顺序有讲究）

```
fold(text):
    1. toLowerCase()
    2. 繁体 → 简体（OpenCC twp / hkp，见 §13.1）
    3. NFKC 规范化
    4. 非 [\p{L}\p{N}] 的字符 → 空格
    5. 连续空格折叠为一个，去首尾空格
```

**为什么是这个顺序**：

- **繁→简必须在去标点之前**——转换是定义在原始字符上的。
- **NFKC 必须在去标点之前**——它把全角拉丁字母、全角数字、全角括号折成半角；
  **同时**把网易云用的半角片假名长音符 `ｰ` (U+FF70) 与 YouTube 用的全角
  `ー` (U+30FC) 折成同一个字符。

> NFKC 这一步是被实测逼出来的：网易云把《残酷な天使のテーゼ》写成
> `残酷な天使のテｰゼ`（半角长音符），不折叠则两边的标题根本不是同一个字符串，
> 罗马化别名也救不回来。

**注意**：`《》〈〉` **不要**转成括号。它们是中文**引号**，包裹作品名
（"电影《雄狮少年》主题曲"）。转成括号会产生嵌套括号
`无名的人 (电影(雄狮少年)主题曲/片尾曲)`，任何括号剥离器都读不懂，
注释就剥不掉了，歌也就匹配不上。

### 4.2 噪音词（Noise Words）——描述上传物，不描述录音

整词删除（不是子串删除，所以 `Live` 被删而 `Living` 保留）：

```
remaster  remastered  翻唱  现场  官方版  完整版  原版  伴奏
instrumental  karaoke  纯音乐  official  audio  video  mv  歌词版
topic  visualizer  visualiser  lyrics  lyric  music  hd  hq  4k
explicit  clean  version
高音质  超清  无损  官方  高品  超品  臻品  全景声  母带  试听  纯享  消音
demo  dj版
```

### 4.3 版本词（Version Words）——标记另一个切分

这些词**从标题里删除，但单独记住**。因为算法要能问"候选是否带了源没有的
版本词"，只有版本词**存活在归一化结果之外的某个地方**，这个问题才问得出来。
若直接删除，`Live While We're Young` 会变成 `while were young`，而一个 Live 版的
标题会与原版**完全相同**——无法区分。

```
live  remix  cover  翻唱  现场  钢琴  加速  减速  音效  影视  抖音  卡点
sped  slowed  reverb  nightcore  acoustic  8d  mashup  reprise  edit  piano
demo  acapella  vip  extended  phonk  guitar  orchestra  orchestral  symphony
版本  铃声  片头  片尾  广播  dj
```

**中文切分标记（实测补全，必需）**：

```
演奏曲  演奏版  演奏  伴奏版  伴唱  纯伴奏
现场版  剧场版  电视剧版  电影版  游戏版  纯音乐版  音效版  铃声版  钢琴伴奏
```

> 为什么必需：网易云上 `Gentleman (演奏曲)` 与 `Gentleman` 的标题主体、时长、
> 艺人**完全一致**，只有这个标记词能区分。补进版本词表后该 case 从
> 选错 `28864996` 变成选对 `28219175`，且对其他 case 无影响。

### 4.4 上下文注释（Annotation）

YouTube 标题常带一个括号尾巴，说明歌曲的来历：

```
无名的人 (电影《雄狮少年》主题曲/片尾曲)   →   无名的人
```

括号里的内容描述的是**上下文**而不是**名字**，而且平台对"哪个发行版带这个注释"
并不一致（有的发行版带，有的不带）。所以必须在比较之前剥掉。

**判定规则**：括号内含注释词，**或**含 `《》〈〉…·-—:：/` 等符号时，视为注释。

注释词表：

```
主题曲  片尾曲  插曲  片头曲  推广曲  ost  电视剧  电影  动画  动漫  游戏
综艺  纪录片  宣传曲  原声带  soundtrack  interlude  钢琴版
```

**剥除是迭代的**（最多 3 轮）：一个标题可能带多个尾巴
（`... (Live) (电影《…》主题曲)`），所以重复剥到不再变化为止。

### 4.5 泛化艺人名

```
various artists  various  unknown artist  unknown  未知艺术家  群星
```

这些名字说明不了是谁唱的，所以**不能否决**一个匹配，也**不能确认**。它的艺人分
固定为 `0.6`，并标记为"未验证"。

### 4.6 专辑版本限定词（Edition Qualifier）

**Deluxe / Expanded Edition 之类的限定词不属于专辑的身份，比较前必须摘掉。**

```
ALBUM_EDITION_WORDS = {
  deluxe, deluxe edition, deluxe version,
  expanded edition, expanded version,
  special edition, anniversary edition,
  standard edition, standard version,
  ultimate edition, platinum edition,
  explicit, explicit edition,
  bonus tracks, bonus track version
}
```

**两种形态**：

| 形态 | 例子 | 结果 |
|------|------|------|
| 尾部括号 | `Blacc Hollywood (Deluxe)` | `Blacc Hollywood` |
| 尾部破折号从句 | `Blacc Hollywood - Deluxe Edition` | `Blacc Hollywood` |

规则：

1. 从尾部反复剥括号（最多 3 层），**只有括号内容是已知限定词时才剥**。
   未知的括号**不动**——`Flower Of Scotland: Timeless Classics from the Land of
   the Brave` 里的括号是名字的一部分。
2. 剥一次尾部破折号从句，同样只认已知限定词。

**摘限定词必须在归一化之前做**：归一化会把 `(Deluxe)` 折成 ` deluxe `，那时候
括号已经没了，无法再识别。

> **为什么必须摘**：`Blacc Hollywood` 与 `Blacc Hollywood (Deluxe)` 是同一张专辑，
> 后者多几首；两版上的 `True Colors (feat. Nicki Minaj)` 是**同一个文件**
> （网易云给这两条记录的时长精确到毫秒都是 255.150s）。不摘的话：上传写的是
> `Blacc Hollywood`，Deluxe 那条只构成**包含**关系（tier 4.0），而**标准版**
> 名字与上传完全一致（tier 5.0）赢下专辑层，把用户要的那条挤掉。
>
> 摘掉之后两者专辑层持平，由 rank 0 决胜，`28935275` 胜出。
>
> `remastered` / `reissue` **不**在列表里：重制是不同的音频母带，不是同一条录音。

### 4.7 归一化后的产物

```
normalizeText(text):
    folded = fold(text)
    if folded 为空: return ""
    kept = folded 的词，剔除噪音词与版本词
    if kept 为空: return folded      # 整句都是噪音时保留原文，否则会「匹配一切」
    return kept
```

> "整句都是噪音"这条很重要：`Official Audio` 归一化后若变成空串，会与**任何**
> 标题都相等——那是灾难性的误匹配。

```
versionTags(text):
    return fold(text) 中属于版本词表的词
```

---

## 5. 标题变体与署名拆分

### 5.1 一个标题有多种合法形态

指的是**同一首歌**：

| 形态 | 例子 | 网易云对应 |
|------|------|-----------|
| 罗马化 | `残酷な天使のテーゼ - Zankoku na Tenshi no Thesis` | `残酷な天使のテｰゼ`（alias 带罗马化） |
| 翻译 | `紳士 - Gentleman` | `Gentleman` |
| feat 署名 | `We Don't Talk Anymore (feat. Selena Gomez)` | 同名带/不带 feat 两个版本 |
| 上下文注释 | `无名的人 (电影《雄狮少年》主题曲/片尾曲)` | `无名的人` |

**只比整个字符串，这 4 条全部无法匹配。** 所以比对双方各自的**所有变体**，取最优配对。

变体的来源：

1. 原标题
2. 剥掉署名后的核心标题
3. 剥掉上下文注释后的标题
4. 以 ` - ` 分隔的各段（`紳士` 和 `Gentleman`）
5. 尾部括号之前的部分

### 5.2 拆分 feat 署名

`(feat. X)` / `[feat. X]` / `（feat. X）` 里的名字是**参演者**，要移到艺人侧。

**平台自己的署名**与**标题里的署名**必须**分开保存**：

- YouTube：`Best Part (feat. Daniel Caesar, Lauren Jauregui)`，艺人 `Daniel Caesar`
- 网易云：`Best Part (feat. H.E.R.)`，艺人 `Daniel Caesar, H.E.R.`

两侧的"表演者名单"分别是 1 个和 2 个名字。按集合取比值是 0.5，读作"表演者只
对上一半"；按**包含关系**读则是 0.85——这才是实情：同一位表演者，候选多带一个
署名。所以标题里的 feat 名单单独记（`feats`），与平台署名分开比较。

#### 5.2.1 英文署名标记

```
^(?:feat|ft|featuring|prod)\b[.\s]
```

#### 5.2.2 中文平台的合作标记（**关键**）

中文平台把合作写成**中文标记**：

```
True Colors(合作音乐人:Nicki Minaj)
```

`splitFeat` 除了英文标记，还要认这些（都带冒号）：

```
^(?:合作音乐人|合作歌手|合作|合唱|Featured\s*Artists?|Collaborating\s*Artists?)\s*[:：]
```

以及"名字在标记**前面**"的形式（名字在 `与...合作` 之前，需要取标记之前的内容）：

```
与([^与与，,、]{1,40}?)合作\s*[:：]?
```

**扫描所有括号，不是只扫第一个**：标题可能同时带上下文注释和署名，顺序任意
（`Song (电影主题曲) (feat. X)`），要找到的是署名那个。

**顺序至关重要：先拆 feat，再剥注释。**

§4.4 的注释剥离器会摘掉**任何带冒号的括号**（`:`、`：` 都算），而中文合作标记
**恰好带冒号**。如果先剥注释，`(合作音乐人:Nicki Minaj)` 整个括号会被当成注释
摘掉，`splitFeat` 随后什么都读不到——源就**静悄悄地丢了自己的署名**。

所以 `decompose` 的顺序是：**先从原始标题拆 feat，再对剩下的主体剥注释。**

> 实测：不认这个标记时，`True Colors(合作音乐人:Nicki Minaj)` **一个网易云
> 记录都匹配不上**（整个 provider 报 `duration_mismatch`）；认了之后正确选中
> `28935275`。

### 5.3 源**必须**保留它的署名（**关键**）

**这是整个算法最容易做错的一步。**

源标题在进入匹配器之前要做一次"清洗"（剥掉上传物家具，如 `(Official Music
Video)`），但**`(feat. …)` 必须保留**。

原因：署名是**证据**。它是区分 `We Don't Talk Anymore` 两个发行版的**唯一**东西
——两首时长几乎相同（217.706 / 217.756 s）、艺人都含 Selena Gomez，唯一区别是
标题里的署名。

实测（网易云）：

| 源的署名 | 正确的那条 | 错的发行版 |
|---------|-----------|-----------|
| **保留** | ✅ `2166151146`（credit=4.0） | `401249910`（credit=1.0） |
| 丢弃 | ❌ `401249910` | — |

丢弃源的署名 → 源从不点名任何参演者 → credit tier **完全失效**（每个候选都拿
到同样的 `CREDIT_NEITHER` / `CREDIT_CAND_ONLY`）→ 错的发行版靠默认取胜。

**实现**：清洗函数需要一个 `keepCredit` 选项。

```kotlin
fun cleanTrackTitle(title: String, keepCredit: Boolean = false): String
```

- `keepCredit = true` → 匹配路径用。剥掉噪音括号，**保留** feat 括号。
- `keepCredit = false` → 歌词路径用。歌词库索引的是**光标题**，署名留在那里会
  明显减少命中（实测 `Die For You (feat. Ariana Grande)` 5 条 vs
  `Die For You` 20 条）。**两个路径需求相反，所以给同一个函数加选项，而不是
  各写一份。**

### 5.4 清洗时剥掉哪些括号

括号内容匹配下列任一模式时，视为上传物家具（`keepCredit=false` 时剥掉）：

```
official\s*|music\s*|video|audio|lyrics?|visuali[sz]er|m/?v|hd|hq|full\s*hd
|4k|8k|1080p|720p|full\s*album|colou?r\s*coded|with\s+lyrics|letra
|字幕|中文字幕|歌詞|歌词|歌詞付き|가사|자막|flac|wav|mp3|lossless
|\d{3,4}\s*kbps|hq\s*audio|audio\s*only
```

另外：标题末尾的 ` - Official Video` 这类尾巴（不在括号里的）也要剥。

> `with` **不**在这个列表里。它在 `(with Ariana Grande)` 里是署名，但在
> `Stay (With Me)` 里是名字的一部分；把它当家具的代价是直接丢掉标题。

**括号剥离必须是扫描式的，不是单条正则**：括号族会嵌套（`（feat. X）` 在
`[...]` 里），且用户上传里**未配对的括号**很常见。单条正则会把标题吃光。

---

## 6. 各维度一致性（分级 tier）

每一级返回**分级（tier）**而不是连续相似度，因为证据本身是离散的。

### 6.1 标题 tier

| tier | 值 | 含义 |
|------|-----|------|
| `TITLE_EXACT_CREDIT` | 5.0 | 标题主体相同，**且两边带同样的 feat 署名** |
| `TITLE_EXACT` | 4.0 | 标题主体相同（署名可以不同） |
| `TITLE_FUZZY_STRONG` | 2.0 | 模糊匹配接近（Jaro-Winkler ≥ 0.92） |
| `TITLE_NONE` | 0.0 | 不匹配 |

**带 feat 的标题匹配强于不带 feat 的标题匹配**——署名是**证据**，不是噪音。

**标题 tier 回答"是不是同一首歌"，credit tier 回答"是不是同一个发行版"。**
所以标题 tier 只在**两边带完全相同的 feat 名单**时给 5.0；只要主体相同就给 4.0，
署名是否一致交给 credit tier 判断。

> **实现要点**：变体必须**保留原始字符串**再拆 core/feats。若先把标题归一化再拆，
> 括号已经消失，feat 名单就永远读不出来——`TITLE_EXACT_CREDIT` 会变成死代码。

**比较范围**：源的**所有变体** × 候选的**所有变体**，再加上候选的 **alias**
（网易云的 `alias` 数组）。

一个带 feat 的标题会产出**两种形态**：带署名的那一种，和剥掉署名的主体。
两种都参与比较，取最优配对。

比较顺序：

1. 遍历所有形态对，核心相同即命中（取最高 tier）。命中 ≥ 4.0 直接返回。
2. 用候选的 alias 重复第 1 步。命中 ≥ 4.0 直接返回。
3. 都没有 → 模糊比较（Jaro-Winkler），≥ 0.92 给 `TITLE_FUZZY_STRONG`。

**模糊比较的包含性折扣**（重要）：

Jaro-Winkler 对"短标题恰好是长标题前缀"过于慷慨：`告白` vs `告白气球` 得 0.888，
但这是**错的**——它们是两首歌。所以当一个标题完全包含在另一个里时要打折：

```
shorter = 较短的那个, longer = 较长的那个
coverage = shorter.length / longer.length

若 longer 以 shorter 开头:  factor = 0.55 + 0.45 * coverage
否则:                      factor = 0.70 + 0.30 * coverage
否则（不包含）:            factor = 1.0
```

折扣后仍要 ≥ 0.92 才算 `TITLE_FUZZY_STRONG`。**下限不是 0**：一个确实是同一首歌
但署名不同的标题（`Best Part` 在 `Best Part (feat. H.E.R.)` 里面）仍应算点分。

### 6.2 署名（credit）tier

| tier | 值 | 含义 |
|------|-----|------|
| `CREDIT_EXACT` | 4.0 | 两边都有 feat，且名单相同 |
| `CREDIT_PARTIAL` | 3.0 | 两边都有 feat，名单有交集 |
| `CREDIT_NEITHER` | 3.0 | 两边都没有 feat |
| `CREDIT_CAND_ONLY` | 3.0 | 只有候选带 feat |
| `CREDIT_SOURCE_ONLY` | 1.0 | 只有源带 feat（源在找带署名的那个发行版） |
| — | 0.5 | 两边都有 feat，但名单**完全不相交** |

最后一行是"署名对不上"的最强信号：源在找带 Selena Gomez 的发行版，候选带的
是另一个人，那多半是另一个发行版。

#### 6.2.1 `CREDIT_CAND_ONLY` 必须 ≥ `CREDIT_NEITHER`（**关键**）

**只有候选带 feat 时，它的 tier 必须 ≥ 两边都不带 feat。**

这一条曾经是反的（`CREDIT_CAND_ONLY = 2.0` < `CREDIT_NEITHER = 3.0`）。因为
credit tier 在级联里排在**第 2 位**（在 artist、duration 之前），这个方向搞反
的后果是致命的：

```
源因为 §5.2.2 的中文合作标记丢了署名
  → 源的两个 feat 名单都空
  → 正确的候选（带 (feat. Nicki Minaj)）拿到 CREDIT_CAND_ONLY = 2.0
  → 那些同名的无关翻唱（安田レイ、The Weeknd 等，没有署名）拿到 CREDIT_NEITHER = 3.0
  → 翻唱在 credit 这一层就赢了
  → 翻唱随后过不了时长门
  → 整个 provider 报 NO MATCH reason=duration_mismatch
```

**带署名的候选是更具体的那个**，它不该排在"什么都没说"的候选后面。现在
`CREDIT_CAND_ONLY = 3.0`，与 `CREDIT_NEITHER` 持平，让 artist 与 duration 去决定。

### 6.3 艺人一致性

返回 `(分数, 是否可验证)`。

| 情形 | 分数 | 可验证 |
|------|------|--------|
| 源的艺人**全部**出现在候选里 | 1.0 | 是 |
| 名单有交集 | 交集数 / max(两边集合大小) | 是 |
| 名字**包含**（`刘伟德` ⊂ `victor 刘伟德`） | ≤ 0.9 | 是 |
| 源是泛化名 | 0.6 | **否** |
| **跨文字系统**且无交集 | 0.6 | **否** |
| 完全无交集且同文字系统 | 0.0 | 是 |

**包含关系的分数**：

```
coverage = 较短.length / 较长.length
若 coverage ≥ 0.5:  score = 0.55 + 0.45 * coverage
否则:                score = 0.50 * coverage
```

（短名字被包含是有歧义的——`keshi` ⊂ `keshiy`；长名字不是。）

**文字系统判定**：统计名字里的字母落在哪些 Unicode 区段：

| 区段 | 归类 |
|------|------|
| U+3400–U+4DBF, U+4E00–U+9FFF, U+F900–U+FAFF | cjk |
| U+3040–U+30FF (假名), U+AC00–U+D7AF (谚文) | cjk |
| < U+0250 且非 cjk | latin |

同时含 cjk 与 latin → `mixed`；只有 cjk → `cjk`；只有 latin → `latin`；否则 `other`。

**跨文字系统的判定**：源集合与候选集合的 script 集合里，一个含 `cjk`、另一个含
`latin`（`mixed` 也算含 cjk 或 latin）。

两条实测发现：

- **候选多出的艺人不是矛盾，是"描述更全"。** 网易云发行版常把乐团 + 乐团 +
  指挥家一起署名，源只署主艺人。候选署名更全**不代表更差**——所以"源的艺人
  全部出现在候选里"直接给 1.0。
- **跨文字系统的艺人不匹配是"无法验证"，不是"已证伪"。** 网易云的艺人对象
  **不带 alias**（`artist.alias` 恒为 `[]`），所以 `Yoko Takahashi` vs
  `高橋洋子`、`Angela Zhang` vs `张韶涵` 无法证伪——它不能否决一个标题和
  时长都精确吻合的候选。

> **这条宽容是有代价的，而且代价必须说清楚。** `RyaVocal` 翻唱的《晴天》与
> `高橋洋子` 的《残酷な天使のテーゼ》，在平台元数据里是**同一个形状**：
> 标题精确吻合、时长精确吻合、艺人分属不同文字系统、没有任何可用于桥接的
> alias。所以算法**无法**把它们分开。
>
> ground truth **依赖**这条宽容——`残酷な天使のテーゼ` 与 `无名的人` 两条都是
> 跨文字系统的正确匹配。若拒绝一切跨文字系统的候选，这两条会一起丢掉。
>
> **结论**：同文字系统的艺人完全不匹配 → **致命**（§7.2）；跨文字系统 →
> **无法验证 → 放行**。代价是「用另一种文字署名的翻唱」无法被识别，这是平台
> 元数据的性质，不是算法的缺陷。

### 6.4 时长 tier

| tier | 差值（秒） | 值 |
|------|-----------|-----|
| `DURATION_EXACT` | ≤ 1.5 | 5.0 |
| `DURATION_CLOSE` | ≤ 3 | 4.0 |
| `DURATION_NEAR` | ≤ 6 | 3.0 |
| `DURATION_FAR` | ≤ 10 | 2.0 |
| `DURATION_FARTHER` | ≤ 20 | 1.0 |
| `DURATION_NONE` | 更远 | 0.0 |
| `DURATION_NONE` | **任何一侧未知** | 0.0 |

> 移植时**直接照抄这六个常量名与数值**。级联与硬门都依赖它们：
> 时长门用的是 `DURATION_FARTHER`（1.0），"强置信度"用的是 `DURATION_CLOSE`（4.0）。

tier 之所以紧，是因为**精确时长正是区分同一首歌的多个发行版的东西**：
`Soft Spot` 204.223 s 与 `Soft Spot (Acoustic)` 208.039 s 相差 3.8 s。

> 实测：把 YouTube 的时长换成歌单标签的四舍五入值（app 实际持有的），
> 成功率**不变**（100%）。所以**不需要**为此多发一次 player 请求。

**"未知"不是"不符"。** 某些平台的搜索接口不返回时长，用户上传的曲目也可能没有
时长。**没有证据**与**证据表明不符**是两件事，所以时长门与时长阈值在
"两侧都拿不到时长"时被**豁免**，而不是失败——否则那些平台永远不可能出现在
音源选择器里。

实现上由 `durationKnown` 标志表达（见 §7.2）。

### 6.5 专辑 tier

| tier | 值 | 含义 |
|------|-----|------|
| `ALBUM_EXACT` | 5.0 | 同一个专辑名 |
| `ALBUM_CONTAINED` | 4.0 | 一个名字包含另一个 |
| `ALBUM_CLOSE` | 3.0 | Jaro-Winkler ≥ 0.7 |
| `ALBUM_FAIR` | 2.0 | Jaro-Winkler ≥ 0.5 |
| `ALBUM_DIFFERENT` | 1.0 | 不同 |

两条实测发现：

- **专辑标识的是"发行版"。** YouTube 的专辑字段和标题来自同一份发行方元数据，
  所以一首歌有多个网易云专辑版本时，专辑能指出上传的是哪个发行版。
- **专辑字段有时是标题的罗马化。** 网易云给 `残酷な天使のテｰゼ` 的 alias 是
  `Zankoku na Tenshi no Thesis`，而 YouTube 的专辑字段带的正是这个罗马化。
  所以源的专辑也要与候选的 **alias** 比较。

> 只用 alias 做这个兜底，**绝不**用候选自己的标题：标题是跟源的**标题**比的，
> 拿专辑去比标题会让每个自命名单曲都拿到满分专辑匹配。

### 6.6 版本（version）tier

| tier | 情形 | 值 |
|------|------|-----|
| `VERSION_MATCH` | 两边版本词一致 | 1.0 |
| `VERSION_MISMATCH` | 候选带了源没有的版本词 | 0.85 |
| `VERSION_MISSING` | 源带了候选没有的版本词 | 0.95 |

**版本词是折扣，永远不是否决。** `Beaté (Piano)` 是网易云上 Jordan Critz 的
**唯一**一版 `Beaté`；`Got It (PHONK)` 是唯一时长对得上的那版。直接否决会误杀。

### 6.7 平台自己的排名（rank）

```
rankScore(rank):
    若 rank < 0:  return 0.0            // 未排名，视为页尾
    return 1 / (1 + rank / 5)
```

rank 0 → 1.0，衰减到页尾趋近 0。**双曲**而非线性，因为 rank 0 与 rank 3 的差别
远大于 rank 60 与 rank 63。

实测：18 条"歌曲确实存在于搜索结果中"的 case 里，ground truth 的排名是——

| 排名 | 数量 |
|------|------|
| 0 | **14** |
| ≤ 2 | 16 |
| ≤ 5 | 17 |
| 中位数 | **0** |

所以平台的排序是**强先验**——但它是级联的**最后一级 tie-breaker**，不是可以
推翻标题的先验。

### 6.8 Jaro-Winkler 实现

标准算法，直接实现即可（不要引第三方库，手写就够）：

```
jaroWinkler(a, b):
    if a == b: return 1.0
    if a 为空或 b 为空: return 0.0
    j = jaro(a, b)
    if j == 0: return 0.0
    prefix = 公共前缀长度，上限 min(4, |a|, |b|)
    return j + prefix * 0.1 * (1 - j)

jaro(a, b):
    matchWindow = max(0, floor(max(|a|,|b|) / 2) - 1)
    aMatched, bMatched = 全 false
    matches = 0
    for i in 0 until |a|:
        start = max(0, i - matchWindow)
        end   = min(i + matchWindow + 1, |b|)
        for j in start until end:
            if bMatched[j]: continue
            if a[i] != b[j]: continue
            aMatched[i] = true; bMatched[j] = true; matches++; break
    if matches == 0: return 0.0
    transpositions = 0; k = 0
    for i in 0 until |a|:
        if not aMatched[i]: continue
        while not bMatched[k]: k++
        if a[i] != b[k]: transpositions++
        k++
    half = transpositions / 2
    return (matches/|a| + matches/|b| + (matches - half)/matches) / 3
```

**前缀奖励上限 4 个字符**（Winkler 原论文的规定）：前缀奖励是给"开头相同"的，
放得太长会让两个只是开头相似的标题无论后面差多远都显得相似。

---

## 7. 级联排序与硬门

### 7.1 比较键

每个候选得到一个**元组键**，按级联顺序排列：

```
key = (title, credit, artist, version, duration, album, rank)
```

排序用元组的**字典序**比较：`title` 先比，平了才比 `credit`，以此类推。

> **元组比较天然带 margin**：一个候选只在最后一级赢，说明它并没有被**识别**出来，
> 只是碰巧排在了一串平手候选的前面。这正是"领先幅度"不需要另设数值阈值的原因。

### 7.2 硬门（gates）

在排序之前，每个候选必须通过：

```
GATE_TITLE    = TITLE_FUZZY_STRONG  // 2.0
GATE_DURATION = DURATION_FARTHER    // 1.0
STRONG_TITLE  = TITLE_EXACT         // 4.0
STRONG_DURATION = DURATION_CLOSE    // 4.0
```

1. **标题门**：`title ≥ GATE_TITLE`（2.0）——否则是**另一首歌**。
2. **时长门**：`duration ≥ GATE_DURATION`（1.0，差 ≤ 20 s）——否则是另一个**录音**。
   **仅当两侧确实有可比时长时才生效**（`durationKnown == true`）。
3. **艺人门**：`artist < 0.5` 时——
   - 艺人**可验证**（同文字系统、零交集）→ **致命**，直接淘汰。
   - 艺人**不可验证**（跨文字系统）→ 只有当 `title ≥ STRONG_TITLE`（4.0）
     **且** `duration ≥ STRONG_DURATION`（4.0，差 ≤ 3 s）才放行。这正是"同一录音
     的两种文字系统"的签名。

> 第 3 条的两个分支不是一回事，代价也不同：
> **同文字系统的翻唱会被拒绝**（`林俊杰` 的《告白气球》进不了用户的收藏），
> **跨文字系统的翻唱无法被拒绝**——平台没有给出任何可用于区分的元数据。

### 7.3 级联顺序

```
title → credit → artist → version → duration → album → rank
```

每一级回答一个不同的问题，按平台元数据**能可靠回答的程度**排序：

| 级别 | 问题 | 为什么在这个位置 |
|------|------|----------------|
| **title** | 是不是同一首歌？ | 最可靠的信号 |
| **credit** | 是不是同一个**发行版**？ | 带 feat 与否区分发行版 |
| **artist** | 是不是同一**表演者**？ | 可靠，但跨文字系统会"无法验证" |
| **version** | 是不是同一个**切分**？ | 平台唯一录音有时就是带版本词那版 → 只能折扣，不能否决 |
| **duration** | 是不是同一**录音**？ | 精确时长能区分同一首歌的多个发行版 |
| **album** | 是哪个**发行版**？ | 专辑名标识发行版，但自命名专辑无信息量 |
| **rank** | 平台自己的**看法** | 最后一级 tie-breaker |

**顺序是实测出来的**（对 21 种单点交换各跑一次 ground truth）：

| 顺序 | 成功率 |
|------|--------|
| **设计顺序** `title > credit > artist > version > duration > album > rank` | **100.0%** |
| `title > credit > artist > version > album > duration > rank` | 95.0% |
| `title > credit > artist > version > duration > rank > album` | 95.0% |
| `title > credit > artist > version > rank > duration > album` | 90.0% |
| `title > credit > artist > rank > duration > album > version` | 75.0% |
| `title > rank > artist > version > duration > album > credit` | 70.0% |
| `rank > credit > artist > version > duration > album > title` | 65.0% |

**结论**：`title` 必须第一，`rank` 必须最后。中间四级的相对次序在这批数据上
不敏感，但按上表的可靠性排序放置，因为它们回答的问题本就有先后。

> **注意**：时长与作者**已经**是**硬门**（§7.2）了。硬门在排序**之前**执行——
> 一个标题对不上或艺人被**证伪**的候选直接出局，根本进不了排序。所以把这两项
> 在排序里提前，**不改变任何候选的生死**，只改变已经活下来的候选之间的次序。
> 而在那批活下来的候选之间，标题和署名才是真正的区分者。
>
> **把时长提到最前反而更危险**：翻唱和原作的时长可以**完全相同**（同一首歌的
> 翻唱常常连秒数都一样），时长根本区分不了它们。

---

## 8. 置信度判定

```
THRESHOLDS = {
    high:   { title: TITLE_EXACT (4.0),    artist: 0.6, duration: DURATION_CLOSE (4.0) },
    medium: { title: TITLE_EXACT (4.0),    artist: 0.4, duration: DURATION_FAR   (2.0) },
    low:    { title: TITLE_FUZZY_STRONG (2.0), artist: 0, duration: DURATION_NONE (0.0) },
}
```

| 级别 | 条件 |
|------|------|
| `HIGH` | title ≥ 4.0 且 artist ≥ 0.60 且 duration ≥ 4.0 |
| `MEDIUM` | title ≥ 4.0 且 artist ≥ 0.40 且 duration ≥ 2.0，且**领先**次优 |
| `LOW` | title ≥ 2.0，且**领先**次优 |
| `FAILED` | 未过门，或不领先 |

- **时长阈值在两侧拿不到时长时被豁免**（§6.4）。
- **"领先"** = 键**字典序严格大于**次优的键。没有次优时视为领先。
- **跨文字系统时 artist 固定 0.6**，所以 `HIGH` 需要 artist ≥ 0.60——刚好卡在
  边界上，`0.6 >= 0.6` 成立。

> **置信度是关于"元数据吻合程度"的陈述，不是关于"是不是原版"的保证。**
> 跨文字系统时（§6.3），算法会诚实地把一个"标题精确、时长精确、艺人不可验证"
> 的候选报成 `HIGH`——因为在平台给出的元数据里，它确实完美吻合。算法没有办法
> 报出"我其实不确定"，因为**它真的不确定**：没有证据能让它区分。
>
> UI 上应该把这一点**可见**：音源选择器显示匹配置信度与候选列表，让用户能
> 看到还有别的候选。跨文字系统的情形下值得去看一眼。

### 8.1 翻唱兜底（Cover Fallback）

`HIGH`/`MEDIUM` 都要求艺人基本吻合。这对**收藏**是对的（把翻唱写进用户自己的
歌单是错的），对**播放**是错的——一首长度相同的翻唱是能用的替代品。

所以有第二遍：如果没有任何候选达到 `LOW`，那么**标题与时长都强吻合**的候选
被作为 `LOW` 接纳（封面替代）：

```
isCoverFallback(score):
    return score.title >= TITLE_EXACT (4.0) && score.duration >= DURATION_CLOSE (4.0)
```

它**永远不够格**写进用户自己的收藏。

> 注意：被"艺人门"直接淘汰的候选（**已证实的**艺人不符）**不会**进入这个
> 兜底——它是另一首歌的演唱，不是这一首歌的翻唱替代。

### 8.2 失败原因（用于日志 / UI）

```
failureReason(best, secondKey):
    if best.title < 2.0:                    return "title_mismatch"
    if best.artist < 0.5:
        if best.artistVerified == false:     return "artist_unverifiable"
        return "artist_mismatch"
    if best.duration < 1.0 && durationKnown: return "duration_mismatch"
    if secondKey != null && compareKeys(best.key, secondKey) <= 0:
                                              return "ambiguous"
    return "low_score"
```

另有 `"no_candidates"`（平台返回空）与 `"search_failed"`（平台不可达）两个
**与匹配器无关**的原因——它们是"目录问题"而不是"匹配问题"，区分它们对排查很
重要。

---

## 9. 查询计划与候选合并

### 9.1 为什么一个 query 不够

平台自己的排序是**强先验**（§6.7），但排序**只对实际发出的那个 query 有效**，
而单条 query 在两侧不一致时会失效：

| query | 结果 |
|-------|------|
| `紳士 - Gentleman Victor Lau Princess Ai`（标题 + 全部艺人） | 1 条，**且是错的** |
| `紳士 - Gentleman`（标题 + 第一位艺人） | 正确歌曲在 **rank 0** |
| `残酷な天使のテーゼ`（单独） | 正确的歌**根本不在页面上** |
| `Zankoku na Tenshi no Thesis Yoko Takahashi` | 正确歌曲在 **rank 0** |

**query 太具体反而会漏**——它返回的是**更短**的页面，而平台在短页面上的排序更差。

### 9.2 两条实测的结论

| query 形态 | 成功率 |
|-----------|--------|
| `标题 + 第一位艺人` | **100.0%** |
| `标题 + 全部艺人` | 95.0% |
| `标题` 单独 | 90.0% |
| `标题 + 第一位艺人`，再 `标题` | 100.0% |

**结论：只带第一位艺人**，不要带全部艺人。

### 9.3 查询的构造

```
buildQueries(source):
    title = toSimplified(searchTitle(source.title))
    firstArtist = toSimplified(source.artists[0])  // 若有

    queries = []
    queries += [ firstArtist != "" ? "$title $firstArtist" : title ]   // 第 1 级
    queries += [ title ]                                                // 第 2 级
    去重、去空白
```

`searchTitle` 的作用：把标题里的署名**翻译**成平台自己的写法。

```
searchTitle(title):
    (coreTitle, featArtists) = splitFeat(title)
    stripped = stripAnnotation(coreTitle)
    若 featArtists 为空: return stripped
    return "$stripped (feat. ${featArtists.join(", ")})"
```

> **为什么不能把中文标记原样发出去**：实测搜
> `True Colors(合作音乐人:Nicki Minaj) Wiz Khalifa`，网易云返回 40 条**完全无关**
> 的歌，正确的 `28935275` **根本不在页面上**；搜
> `True Colors (feat. Nicki Minaj) Wiz Khalifa`，它排在 **rank 0**。
>
> **为什么不能把署名整个丢掉**：丢掉就分不清"带署名的发行版"和"不带署名的那个"，
> 而 credit tier 正是靠这个区分的。

### 9.4 分级升级（Escalation）

计划是**分级**的，而不是一次全发：

- **第 1 级**：`标题 + 第一位艺人`。绝大多数歌在这一级就有把握的答案。
- **第 2 级**：第 1 级没有产出**有把握**的答案时，再发 `标题` 单独。

实测：第 1 级单独就是 **22/22 = 100%**，**0 条**需要升级。

> 升级的判据是"有没有把握"（`HIGH` 或 `MEDIUM`），不是"答没答对"——一个
> **错误但自信**的答案不会触发升级。所以升级是安全网，不是主要路径。

### 9.5 候选合并

多条 query 的结果按 id 合并，一个候选保留它在**任何** query 里达到过的**最好**
rank（最小的那个）。这正是平台自己的排序作为**信号**（而非噪音）所需要的形态。

合并时，**用产生更好 rank 的那次 query 的元数据覆盖**——后一次的结果可能带了
前一次没有的专辑名或 alias。

### 9.6 并发

多个平台的搜索是**并发**的：它们是彼此独立的第三方，串行会把等待时间乘起来。

### 9.7 平台不可达的处理

一个平台失败**不能**拖垮整次搜索——别的平台可能仍然有这首歌。失败时记录
`search_failed` 并继续。

---

## 10. 缓存

**缓存的是候选列表，不是排序结果。** 排序依赖用户的优先级顺序，那个随时会变；
候选列表是查询与目录的属性，几乎不变。

**缓存键**：

```
若有 sourceId:  "src:$sourceId"
否则:          "${归一化后的 coreTitle}|${排序后的 artists 用逗号连接}"
```

**TTL**：`MATCH_CACHE_TTL = 10 * 60 * 1000`（10 分钟，与音源可用性层的过期窗口
一致，两者一起过期）。

**在途去重**：`withMatchCache` 同时维护一张"在途请求"表，两个调用方问同一个
key 时只发一次请求。缓存回答的是"这个搜过了吗"，在途表回答的是"这个**正在**
搜吗"——两个问题要分开。

---

## 11. 网易云 eapi 搜索接口

### 11.1 端点

```
POST https://interface.music.163.com/eapi/search/get
Content-Type: application/x-www-form-urlencoded
Cookie: <与 header 签名字段一致的设备字段>

form:
  params = eapiEncrypt("/api/search/get", payloadJson)
```

### 11.2 payload

```json
{
  "s": "<搜索词>",
  "type": 1,
  "limit": 100,
  "offset": 0
}
```

**`limit` 必须是 100**（页面深度）。实测答案常常在 rank 5~60 之间——要 10 条时
平台返回的全是翻唱，正版根本不在页面上。

### 11.3 eapi 加密协议

```
eapiEncrypt(url, text):
    digest = md5hex("nobody{url}use{text}md5forencrypt")
    plain  = url + "-36cd479b6b5-" + text + "-36cd479b6b5-" + digest
    cipher = AES-128-ECB, key = "e82ckenh8dichen8", PKCS7 padding
    return hex(cipher).uppercase()
```

常量：

| 名称 | 值 |
|------|-----|
| AES key | `e82ckenh8dichen8`（16 字节，公开常量） |
| 摘要盐 | `nobody{url}use{text}md5forencrypt` |
| 数据盐 | `-36cd479b6b5-` |
| endpoint path | `/api/search/get` |

### 11.4 必须带的 header

**payload 里签名的 `header` 字段与 HTTP `Cookie` 头必须一致**——平台会拿签名的
`header` 与收到的 `Cookie` 比对，不一致就当匿名请求处理。

设备 header：

```json
{
  "os": "pc",
  "appver": "3.1.17.204416",
  "osver": "Microsoft-Windows-10-Professional-build-19045-64bit",
  "deviceId": "pyncm!",
  "channel": "netease",
  "versioncode": "140",
  "mobilename": "",
  "buildver": "200000000000",
  "resolution": "1920x1080",
  "__csrf": "",
  "requestId": "1_1"
}
```

Cookie 头按 `DEVICE_HEADER_FIELDS` 的顺序拼：
`os, appver, osver, deviceId, channel, versioncode, mobilename, buildver, resolution, __csrf, requestId`

另外还要带浏览器形态的 `User-Agent` 与 `Referer: https://music.163.com/`，否则
Web API 会拒。

> Android 端要额外注意：请求要**直连**或走自己的代理，不要依赖系统 WebView 的
> cookie jar。`MUSIC_U` 与 `__csrf` 是可选的（登录态才有），匿名搜索不需要。

### 11.5 响应解析

搜索结果在 `result.songs` 数组里：

```json
{
  "id": 28935275,
  "name": "True Colors (feat. Nicki Minaj)",
  "artists": [{ "name": "Wiz Khalifa" }, { "name": "Nicki Minaj" }],
  "album": { "name": "Blacc Hollywood (Deluxe)", "picUrl": "..." },
  "alias": ["..."],
  "duration": 255150,          // 毫秒
  "fee": 0
}
```

**关键字段**：

| 字段 | 说明 |
|------|------|
| `id` | 歌曲 id |
| `name` | 标题 |
| `artists[].name` | 艺人列表 |
| `album.name` | 专辑名 |
| **`alias`** | **该录音的其它名字**（罗马化、译名等）——**必须读** |
| `duration` | 毫秒 |
| `fee` | 8 = VIP 专享 |

> ⚠️ **字段名的坑**：搜索接口用 **`alias`**，紧凑的推荐接口用 **`alia`**。
> 读错字段会让罗马化 case **假失败**——看起来像算法坏了，其实是解析坏了。
>
> 实测：`eapi/search/get` 的搜索行里 `alias` 有值（`3341072499` 的 alias 是
> `["Zankoku na Tenshi no Thesis"]`），而 `alia` 是 `undefined`。
>
> 实测结论：只读 `alias` 一个字段就是 100%；加上 `transNames` / `tns` 没有额外
> 贡献。**只读 `alias` 即可。**

### 11.6 alias 为什么重要

网易云给一个录音登记了"另一个名字"，而那个名字往往正是它在**用户来源的那个
平台**上被叫的名字——也就是源侧带的那个名字。所以 alias 命中是**强证据**。

实测：完全不读 alias → 成功率 95%（罗马化 case 失败）。读 `alias` → **100%**。

---

## 12. 完整伪代码

```kotlin
// ============================================================
// 主入口
// ============================================================
fun matchSong(
    source: SourceSong,
    search: (String) -> List<CandidateSong>,   // 平台搜索
): MatchResult {

    // ---- (B) 清洗标题：保留 feat 署名 ----
    val canonicalTitle = cleanTrackTitle(source.title, keepCredit = true)

    val src = normalizeSong(
        title = canonicalTitle,
        artists = source.artists,
        album = source.album,
        duration = source.durationSeconds,
    )

    // ---- (E) 缓存 ----
    val key = cacheKey(source)
    cache.read<List<CandidateSong>>(key)?.let { cached ->
        // 用缓存的候选重新评分（TTL 内目录几乎不变，但评分规则可能变过）
        return rankAndDecide(cached, src, source)
    }

    // ---- (F) 查询分级升级 ----
    val queries = buildQueries(source)
    val merged = LinkedHashMap<Long, CandidateSong>()
    var best = rankAndDecide(merged.values.toList(), src, source)

    for (q in queries) {
        val rows = search(q)
        rows.forEachIndexed { index, row ->
            val existing = merged[row.id]
            if (existing == null || index < existing.rank) {
                merged[row.id] = row.copy(rank = index)
            }
        }
        best = rankAndDecide(merged.values.toList(), src, source)
        if (best.confidence == HIGH || best.confidence == MEDIUM) break
    }

    cache.write(key, merged.values.toList())
    return best
}

// ============================================================
// 排序与判定
// ============================================================
fun rankAndDecide(
    candidates: List<CandidateSong>,
    src: NormalizedSong,
    source: SourceSong,
): MatchResult {

    if (candidates.isEmpty()) {
        return MatchResult(null, FAILED, null, "no_candidates")
    }

    val scored = candidates.map { cand ->
        val candNorm = normalizeSong(
            title = cand.title,
            artists = cand.artists,
            album = cand.album,
            duration = cand.durationSeconds,
        )
        val aliases = normalizeAliases(cand.aliases)

        val artist = artistAgreement(
            srcArtists = artistsOf(src),
            candArtists = artistsOf(candNorm),
        )
        val effectiveRank = if (cand.rank >= 0) cand.rank else -1

        val components = MatchKey(
            title    = titleAgreement(src, candNorm, aliases),
            credit   = creditAgreement(src.featArtists, candNorm.featArtists),
            artist   = artist.score,
            version  = versionAgreement(src.versions, candNorm.versions),
            duration = durationAgreement(src.durationSeconds, candNorm.durationSeconds),
            album    = albumAgreement(src.album, candNorm.album, aliases),
            rank     = rankScore(effectiveRank),
        )

        val durationKnown = (src.durationSeconds ?: 0) > 0 &&
                            (candNorm.durationSeconds ?: 0) > 0

        ScoredCandidate(cand, components, artist.verified, durationKnown)
    }.sortedWith { a, b -> compareKeys(b.components, a.components) }   // 降序

    val best = scored[0]
    val secondKey = scored.getOrNull(1)?.components

    // ---- 置信度 ----
    val confidence = decideConfidence(best, secondKey)
    if (confidence != FAILED) {
        return MatchResult(best.cand.id, confidence, best.components, null)
    }

    // ---- 翻唱兜底 ----
    if (isCoverFallback(best.components)) {
        return MatchResult(best.cand.id, LOW, best.components, "cover_fallback")
    }

    return MatchResult(null, FAILED, best.components, failureReason(best, secondKey))
}

// ============================================================
// 置信度
// ============================================================
fun decideConfidence(best: ScoredCandidate, secondKey: MatchKey?): Confidence {
    if (!passesGates(best)) return FAILED

    val c = best.components
    val ahead = secondKey == null || compareKeys(c, secondKey) > 0
    val durationKnown = best.durationKnown

    // HIGH
    if (c.title >= 4.0 && c.artist >= 0.60 &&
        (c.duration >= 4.0 || !durationKnown)) return HIGH

    // MEDIUM
    if (c.title >= 4.0 && c.artist >= 0.40 &&
        (c.duration >= 2.0 || !durationKnown) && ahead) return MEDIUM

    // LOW
    if (c.title >= 2.0 && ahead) return LOW

    return FAILED
}

// ============================================================
// 硬门
// ============================================================
fun passesGates(best: ScoredCandidate): Boolean {
    val c = best.components

    // 标题对不上 = 另一首歌
    if (c.title < 2.0) return false

    // 时长差太多 = 另一个录音（仅当两侧确实有可比时长）
    if (c.duration < 1.0 && best.durationKnown) return false

    // 艺人不符
    if (c.artist < 0.5) {
        if (!best.artistVerified) {
            // 跨文字系统 → 无法验证：需要标题与时长都近乎精确
            if (c.title < 4.0 || c.duration < 4.0) return false
        } else {
            // 已证实的艺人不符 → 致命
            return false
        }
    }
    return true
}

// ============================================================
// 字典序比较
// ============================================================
fun compareKeys(a: MatchKey, b: MatchKey): Int {
    val av = listOf(a.title, a.credit, a.artist, a.version, a.duration, a.album, a.rank)
    val bv = listOf(b.title, b.credit, b.artist, b.version, b.duration, b.album, b.rank)
    for (i in av.indices) {
        if (av[i] != bv[i]) return if (av[i] > bv[i]) 1 else -1
    }
    return 0
}
```

### 12.1 各维度的一致性函数（可直接翻译）

```kotlin
// ---- 标题 ----
fun titleAgreement(src: NormalizedSong, cand: NormalizedSong, candAliases: List<String>): Double {
    val srcForms = src.forms.ifEmpty { listOf(TitleForm(src.coreTitle, src.featArtists)) }
    val candForms = cand.forms.ifEmpty { listOf(TitleForm(cand.coreTitle, cand.featArtists)) }

    var best = 0.0
    for (sv in srcForms) {
        if (sv.core.isEmpty()) continue
        for (cv in candForms) {
            if (cv.core.isEmpty()) continue
            val t = pairTier(sv, cv) ?: continue
            if (t > best) best = t
        }
    }
    if (best >= 4.0) return best

    for (alias in candAliases) {
        if (alias.isEmpty()) continue
        for (sv in srcForms) {
            if (sv.core.isEmpty()) continue
            val t = pairTier(sv, aliasForm(alias)) ?: continue
            if (t > best) best = t
        }
    }
    if (best >= 4.0) return best

    // 模糊
    var fuzzy = 0.0
    for (sv in srcForms) {
        for (cv in candForms) {
            val v = jaroWinkler(sv.core, cv.core) * containmentFactor(sv.core, cv.core)
            if (v > fuzzy) fuzzy = v
        }
    }
    for (alias in candAliases) {
        for (sv in srcForms) {
            val v = jaroWinkler(sv.core, alias)
            if (v > fuzzy) fuzzy = v
        }
    }
    return if (fuzzy >= 0.92) 2.0 else 0.0
}

fun pairTier(a: TitleForm, b: TitleForm): Double? {
    if (a.core.isEmpty() || b.core.isEmpty()) return null
    if (a.core != b.core) return null
    // 同样的标题 + 同样的署名 = 最强证据
    if (a.feats.isNotEmpty() && b.feats.isNotEmpty() && sameSet(a.feats, b.feats)) return 5.0
    return 4.0
}

// ---- 署名 ----
fun creditAgreement(srcFeats: List<String>, candFeats: List<String>): Double {
    val srcHas = srcFeats.isNotEmpty()
    val candHas = candFeats.isNotEmpty()
    if (!srcHas && !candHas) return 3.0            // CREDIT_NEITHER
    if (srcHas && candHas) {
        if (sameSet(srcFeats, candFeats)) return 4.0        // CREDIT_EXACT
        val overlap = srcFeats.count { candFeats.contains(it) }
        return if (overlap > 0) 3.0 else 0.5                // CREDIT_PARTIAL / 不相交
    }
    if (candHas) return 3.0                    // CREDIT_CAND_ONLY（必须 ≥ 3.0！）
    return 1.0                                // CREDIT_SOURCE_ONLY
}

// ---- 艺人 ----
data class ArtistResult(val score: Double, val verified: Boolean)

fun artistAgreement(srcArtists: List<String>, candArtists: List<String>): ArtistResult {
    if (srcArtists.isEmpty() || candArtists.isEmpty()) return ArtistResult(0.0, false)

    // 泛化名：不能否决，也不能确认
    if (srcArtists.any { it == "various artists" || it == "群星" || it == "未知艺术家" }) {
        return ArtistResult(0.6, false)
    }

    val srcSet = srcArtists.toSet()
    val candSet = candArtists.toSet()

    // 源的艺人全部出现在候选里 → 候选描述更全，不是矛盾
    if (srcSet.all { candSet.contains(it) }) return ArtistResult(1.0, true)

    val intersection = srcSet.count { candSet.contains(it) }
    if (intersection > 0) {
        val unionSize = maxOf(srcSet.size, candSet.size)
        return ArtistResult(intersection.toDouble() / unionSize, true)
    }

    // 包含关系
    var best = 0.0
    for (s in srcSet) for (c in candSet) {
        if (!c.contains(s) && !s.contains(c)) continue
        val shorter = if (c.length <= s.length) c else s
        val longer = if (c.length <= s.length) s else c
        best = max(best, containmentScore(shorter.length.toDouble() / longer.length))
    }
    if (best > 0) return ArtistResult(min(best, 0.9), true)

    // 跨文字系统 → 无法验证
    val srcScripts = srcArtists.map { scriptOf(it) }.toSet()
    val candScripts = candArtists.map { scriptOf(it) }.toSet()
    val crossScript =
        (srcScripts.contains("cjk") && candScripts.contains("latin")) ||
        (srcScripts.contains("latin") && candScripts.contains("cjk"))
    if (crossScript) return ArtistResult(0.6, false)

    return ArtistResult(0.0, true)
}

fun containmentScore(coverage: Double): Double =
    if (coverage >= 0.5) 0.55 + 0.45 * coverage else 0.5 * coverage

// ---- 时长 ----
fun durationAgreement(src: Int?, cand: Int?): Double {
    if (src == null || src <= 0 || cand == null || cand <= 0) return 0.0
    val diff = abs(src - cand)
    return when {
        diff <= 1.5 -> 5.0
        diff <= 3.0 -> 4.0
        diff <= 6.0 -> 3.0
        diff <= 10.0 -> 2.0
        diff <= 20.0 -> 1.0
        else -> 0.0
    }
}

// ---- 专辑 ----
fun albumAgreement(srcAlbum: String?, candAlbum: String?, candAliases: List<String>): Double {
    if (srcAlbum.isNullOrEmpty() || candAlbum.isNullOrEmpty()) return 1.0   // ALBUM_DIFFERENT
    if (srcAlbum == candAlbum) return 5.0                                 // ALBUM_EXACT
    if (srcAlbum.contains(candAlbum) || candAlbum.contains(srcAlbum)) return 4.0  // ALBUM_CONTAINED

    val direct = jaroWinkler(srcAlbum, candAlbum)
    if (direct >= 0.85) return 5.0
    if (direct >= 0.7) return 3.0
    if (direct >= 0.5) return 2.0

    for (alias in candAliases) {
        if (alias.isNotEmpty() && srcAlbum == alias) return 5.0
    }
    return 1.0
}

// ---- 版本 ----
fun versionAgreement(srcVersions: List<String>, candVersions: List<String>): Double {
    val extra = candVersions.filter { !srcVersions.contains(it) }
    val missing = srcVersions.filter { !candVersions.contains(it) }
    if (extra.isNotEmpty()) return 0.85
    if (missing.isNotEmpty()) return 0.95
    return 1.0
}

// ---- 平台排名 ----
fun rankScore(rank: Int): Double =
    if (rank < 0) 0.0 else 1.0 / (1.0 + rank / 5.0)
```

---

## 13. 移植注意事项（Android / Kotlin）

### 13.1 繁体→简体转换

需要 **OpenCC 的短语级词典**（`twp` 或 `hkp` → `cn`），不是简单的码位表。

- `tw`（字符级）：軟體 → 软体
- `twp`（短语级）：軟體 → **软件**，記憶體 → **内存**，滑鼠 → **鼠标**

**必须用短语级**：网易云的目录是**大陆中文**，它写"软件"不写"软体"。字符级转换
会产出网易云目录里没有的词，搜索仍然落空。

- `twp` — 台湾繁体 + 大陆词汇映射，默认（YouTube 上的繁体上传多数来自台湾）
- `hkp` — 香港繁体，它的粤语特有字（係、喺）也会被转换

**Android 端的选择**：

| 方案 | 说明 |
|------|------|
| 打包 OpenCC 词典进 APK | 体积大（完整词典数十 MB），但完全离线 |
| 用 `opencc-android` / `zhconv` 之类的库 | 通常只有字符级，**不够** |
| 服务端转换 | 需要额外后端 |
| **不做转换** | 繁体上传在网易云**完全搜不到**——这是最差选项 |

> 如果走服务端或用大体积离线词典，注意**只在两个地方**调用转换：
> **查询词**（§9.3）和**归一化时**（§4.1）。不要在其它地方转。

### 13.2 NFKC 规范化

Android/Kotlin 用 `java.text.Normalizer`：

```kotlin
val normalized = Normalizer.normalize(text, Normalizer.Form.NFKC)
```

注意：Java 的 `Normalizer` 对某些字符的处理与 JS 的 `String.prototype.normalize`
一致（都基于 Unicode 标准），但**版本可能不同**。最关键的一个是
**半角片假名长音符 U+FF70 ↔ 全角 U+30FC**，两边的实现都应折叠成同一个——
若有疑问，移植后用 §14 的 ground truth 直接验。

### 13.3 正则表达式的差异

JS 与 Java/Kotlin 正则有几处必须注意：

| 项 | JS | Kotlin/Java |
|----|----|-------------|
| `\p{L}` / `\p{N}` | 需 `u` 标志：`/[^\p{L}\p{N}]+/gu` | 内建支持：`[^\\p{L}\\p{N}]+` |
| `\s` | 只含 ASCII 空白 | Java 的 `\s` 默认只含 ASCII；中文全角空格不在内，**建议显式写** `[\\s\\p{Z}]+` |
| `(?i)` | 标志 | 内建 |
| 字符类里的 `-` | 两端 | 两端 |

**建议**：把所有正则集中成一个对象，不要散落在各处。

### 13.4 Unicode 区块与码位

Kotlin 的 `Char` 是 UTF-16 码元，**不是码位**。假名/谚文/扩展汉字都在 BMP 内
（U+3040–U+30FF、U+AC00–U+D7AF、U+3400–U+4DBF、U+4E00–U+9FFF、U+F900–U+FAFF），
所以按 `Char` 判断足够。但若将来要处理超出 BMP 的字符（emoji 等），必须改用
`codePointAt`。

```kotlin
fun scriptOf(name: String): String {
    if (name.isEmpty()) return "other"
    var cjk = 0; var latin = 0
    for (ch in name) {
        if (!ch.isLetter()) continue
        val c = ch.code
        val isCjk = (c in 0x3400..0x4DBF) || (c in 0x4E00..0x9FFF) ||
                    (c in 0xF900..0xFAFF) || (c in 0x3040..0x30FF) ||
                    (c in 0xAC00..0xD7AF)
        if (isCjk) cjk++ else if (c < 0x0250) latin++
    }
    return when {
        cjk > 0 && latin > 0 -> "mixed"
        cjk > 0 -> "cjk"
        latin > 0 -> "latin"
        else -> "other"
    }
}
```

### 13.5 AES-128-ECB

Android 用 `javax.crypto`：

```kotlin
val key = SecretKeySpec("e82ckenh8dichen8".toByteArray(Charsets.UTF_8), "AES")
val cipher = Cipher.getInstance("AES/ECB/PKCS5Padding")
cipher.init(Cipher.ENCRYPT_MODE, key)
val out = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
return out.joinToString("") { "%02X".format(it) }
```

> **ECB + PKCS5/PKCS7**：JDK 的 `PKCS5Padding` 在 16 字节块上就是 PKCS7 的实现，
> 行为一致。Android 的 Conscrypt / BouncyCastle 也一致。
>
> **MD5** 用 `java.security.MessageDigest.getInstance("MD5")`，输出小写 hex。

### 13.6 网络

- **不要用 WebView 发请求**，用 `OkHttp` / `HttpURLConnection`。
- `Content-Type: application/x-www-form-urlencoded`，body 是 `params=<hex>`。
- **Cookie 头要手动拼**（§11.4），不要依赖 `CookieJar`——匿名搜索不需要登录态，
  但设备字段必须与签名一致。
- 需要 `User-Agent` 与 `Referer`。

### 13.7 线程

搜索是**网络 IO**，放 IO 线程；匹配计算是纯 CPU，但很轻（每个候选几十次字符串
比较），可以在 IO 线程上直接做。

### 13.8 缓存

Android 上用 `DiskLruCache` 或 Room；**内存 + SharedPreferences 的两级缓存**就够
（候选列表很小，序列化成 JSON 存）。

---

## 14. Ground truth 与验收

### 14.1 数据集

22 条人工确认的 YouTube→网易云 ground truth（+1 条网易云根本没收录的，不计入
分母）。每条包含：

| 字段 | 说明 |
|------|------|
| `youtubeTitle` | YouTube 上的原始标题 |
| `youtubeArtists` | 艺人列表 |
| `youtubeAlbum` | 专辑（可空） |
| `durationSeconds` | 歌单标签的四舍五入时长（**app 实际持有的**） |
| `durationExact` | 视频自身的精确时长 |
| `neteaseId` | 人工确认的网易云 song id |
| `note` | 争议案例的证据说明 |

**配套文件**（桌面端仓库里，用于离线回放）：

| 文件 | 内容 |
|------|------|
| `tests/fixtures/ground-truth.json` | 上面这张表的机器可读版本 |
| `tests/fixtures/ground-truth-search.json` | 每个查询词对应的**真实**网易云 eapi 搜索响应快照 |
| `src/lib/providers/match/ground-truth.test.ts` | 回放测试：断言选中的是**哪个 id**，不是分数 |

> Android 端移植时，把这两个 fixture 一并带过去，用同样的断言复现 22/22。
> 快照是**离线**的：它锁住的是算法的行为，不是网易云此刻的实时排序。

### 14.2 完整清单

| # | YouTube 标题 | 艺人 | 时长 | 网易云 ID | 备注 |
|---|-------------|------|------|-----------|------|
| 1 | Auld Lang Syne | Royal Scots Dragoon Guards | 239 | `473103115` | 用户初答 `414829974` 是同一录音的另一合辑 |
| 2 | Ayo | Chris Brown, Tyga | 226 | `30512923` | **算法找到的更好答案**（见 §14.3） |
| 3 | Deep Ends | Ollie | 175 | `2051615275` | |
| 4 | 残酷な天使のテーゼ - Zankoku na Tenshi no Thesis | Yoko Takahashi | 246 | `3341072499` | 靠 alias + NFKC 才匹得上；**跨文字系统** |
| 5 | Got It | VZEUS | 131 | `2679634795` | |
| 6 | prom dress | mxmtoon | 198 | `2099993157` | |
| 7 | 愿你余生漫长 | 王贰喆 | 232 | `1425814935` | |
| 8 | 跨不过的距离 | 虎二 | 271 | `1458462128` | |
| 9 | Back To My Bed | Elderbrook | 203 | `1479683839` | 用户初答 `1479407252` 是单曲版 |
| 10 | 幕后生活 | 海洋Bo | 221 | `2103368325` | 用户初答 `2041799838` 歌名就是错的 |
| — | Nana | Иван Купала | 318 | — | **网易云未收录**，不计分母 |
| 11 | We Don't Talk Anymore (feat. Selena Gomez) | Charlie Puth | 218 | `2166151146` | **署名必须保留**（§5.3） |
| 12 | Stay With Me | 1nonly | 142 | `1486904053` | |
| 13 | Beaté | Jordan Critz | 167 | `3374488834` | 靠中文版本词 `演奏曲` 区分 |
| 14 | ツナ覚醒 | Various Artists | 98 | `29095230` | 泛化艺人名，不能否决 |
| 15 | Soft Spot | keshi | 205 | `2626568453` | 用户初答是 Acoustic 版 |
| 16 | Jhim Jhimaune Aankha | Ekdev Limbu | 207 | `2652257620` | |
| 17 | AM | T-Chenxi | 230 | `2141628303` | |
| 18 | Stand My Ground | Yonatron | 176 | `2615759502` | |
| 19 | Seena | Lunaar | 175 | `1977991026` | |
| 20 | 紳士 - Gentleman | Victor Lau, Princess Ai | 198 | `28219175` | 用户初答 `28864996`；靠 `演奏曲` 区分 |
| 21 | 无名的人 (电影《雄狮少年》主题曲/片尾曲) | Angela Zhang | 266 | `2653125161` | 上下文注释；**跨文字系统** |
| 22 | True Colors(合作音乐人:Nicki Minaj) | Wiz Khalifa | 256 | `28935275` | **中文合作标记** + 专辑 Deluxe 限定词 |

### 14.3 验收标准

**必须复现 22/22**。具体做法：

1. 用 §11 的 eapi 搜索对每条 ground truth 发一次查询（用 §9.3 构造的查询词）。
2. 把返回的候选喂给匹配器。
3. 断言选中的 `neteaseId` 与上表一致。

**必须同时跑两个时长**：

| 用哪个时长 | 期望 |
|-----------|------|
| `durationSeconds`（四舍五入，**实际持有的**） | 22/22 |
| `durationExact`（精确） | 22/22 |

四舍五入不应影响结果——这是算法该有的稳健性。

**还要跑一个"扣掉专辑"的变体**：允许 **≤ 2 条**不中。这不是失败，是**测量专辑
这一级的价值**：没有专辑时，标题、署名、时长要能独立撑起大部分匹配。

### 14.4 争议案例的证据（供移植时排查）

以下 6 条上算法与用户初填的答案不同。**元数据（标题、精确时长、专辑）三者一致
指向的一方才是对的**：

#### case 1 · Auld Lang Syne / Royal Scots Dragoon Guards

| | 网易云 `414829974`（用户初填） | 网易云 `473103115` |
|---|---|---|
| 专辑 | Music For A Royal Occasion | **Flower Of Scotland: Timeless Classics…** |
| 时长 | 237.040 s | **238.993 s** |
| YouTube 时长 | 239 s | → **差 0.007 s** |

**专辑和时长都指向 `473103115`。**

#### case 9 · Back To My Bed / Elderbrook

| | 网易云 `1479407252`（用户初填） | 网易云 `1479683839` |
|---|---|---|
| 专辑 | Back To My Bed | **Why Do We Shake In The Cold?** |
| 时长 | 202.106 s | **202.135 s** |
| YouTube 时长 | 203 s（精确 202 s） | → **差 0.135 s** |

**专辑和时长都指向 `1479683839`。**

#### case 10 · 幕后生活 / 海洋Bo

| | 网易云 `2041799838`（用户初填） | 网易云 `2103368325` |
|---|---|---|
| 歌名 | **普通人生** | **幕后生活** |
| 艺人 | 海洋Bo | 海洋Bo |
| 时长 | 202.424 s | **220.637 s** |
| YouTube 时长 | 221 s | → **差 0.363 s** |

**歌名与时长都指向 `2103368325`。**

#### case 16 · Soft Spot / keshi

| | 网易云 `2639918917`（用户初填） | 网易云 `2626568453` |
|---|---|---|
| 歌名 | Soft Spot **(Acoustic)** | Soft Spot |
| 时长 | 208.039 s | **204.223 s** |
| YouTube 时长 | 205 s（精确 204 s） | → **差 0.223 s** |
| 专辑 | Soft Spot (Alternate Versions) | Soft Spot |

YouTube 描述：`Soft Spot · keshi / Soft Spot / © 2024 Island Records`。
**上传的是录音室版，不是 Acoustic 版。**

#### case 12 · We Don't Talk Anymore (feat. Selena Gomez)

用户填 `2166151146`（标题带 feat，专辑 `Nine Track Mind (Special Edition)`）。
算法原选 `401249910`（标题不带 feat，专辑 `Nine Track Mind`）。两首时长几乎相同
（217.706 / 217.756），艺人都含 Selena Gomez。**唯一区别是标题里的 feat 署名**
——而 YouTube 标题明确带了 feat。**用户填的 `2166151146` 是对的。**

#### case 2 · Ayo / Chris Brown, Tyga（算法找到了更好的答案）

用户填 `31526544 或者 29809963`（"两个都可以"）。算法选的是第三个：

| | `30512923`（算法选中） | `31526544`（用户填其一） | `29809963`（用户填其二） |
|---|---|---|---|
| 专辑 | **Fan of A Fan The Album (Deluxe Version)** | Now Thats What I Call Music! 90 | Ayo（单曲） |
| 时长 | **225.280 s** | 226.518 s | 226.247 s |
| YouTube 精确时长 | 225 s → **差 0.280 s** | → 差 1.518 s | → 差 1.247 s |
| 搜索排名 | 3 | 11 | 27 |

**上传的专辑字段写的就是 `Fan of A Fan The Album (Expanded Edition)`**——
`30512923` 是这张原专辑上的那一版，`Deluxe` 与 `Expanded` 是同一张专辑的不同
版本名。而用户选的两个，一个是**合辑**上的版本，一个是**单曲**。
**专辑与时长同时指向 `30512923`。**

#### case 22 · True Colors (feat. Nicki Minaj) / Wiz Khalifa

源标题是中文平台的写法：`True Colors(合作音乐人:Nicki Minaj)`。这条一次性暴露了
**三个**独立缺陷：

1. **中文合作标记被当成注释摘掉了**（§5.2.2）→ 源静悄悄地丢了署名 → credit tier
   反向（§6.2.1）→ 一堆同名翻唱排在正确候选前面 → 时长门失败 → 整个 provider 报
   `duration_mismatch`。
2. **搜索词里带着中文标记**（§9.3）→ 网易云返回 40 条无关的歌，`28935275`
   **根本不在页面上**。
3. **专辑的 Deluxe 限定词**（§4.6）→ 修好前两条之后，标准版 `1334778805` 仍然
   赢下专辑层（上传写 `Blacc Hollywood`，标准版名字**完全相同**，Deluxe 版只是
   "包含"关系）。

| | `28935275`（用户确认） | `1334778805`（曾被选中） |
|---|---|---|
| 歌名 | True Colors (feat. Nicki Minaj) | 同 |
| 专辑 | Blacc Hollywood **(Deluxe)** | Blacc Hollywood |
| 时长 | 255.150 s | 255.150 s（**完全相同**） |
| 搜索排名 | **0** | 1 |

两条记录是**同一个文件**：同一首歌、同一时长、同样的署名，差别只在专辑是
Deluxe 版还是标准版。摘掉限定词之后两者专辑层持平，由 rank 0 决出胜负，
`28935275` 胜出。

### 14.5 消融实验（哪些成分是承重的）

在 22 条 ground truth 上逐个去掉一个成分：

| 配置 | 成功率 | 结论 |
|------|--------|------|
| **完整** | **100.0%** | |
| 去掉源的标题变体 | 90.0% | **承重**——单独支撑 2 条 case |
| 去掉候选的 alias | 95.0% | **承重**——罗马化 case 靠它 |
| 去掉精确时长（用四舍五入） | 100.0% | 不承重——**不必**多发 player 请求 |
| 去掉 rank 先验 | 100.0% | 不承重，但免费且有价值，保留 |
| 去掉查询计划（单条 query） | 95.0% | 曾经承重；补上版本词后单条 query 即可 |
| 去掉 credit tier | 掉到 < 95% | **承重** |
| 去掉 `CREDIT_CAND_ONLY = 3.0` 的修正 | 掉 1 条 | **承重**（§6.2.1） |
| 去掉 `albumBase` | 掉 1 条 | **承重**（§4.6） |

---

## 15. 已知边界与失败模式

### 15.1 跨文字系统的翻唱无法被识别（**最重要的边界**）

若源是 `Yoko Takahashi`，而页面里排第一的是 `张三` 的同名翻唱，app 会播谁？

**答案：不一定是第一条，但确实无法保证是正确的那条。**

级联会把所有候选排一遍，只在**每一级相等时**才看下一级。跨文字系统时，艺人
这一级对所有候选都是同一个 `0.6`（不可验证），所以这一级**不能区分任何人**
——真正起作用的是它后面的几级：

| 级 | 跨文字系统时的取值 | 能否区分候选 |
|----|------------------|------------|
| title | 各不相同 | **能**（最强） |
| credit | 各不相同 | **能** |
| artist | **全部 = 0.6** | **不能**（都不可验证） |
| version | 各不相同 | 能 |
| duration | 各不相同 | 能 |
| album | 各不相同 | **能** |
| rank | 各不相同 | 能（最后一级） |

也就是说：**艺人这一级在跨文字系统时是废的，但后面还有四级可以区分。**

实测的三种情形：

| 情形 | 结果 | 原因 |
|------|------|------|
| 正确条目在 rank 0，翻唱在 rank 5 | ✅ **正确条目** | album 不同 |
| 正确条目在 rank 5，翻唱在 rank 0，**专辑也不同** | ✅ **正确条目** | album 一级就分出高下 |
| 正确条目在 rank 5，翻唱在 rank 0，**专辑完全相同** | ❌ **翻唱**（rank 更靠前） | 前六级全平，靠 rank 决胜 |

第三种是算法**唯一**会输的情况，而且它要求翻唱和原版**在同一个专辑上**——
这在现实中几乎不会发生（原版在原专辑上，翻唱通常在合辑或翻唱专辑上）。

> **结论**：不是"直接取搜索结果第一条"。级联会依次比较标题、署名、版本、时长、
> 专辑，只有**前面全部持平**时才会让 rank 决胜。跨文字系统时艺人这一级失效，
> 但 album 与 rank 两级仍然在工作。
>
> 代价依然存在：第三种情形里算法会选错，而且它**给不出任何警告**——置信度会
> 诚实地报成 `HIGH`，因为从元数据上看它确实"完美吻合"。

### 15.2 其它失败模式

| 失败模式 | 原因 | 缓解 |
|---------|------|------|
| 用户上传的曲目 26% 无艺人 | 艺人门无法验证 | 艺人缺失 → artist 0.0 + 未验证 → 需要标题精确 + 时长 ≤ 3 s |
| 标题带大量废话 | 归一化剥不掉 | 归一化已处理 `official`/`video`/`歌词版`/`高音质` 等；实在剥不掉的靠模糊匹配兜底 |
| 平台根本没收录 | 无解 | 不计分母；UI 应显示"该平台没有这首歌" |
| 平台改了搜索排序 | rank 先验失效 | rank 是最后一级 tie-breaker，前面的级不受影响 |
| 平台改了 API | eapi 协议失效 | 协议是公开规格，实现独立于第三方库 |

### 15.3 日志（**移植时应当一并带上**）

匹配是一个判断，判断错了是**不可见**的——app 播放了正确的录音还是错误的录音，
用户看不出来；"匹配不上"和"平台没有这首歌"长得一模一样。

所以每次匹配都记录：

- 发了什么查询词
- 返回了多少候选
- 最好的几个候选：id / 标题 / 艺人 / 专辑 / 时长 / alias / rank
- 每个候选在 7 个维度上的分值
- 选中的 id 与置信度
- **失败原因**（`title_mismatch` / `artist_mismatch` / `duration_mismatch` /
  `ambiguous` / `low_score` / `no_candidates` / `search_failed`）

**只记最好的几个**（比如 8 个），其余汇总成计数——网易云搜索一次返回 100 条，
每次全记会把日志淹掉。但**汇总的计数和细节一样重要**："100 个候选，没有一个
超过 0.72"说明搜索成功而**匹配器**说不行，这与"0 个候选"是完全不同的两类 bug。

---

## 16. 实现清单

按这个顺序实现，每一步都可独立验证：

| # | 项 | 验证方式 |
|---|-----|---------|
| 1 | `fold()`：小写 → 繁简 → NFKC → 去标点 → 折叠空白 | 单元测试：`残酷な天使のテｰゼ` 与 `残酷な天使のテーゼ` 折叠后相同 |
| 2 | 噪音词表 / 版本词表 / 注释词表 / 泛化艺人名表 | 单元测试 |
| 3 | `splitFeat`：英文标记 + **中文标记** + `与...合作` | 单元测试：`True Colors(合作音乐人:Nicki Minaj)` → feats = ["Nicki Minaj"] |
| 4 | `stripAnnotation`：迭代剥注释 | 单元测试：`无名的人 (电影《雄狮少年》主题曲/片尾曲)` → `无名的人` |
| 5 | `albumBase`：剥版本限定词 | 单元测试：`Blacc Hollywood (Deluxe)` → `Blacc Hollywood` |
| 6 | `titleVariants` / `titleForms` | 单元测试：变体集合包含预期成员 |
| 7 | `cleanTrackTitle(title, keepCredit=true)` | 单元测试：署名**保留** |
| 8 | `jaroWinkler` + `containmentFactor` | 单元测试：`告白` vs `告白气球` 被折扣 |
| 9 | 各 tier 函数 | 单元测试：边界值（1.5 / 3 / 6 / 10 / 20 秒） |
| 10 | `creditAgreement`：`CREDIT_CAND_ONLY = 3.0` | 单元测试：**必须 ≥ `CREDIT_NEITHER`** |
| 11 | `artistAgreement` + `scriptOf` | 单元测试：跨文字系统 → verified=false |
| 12 | `scoreCandidate` + `compareKeys`（字典序） | 单元测试 |
| 13 | `passesGates` + `decideConfidence` + `isCoverFallback` | 单元测试 |
| 14 | `buildQueries`（第一位艺人 + 署名翻译） | 单元测试：产出 `True Colors (feat. Nicki Minaj) Wiz Khalifa` |
| 15 | eapi 搜索（加密 + 请求 + 解析 `alias`） | 集成测试：搜 `True Colors (feat. Nicki Minaj) Wiz Khalifa`，`28935275` 在 rank 0 |
| 16 | 候选合并（保留最好 rank） | 单元测试 |
| 17 | 缓存（键 + TTL + 在途去重） | 单元测试 |
| 18 | **ground truth 回放** | **22/22**，两种时长各跑一遍，扣专辑变体 ≤ 2 条不中 |
| 19 | 日志（候选明细 + 失败原因） | 手工检查日志内容 |

**最后一条提醒**：§5.3（源保留署名）、§6.2.1（`CREDIT_CAND_ONLY = 3.0`）、
§4.6（`albumBase`）、§5.2.2（中文合作标记）、§9.3（查询词翻译署名）这五处是
**最容易做错、且错了会静默地选错歌**的地方。前四处各自都曾导致一条 ground truth
case 选错。移植时优先把这五处写对。
