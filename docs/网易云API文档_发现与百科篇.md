# 网易云音乐 API 文档 · 发现与百科篇

> 
> **音乐百科（歌曲资料页）** 与 **云村星评馆（热评歌曲流）**。
>
> **全部接口均无需登录、无需 token、无需 Cookie。**
>
> 加密通道、请求头构造方式与 [网易云API文档.md](网易云API文档.md) 完全一致，可直接复用第 1、2 章的内容。

---

## 目录

- [1. 通用说明](#1-通用说明)
- [2. 接口总览](#2-接口总览)
- [3. 相似歌曲](#3-相似歌曲-apiv1discoverysimisong)
- [4. 音乐百科](#4-音乐百科-apisongplayaboutblockpage)
- [5. 云村星评馆](#5-云村星评馆-apihomepageblockpage)
- [6. 完整调用示例](#6-完整调用示例)
- [7. 实测坑位与注意事项](#7-实测坑位与注意事项)

---

## 1. 通用说明

### 1.1 端点

```
POST https://interface.music.163.com/eapi/{uri 去掉 /api 前缀}
```

| 业务 | 实际 URL | 加密 uri |
|---|---|---|
| 相似歌曲 | `/eapi/v1/discovery/simiSong` | `/api/v1/discovery/simiSong` |
| 音乐百科 | `/eapi/song/play/about/block/page` | `/api/song/play/about/block/page` |
| 云村星评馆 | `/eapi/homepage/block/page` | `/api/homepage/block/page` |

### 1.2 请求格式

```
Content-Type: application/x-www-form-urlencoded
User-Agent: NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)

params=<eapi 加密后的十六进制大写串>
```

加密算法（eapi，AES-ECB / PKCS7，key `e82ckenh8dichen8`，salt `36cd479b6b5`）
详见主文档 [第 2 章](网易云API文档.md#2-加密算法)。

### 1.3 认证

**不需要登录、不需要 token、不需要 Cookie。**

实测（不带任何 `Cookie` 头、`header` 里也不放 `MUSIC_A`）：

| 接口 | code | 数据 |
|---|---|---|
| `/api/v1/discovery/simiSong` | `200` | `songs` 正常返回 5 条 |
| `/api/song/play/about/block/page` | `200` | `blocks` 正常返回 4 个板块 |
| `/api/homepage/block/page` | `200` | 热评歌曲流正常返回 |
| `/api/search/get`（主文档） | `200` | 正常 |
| `/api/song/lyric`（主文档） | `200` | 正常 |
| `/api/v2/resource/comments`（主文档） | `200` | `comments` 正常返回 20 条 |

请求头只需要最小集合：

```json
{
  "osver": "16.2",
  "deviceId": "F0000000000000000000000000000000",
  "os": "iPhone OS",
  "appver": "9.0.90",
  "versioncode": "140",
  "mobilename": "",
  "buildver": "1700000000",
  "resolution": "1920x1080",
  "__csrf": "",
  "channel": "distribution",
  "requestId": "1700000000000_0001"
}
```

`requestId` 格式：`{毫秒时间戳}_{4位随机数}`。其余字段固定值即可。

---

## 2. 接口总览

| 接口 | 路由 | 主参数 | 返回键 | 实测可用 |
|---|---|---|---|---|
| 相似歌曲 | `/api/v1/discovery/simiSong` | `songid` | `songs` | ✅ |
| 音乐百科 | `/api/song/play/about/block/page` | `songId` | `data.blocks` | ✅ |
| 云村星评馆 | `/api/homepage/block/page` | `cursor` | `data.blocks` | ✅ |

> 注意 `simiSong` 是 **`/api/v1/`** 版本；旧版 `/api/discovery/simiSong` 无效。
> Web 前端源码（`w7.js`）里走的正是 `/api/v1/discovery/simiSong`。

---

## 3. 相似歌曲 (`/api/v1/discovery/simiSong`)

### 3.1 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `songid` | int | **是** | - | 歌曲 id |
| `limit` | int | 否 | 50 | 返回条数（实测有效） |
| `offset` | int | 否 | 0 | 分页偏移（实测有效） |

> 参数名必须是 **`songid`**（全小写），传 `id` 会返回 `400 参数错误`。

### 3.2 响应

返回的是**完整歌曲对象**（与 `search/get` 的 `songs` 结构一致），常用字段：

```jsonc
{
  "code": 200,
  "songs": [
    {
      "id": 347230,
      "name": "听妈妈的话",
      "duration": 269800,          // 毫秒
      "fee": 1,                    // 1=免费 8=VIP
      "copyrightId": 1007,
      "mvid": 0,
      "alias": [],
      "status": 0,
      "popularity": 100.0,
      "score": 100,
      "playCount": 0,
      "dayPlays": 0,
      "mp3Url": "http://m2.music.126.net/.../0.mp3",
      "artists": [ { "id": 6452, "name": "周杰伦", "alias": ["Jay Chou"] } ],
      "album": {
        "id": 1872809,
        "name": "叶惠美",
        "blurPicUrl": "https://p2.music.126.net/...jpg",
        "picId": 109951166000000000,
        "artist": { "id": 6452, "name": "周杰伦" }
      },
      "privilege": { ... },        // 试听/下载权限
      "commentThreadId": "R_SO_4_347230",
      "alg": "..."                  // 推荐算法标记
    }
  ]
}
```

### 3.3 请求示例

```python
post_eapi("/api/v1/discovery/simiSong", {"songid": 347230, "limit": 5, "offset": 0})
```

> **返回为空是正常的**：部分冷门歌曲的相似推荐为空数组（`code` 仍为 200）。
> 实测 `songid=186016`（晴天）返回空，`347230` / `1974443814` / `25906124` 正常返回 5 条。

---

## 4. 音乐百科 (`/api/song/play/about/block/page`)

歌曲「资料页 / 百科」聚合接口，一次返回**曲风标签、推荐标签、语种、BPM、获奖记录、
影视节目、乐谱、相似歌曲、相关歌单**。

### 4.1 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `songId` | int | **是** | 歌曲 id（注意首字母大写） |

### 4.2 顶层响应结构

```jsonc
{
  "code": 200,
  "data": {
    "cursor": {                       // 分页游标（按 channel 划分）
      "SONG_PLAY_ABOUT_TAB_SIM_CHANNEL":   "{\"blockCodes\":[...],\"offset\":4}",
      "SONG_PLAY_ABOUT_TAB_BASIC_CHANNEL": "{\"blockCodes\":[\"SONG_PLAY_ABOUT_SONG_BASIC\"],\"offset\":1}"
    },
    "blocks": [ /* 见下 */ ],
    "hasMore": false,
    "pageConfig": null,
    "pageCodeContext": null
  }
}
```

### 4.3 blocks 结构

`blocks` 是一个数组，每个 block 的 `code` 标识板块：

| block.code | 板块标题 | 内容 |
|---|---|---|
| `SONG_PLAY_ABOUT_MUSIC_MEMORY` | 回忆坐标 | `creatives` 常为空数组（需登录/个性化） |
| `SONG_PLAY_ABOUT_SONG_BASIC` | 音乐百科 | **核心板块**，含标签、BPM、获奖、乐谱等 |
| `SONG_PLAY_ABOUT_SIMILAR_SONG` | 相似歌曲 | 10 首，资源类型 `SONG` |
| `SONG_PLAY_ABOUT_RELATED_PLAYLIST` | 相关歌单 | 20 个，资源类型 `PLAYLIST` |

单个 block：

```jsonc
{
  "code": "SONG_PLAY_ABOUT_SONG_BASIC",
  "showType": "SONG_PLAY_ABOUT_TAB_SONG_BASIC",
  "channel": "SONG_PLAY_ABOUT_TAB_BASIC_CHANNEL",
  "position": "10",
  "uiElement": {
    "mainTitle": { "title": "音乐百科" },
    "subTitles": [ { "title": "全部", "action": { "clickAction": { "targetUrl": "orpheus://..." } } } ],
    "images": [ { "imageUrl": "http://p2.music.126.net/...jpg" } ],
    "textLinks": [ { "text": "参与共建", "url": "https://music.163.com/st/musicwiki/pedia-edit?songId=..." } ]
  },
  "creatives": [ /* 见下 */ ]
}
```

### 4.4 creatives / resources 结构

`creatives[]` 是「一组同类型的条目」，`resources[]` 是组内具体条目：

```jsonc
{
  "creativeType": "songTag",          // 组类型，见下表
  "uiElement": {
    "mainTitle": { "title": "曲风" },  // 组标题
    "textLinks": [ { "text": "国语" } ],
    "buttons":   [ { "text": "3项", "action": { "clickAction": { "targetUrl": "orpheus://..." } } } ]
  },
  "resources": [
    {
      "resourceType": "melody_style",
      "uiElement": {
        "mainTitle": { "title": "流行-华语流行" },
        "subTitles": [ { "title": "..." } ]
      },
      "action": { "clickAction": { "action": 1, "targetUrl": "orpheus://rnpage?resId=rn-genre&..." } },
      "valid": true
    }
  ]
}
```

`creativeType` 取值一览（实测）：

| creativeType | 组标题 | 资源位置 | 用途 |
|---|---|---|---|
| `songTag` | 曲风 | `resources[].uiElement.mainTitle.title` | 如「流行-华语流行」 |
| `songBizTag` | 推荐标签 | 同上 | 如「思念 / 浪漫 / 治愈 / KTV / 放松」 |
| `language` | 语种 | `uiElement.textLinks[].text` | 如「国语」 |
| `bpm` | BPM | `uiElement.textLinks[].text` | 如「69」 |
| `songAward` | 获奖成就 | `resources[].uiElement.mainTitle.title` + `subTitles` | 如「第×届hito流行音乐奖」 |
| `entertainment` | 影视节目 | `resources[].uiElement.mainTitle.title` | 如「颁奖礼《…》插曲」 |
| `sheet` | 乐谱 | `resources[].uiElement.images[]` | 总谱/分谱图片 |

`resources[].resourceType` 取值：`melody_style` / `awards` / `entertainment` / `sheet_music` /
`SONG` / `PLAYLIST`。

**跳转链接**统一在 `resources[].action.clickAction.targetUrl`：

- 曲风标签 → `orpheus://rnpage?resId=rn-genre&component=rn-genre&route=detail&tagId=1020`
- 推荐标签 → `orpheus://rnpage?component=rn-tag-detail&tagId=196123&tagName=思念`
- 获奖记录 → `https://music.163.com/st/musicwiki/awards?tab=works&id=...`（**可直接在浏览器打开**）
- 影视节目 → `orpheus://rnpage?component=rn-movie-variety&resourceId=453561&resourceType=ENTERTAINMENT`
- 乐谱 → `orpheus://rnpage?component=rn-music-score-detail&musicSheetId=144807&songId=186016`
- 相关歌单 → `orpheus://playlist/{playlistId}`
- 百科参与共建 → `https://music.163.com/st/musicwiki/pedia-edit?songId=...`

> `orpheus://` 是 App 内 scheme，PC 端无法直接打开；
> `music.163.com/st/musicwiki/...` 是 Web 链接，可直接访问。

### 4.5 解析示例

把百科接口拆成结构化数据：

```python
def parse_about(song_id):
    r = post_eapi("/api/song/play/about/block/page", {"songId": song_id})
    out = {
        "tags": [],       # 曲风 + 推荐标签
        "language": None,
        "bpm": None,
        "awards": [],
        "entertainment": [],
        "sheets": [],
        "similar_songs": [],
        "related_playlists": [],
    }
    for b in (r.get("data") or {}).get("blocks") or []:
        for c in b.get("creatives") or []:
            ct = c.get("creativeType")
            for res in c.get("resources") or []:
                ue = res.get("uiElement") or {}
                title = (ue.get("mainTitle") or {}).get("title")
                link = ((res.get("action") or {}).get("clickAction") or {}).get("targetUrl")
                if ct == "songTag":
                    out["tags"].append({"type": "style", "name": title, "url": link})
                elif ct == "songBizTag":
                    out["tags"].append({"type": "biz", "name": title, "url": link})
                elif ct == "songAward":
                    out["awards"].append({"name": title, "url": link})
                elif ct == "entertainment":
                    out["entertainment"].append({"name": title, "url": link})
                elif ct == "sheet":
                    out["sheets"].append({
                        "name": title,
                        "url": link,
                        "images": [i.get("imageUrl") for i in (ue.get("images") or [])],
                    })
                elif res.get("resourceType") == "SONG":
                    out["similar_songs"].append({
                        "id": res.get("resourceId"),
                        "name": title,
                        "artists": [s.get("title") for s in (ue.get("subTitles") or [])],
                    })
                elif res.get("resourceType") == "PLAYLIST":
                    out["related_playlists"].append({
                        "id": res.get("resourceId"),
                        "name": title,
                        "playCount": (res.get("resourceExt") or {}).get("playCount"),
                        "url": link,
                    })
            # 语种 / BPM 走 textLinks
            if ct == "language":
                out["language"] = next((x.get("text") for x in (c.get("uiElement") or {}).get("textLinks") or []), None)
            if ct == "bpm":
                out["bpm"] = next((x.get("text") for x in (c.get("uiElement") or {}).get("textLinks") or []), None)
    return out
```

> 相似歌曲的歌手名在 `resources[].uiElement.subTitles[].title`（形如 `周杰伦/温岚/吴宗宪`），
> 用 `/` 分隔。
> 相关歌单播放量在 `resources[].resourceExt.playCount`。

---

## 5. 云村星评馆 (`/api/homepage/block/page`)

首页「热评歌曲」信息流——每条是一首歌 + 一条高赞评论 + 评论者。

### 5.1 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `cursor` | string | **是** | **JSON 字符串**（需再 `JSON.stringify` 一次） |

`cursor` 结构：

```json
{
  "offset": 0,
  "blockCodeOrderList": ["HOMEPAGE_BLOCK_NEW_HOT_COMMENT"],
  "refresh": true
}
```

翻页时把 `offset` 递增（如 `offset: 10`），`refresh` 传 `false`。

### 5.2 响应

`data.blocks` 是一堆首页模块，其中 `blockCode == "HOMEPAGE_BLOCK_NEW_HOT_COMMENT"` 才是热评歌曲：

```jsonc
{
  "code": 200,
  "data": {
    "cursor": null,
    "blocks": [
      { "blockCode": "HOMEPAGE_BANNER", ... },                    // ← 无关
      { "blockCode": "HOMEPAGE_BLOCK_NEW_HOT_COMMENT",             // ← 目标
        "showType": "NEW_HOT_COMMENT_WHITE_SKIN",
        "uiElement": { "subTitle": { "title": "热评歌曲" } },
        "creatives": [
          {
            "creativeType": "COMMENT_DETAIL",
            "creativeId": "1052006504",
            "actionType": "orpheus",
            "uiElement": { "mainTitle": { "serialNum": "1", "title": "", "titleDesc": "我的每支笔，都知道你的名字。" } },
            "resources": [
              {
                "resourceType": "orpheus",
                "resourceId": "1052006504",
                "likedCount": 873,
                "replyCount": 14,
                "resourceExtInfo": {
                  "users": [ { "userId": 44075839, "nickname": "...", "avatarUrl": null, "vipType": 0, "mutual": false } ],
                  "songData": {
                    "id": 407002483,
                    "name": "浪费",
                    "alias": ["原唱 : 林宥嘉"],
                    "fee": 1,
                    "duration": 269800,
                    "artists": [ { "id": 905780, "name": "No Hopes" } ],
                    "album": { ... }
                  },
                  "hasListened": false,
                  "threadId": "R_SO_4_407002483"
                }
              }
            ]
          }
        ]
      }
    ]
  }
}
```

### 5.3 关键字段路径

> ⚠️ 该接口一次返回 **15 个 block**（banner、推荐歌单、热歌、新歌、播客……），
> 必须按 `blockCode == "HOMEPAGE_BLOCK_NEW_HOT_COMMENT"` 过滤，只取热评歌曲那一块。

| 想要 | 路径 |
|---|---|
| 评论正文 | `blocks[].creatives[].resources[].uiElement.mainTitle.titleDesc`（注意 `title` 是空串，正文在 `titleDesc`） |
| 歌曲 id | `...resources[].resourceExtInfo.songData.id` |
| 歌曲名 | `...resourceExtInfo.songData.name` |
| 歌手 | `...resourceExtInfo.songData.artists[].name` |
| 评论者 | `...resourceExtInfo.users[0].nickname` / `.userId` |
| 点赞数 | `...resources[].likedCount` |
| 评论 threadId | `...resourceExtInfo.threadId`（可直接喂给热评接口） |

### 5.4 请求示例

```python
import json

cursor = json.dumps({
    "offset": 0,
    "blockCodeOrderList": ["HOMEPAGE_BLOCK_NEW_HOT_COMMENT"],
    "refresh": True,
})
r = post_eapi("/api/homepage/block/page", {"cursor": cursor})
```

---

## 6. 完整调用示例

### 6.1 复用主文档的加密客户端

```python
import hashlib, json, time
import requests, urllib3
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad

urllib3.disable_warnings()

API = "https://interface.music.163.com"
EAPI_KEY = "e82ckenh8dichen8"
EAPI_SALT = "36cd479b6b5"
UA = "NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)"


def build_header():
    now = int(time.time() * 1000)
    return {
        "osver": "16.2",
        "deviceId": "F0000000000000000000000000000000",
        "os": "iPhone OS",
        "appver": "9.0.90",
        "versioncode": "140",
        "mobilename": "",
        "buildver": str(now)[:10],
        "resolution": "1920x1080",
        "__csrf": "",
        "channel": "distribution",
        "requestId": f"{now}_{now % 10000:04d}",
    }


def eapi_encrypt(uri, data):
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    digest = hashlib.md5(
        ("nobody" + uri + "use" + text + "md5forencrypt").encode()
    ).hexdigest()
    payload = f"{uri}-{EAPI_SALT}-{text}-{EAPI_SALT}-{digest}"
    return AES.new(EAPI_KEY.encode(), AES.MODE_ECB).encrypt(
        pad(payload.encode(), 16)
    ).hex().upper()


def post_eapi(uri, data, timeout=15):
    header = build_header()
    body = dict(data)
    body["header"] = header
    params = eapi_encrypt(uri, body)
    r = requests.post(
        API + "/eapi/" + uri.lstrip("/api/"),
        data={"params": params},
        headers={
            "User-Agent": UA,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout=timeout,
        verify=False,
    )
    try:
        return r.json()
    except Exception:
        return {"_raw": r.text[:200], "_status": r.status_code}
```

### 6.2 一次性跑通全部接口

```python
if __name__ == "__main__":
    song_id = 347230          # 听妈妈的话

    # 相似歌曲
    print("simiSong:", [s["name"] for s in post_eapi(
        "/api/v1/discovery/simiSong", {"songid": song_id, "limit": 5})["songs"]])

    # 音乐百科
    about = parse_about(song_id)
    print("tags:", about["tags"])
    print("bpm:", about["bpm"], "language:", about["language"])
    print("awards:", about["awards"])

    # 云村星评馆
    cur = json.dumps({"offset": 0,
                      "blockCodeOrderList": ["HOMEPAGE_BLOCK_NEW_HOT_COMMENT"],
                      "refresh": True})
    blocks = post_eapi("/api/homepage/block/page", {"cursor": cur})["data"]["blocks"]
    hot = next(b for b in blocks if b["blockCode"] == "HOMEPAGE_BLOCK_NEW_HOT_COMMENT")
    for c in hot["creatives"][:3]:
        res = c["resources"][0]
        ext = res["resourceExtInfo"]
        print(ext["songData"]["name"], "|",
              res["uiElement"]["mainTitle"]["titleDesc"], "|",
              ext["users"][0]["nickname"], "|", res["likedCount"])
```

### 6.3 Windows 控制台中文乱码

`_w.py` 里有 `sys.stdout.reconfigure(encoding="utf-8", errors="replace")`，
但 PowerShell 仍可能按 GBK 解码导致乱码。两种解法：

```powershell
# 方式一：先落盘再读
python _w.py | Out-File -Encoding utf8 out.txt
Get-Content out.txt -Encoding utf8

# 方式二：设置控制台编码
chcp 65001
python _w.py
```

或在 Python 侧强制：

```python
sys.stdout.reconfigure(encoding="utf-8")
```

---

## 7. 实测坑位与注意事项

| # | 现象 | 结论 / 处理 |
|---|---|---|
| 1 | `simiSong` 传 `id` → `400` | 必须用 `songid`（全小写） |
| 2 | `simiSong` 某些歌曲返回空数组 | `code` 仍 200，属正常冷启动（186016/2884035/25880923 实测为空） |
| 3 | 音乐百科参数是 `songId`（大写 S） | 与 `simiSong` 的 `songid` 不一致，容易踩坑 |
| 4 | 百科「回忆坐标」`creatives` 为空 | 依赖个性化，需登录态 |
| 5 | `orpheus://` 链接 PC 打不开 | 只有 `music.163.com/st/musicwiki/*` 是 Web 链接 |
| 6 | `homepage/block/page` 返回 15 个 block | 必须按 `blockCode == "HOMEPAGE_BLOCK_NEW_HOT_COMMENT"` 过滤，否则会取到 banner 等无关资源 |
| 7 | `homepage/block/page` 的 `cursor` 是 **JSON 字符串** | 需 `json.dumps` 后传入，不能传 dict |
| 8 | 星评馆的评论正文位置 | 在 `resources[].uiElement.mainTitle.titleDesc`（`title` 为空串，正文在 `titleDesc`） |
| 9 | PowerShell 控制台中文乱码 | `python _w.py \| Out-File -Encoding utf8 out.txt` 或 `chcp 65001` |

### 附：已排除的接口（供备查）

| 接口 | 实测结果 |
|---|---|
| `/api/discovery/simiArtist`（相似歌手） | 需有效 `MUSIC_A` 匿名 token 且**只能写在 HTTP `Cookie` 头**（写进加密体内无效），否则 `301 未登录`。本项目已弃用 |
| `/api/discovery/simiUser`（相似用户） | 带 token 也恒返回 `userprofiles: []`，官方已关闭该推荐位 |
| `/api/discovery/simiMV`（相似 MV） | 可用但本项目用不到 |
| `/api/discovery/simiPlaylist`（相似歌单） | HTTP `400` 空 body，已下线。改用 `/api/search/get` 且 `type=1000` |

### 路由来源

本文涉及的路由均可在 Web 前端 bundle 中找到对应调用方：

| 路由 | 前端文件 |
|---|---|
| `/api/song/play/about/block/page` | `wb.js` / `w6.js`（音乐百科基础信息） |
| `/api/v1/discovery/simiSong` | `w7.js`（相似歌曲） |
| `/api/homepage/block/page` | `wb.js`（云村星评馆） |

完整路由清单见 `all_routes.txt`，带中文注释的精简版见 `route_comment.txt`。
