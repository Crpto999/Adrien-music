# 网易云音乐 API 文档

搜索 · 歌词 · 热评 · 新评论 —— 全部为可直接调用的 HTTP 接口，不依赖任何第三方网易云库。

---

## 目录

- [1. 通用说明](#1-通用说明)
- [2. 加密算法](#2-加密算法)
- [3. 模糊搜索](#3-模糊搜索)
- [4. 歌词](#4-歌词)
- [5. 热评](#5-热评)
- [6. 新评论](#6-新评论)
- [6.6 子评论（楼层评论）](#66-子评论楼层评论)
- [7. 批量接口](#7-批量接口)
- [8. 性能](#8-性能)
- [9. 完整调用示例](#9-完整调用示例)
- [10. 错误码](#10-错误码)

---

## 1. 通用说明

### 1.1 端点

所有接口统一走 **App 端 eapi 通道**：

```
POST https://interface.music.163.com/eapi/{路由去掉 /api 前缀}
```

| 业务 | 实际 URL |
|---|---|
| 歌词 | `https://interface.music.163.com/eapi/song/lyric` |
| 逐字歌词 | `https://interface.music.163.com/eapi/song/lyric/v1` |
| 搜索 | `https://interface.music.163.com/eapi/search/get` |
| 云搜索 | `https://interface.music.163.com/eapi/cloudsearch/pc` |
| 评论 | `https://interface.music.163.com/eapi/v2/resource/comments` |
| 批量 | `https://interface.music.163.com/eapi/batch` |

### 1.2 请求格式

```
Content-Type: application/x-www-form-urlencoded
User-Agent: NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)

params=<加密后的十六进制字符串>
```

请求体只有一个字段 `params`，值是加密后的数据。

### 1.3 认证

**无需登录、无需 Cookie。** 实测不携带任何 token 也能拿到全部数据。

| 字段 | 是否必需 | 说明 |
|---|---|---|
| `MUSIC_U` | 否 | 登录态 token，**仅**点赞/发评论需要 |
| `MUSIC_A` | 否 | 匿名 token，**不需要**（实测去掉后返回完全一致） |

### 1.4 请求头 `header`（加密进 params 内部）

`data.header` 会被一起加密，最小可用集合：

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

> `requestId` 格式：`{毫秒时间戳}_{4位随机数}`。
> 其余字段实测可用固定值，不影响结果。

### 1.5 通用响应

```jsonc
{
  "code": 200,        // 200=成功, 400=参数错误, 404=路由不存在
  "message": "",      // 失败时的说明
  "msg": "",          // 同上，两个键都可能出现
  "result": {},       // 搜索类接口的业务数据
  "data": {}          // 评论类接口的业务数据
}
```

---

## 2. 加密算法

### 2.1 eapi（唯一需要的加密）

```
text    = JSON.stringify(data)                    // 紧凑，无空格
digest  = MD5("nobody" + uri + "use" + text + "md5forencrypt")
payload = uri + "-36cd479b6b5-" + text + "-36cd479b6b5-" + digest
params  = AES-ECB-PKCS7(payload, key="e82ckenh8dichen8").hex().upper()
```

| 参数 | 值 |
|---|---|
| 加密算法 | AES / ECB / PKCS7Padding |
| 密钥 | `e82ckenh8dichen8`（16 字节） |
| 盐值 | `36cd479b6b5` |
| 输出 | 十六进制，**大写** |

> `uri` 用的是**完整路由含 `/api` 前缀**，例如 `/api/song/lyric`。
> 但请求 URL 是 `/eapi/song/lyric`（去掉 `/api`）。

### 2.2 Python 实现（30 行，无第三方网易云库）

```python
import hashlib, json, time
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad

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


def post_eapi(uri, data):
    body = dict(data)
    body["header"] = build_header()
    params = eapi_encrypt(uri, body)
    import requests, urllib3
    urllib3.disable_warnings()
    r = requests.post(
        API + "/eapi/" + uri.lstrip("/api/"),
        data={"params": params},
        headers={"User-Agent": UA,
                 "Content-Type": "application/x-www-form-urlencoded"},
        timeout=20, verify=False,
    )
    return r.json()
```

依赖只有 `requests` 和 `pycryptodome`（`pip install requests pycryptodome`）。

### 2.3 Node.js 实现

```javascript
const crypto = require('crypto');

function eapiEncrypt(uri, data) {
  const text = JSON.stringify(data);
  const digest = crypto.createHash('md5')
    .update('nobody' + uri + 'use' + text + 'md5forencrypt')
    .digest('hex');
  const payload = uri + '-36cd479b6b5-' + text + '-36cd479b6b5-' + digest;

  const c = crypto.createCipheriv('aes-128-ecb', Buffer.from('e82ckenh8dichen8'), null);
  c.setAutoPadding(true);
  return Buffer.concat([c.update(Buffer.from(payload, 'utf8')), c.final()])
    .toString('hex').toUpperCase();
}
```

### 2.4 curl 示例

```bash
curl 'https://interface.music.163.com/eapi/song/lyric' \
  -X POST \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H 'User-Agent: NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)' \
  --data-raw 'params=<第2.2节脚本生成的十六进制串>'
```

---

## 3. 模糊搜索

### 3.1 接口

| 项目 | 内容 |
|---|---|
| **URL** | `POST https://interface.music.163.com/eapi/search/get` |
| **备选** | `POST https://interface.music.163.com/eapi/cloudsearch/pc` |
| **加密 uri** | `/api/search/get` / `/api/cloudsearch/pc` |

### 3.2 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `s` | string | **是** | - | 关键词，**建议 `"歌名 歌手"` 空格分隔** |
| `type` | int | 否 | 1 | 搜索类型，见下表 |
| `limit` | int | 否 | 30 | 返回条数 |
| `offset` | int | 否 | 0 | 分页偏移 |
| `total` | bool | 否 | - | 仅 `cloudsearch/pc`：是否附带总数 |

### 3.3 搜索类型

| type | 含义 | `result` 中的字段 |
|---|---|---|
| 1 | 单曲 | `songs` |
| 10 | 专辑 | `albums` |
| 100 | 歌手 | `artists` |
| 1000 | 歌单 | `playlists` |
| 1002 | 用户 | `userprofiles` |
| 1004 | MV | `mvs` |
| 1006 | 歌词 | `songs` |
| 1009 | 电台 | `djRadios` |
| 1014 | 视频 | `videos` |

### 3.4 响应

```jsonc
{
  "code": 200,
  "result": {
    "songs": [
      {
        "id": 186016,                    // 歌曲 id，后续所有接口都用它
        "name": "晴天",
        "duration": 269800,              // 毫秒
        "artists": [ { "id": 6452, "name": "周杰伦" } ],
        "album": { "id": 1872809, "name": "叶惠美" },
        "mvid": 0,
        "alias": ["Sunny Day"],
        "fee": 8,                        // 8 = VIP
        "status": 0,
        "copyrightId": 1007
      }
    ],
    "songCount": 200,
    "hasMore": true
  }
}
```

### 3.5 两个搜索接口的字段差异（重要）

| 字段 | `search/get` | `cloudsearch/pc` |
|---|---|---|
| 歌手 | `artists`（完整对象） | `ar`（缩写） |
| 专辑 | `album` | `al` |
| 时长 | `duration` | `dt` |
| 别名 | `alias` | `alia` |
| MV | `mvid` | `mv` |

**`search/get` 返回完整字段，推荐使用。** 若必须用 `cloudsearch/pc`，自行映射。

### 3.6 只有歌名/歌手/时长时如何定位到正确的歌

网易云搜索是模糊的，会返回大量翻唱、Live、纯音乐版本。例如搜「周杰伦 晴天」，
第 1 条可能是 `晴天 (原唱 周杰伦) - RyaVocal`（翻唱）而非原版。

**推荐判定顺序**：

1. **时长过滤（最可靠）**—— 搜索结果自带 `duration`（毫秒），
   与你手上的时长比对，容差 ±3000ms。
2. **歌手精确匹配** —— `artists[].name == 目标歌手`
3. **排除衍生版本** —— 歌名含「翻唱 / Live / 钢琴 / 纯音乐 / 现场 / Cover / 伴奏」则跳过
4. **优先正版** —— `fee == 8` 且 `copyrightId != 0`

### 3.7 不可用的搜索接口

以下接口在 eapi 通道下实测无响应，不要用：

| 接口 | 实测结果 |
|---|---|
| `POST /api/search/suggest/web` | `result: {}` |
| `POST /api/search/suggest/mobile` | `404 接口未找到！` |
| `POST /api/search/match/new` | 恒返回 `songs: []` |
| `POST /api/search/match` | `400 参数错误` |

### 3.8 请求示例

```python
post_eapi("/api/search/get", {
    "s": "周杰伦 晴天",
    "type": 1,
    "limit": 10,
    "offset": 0,
})
```

---

## 4. 歌词

### 4.1 接口

| 项目 | 内容 |
|---|---|
| **URL** | `POST https://interface.music.163.com/eapi/song/lyric` |
| **加密 uri** | `/api/song/lyric` |
| **逐字版** | `POST https://interface.music.163.com/eapi/song/lyric/v1`，加密 uri `/api/song/lyric/v1` |

### 4.2 参数（`/api/song/lyric`）

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | int | **是** | 歌曲 id。**只接受单个 id**，传逗号分隔会返回 `400 wrong params` |
| `tv` | int | 否 | `-1` = 请求翻译歌词 |
| `lv` | int | 否 | `-1` = 请求原文 |
| `rv` | int | 否 | `-1` = 请求罗马音 |
| `kv` | int | 否 | `-1` = 请求逐字歌词 |
| `_nmclfl` | int | 否 | `1` = 新版歌词格式开关 |

### 4.3 参数（`/api/song/lyric/v1`，逐字）

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | int | **是** | 歌曲 id |
| `cp` | bool | 否 | `false` |
| `tv`/`lv`/`rv`/`kv`/`yv`/`ytv`/`yrv` | int | 否 | 各类型歌词开关，`0` = 全部请求 |

### 4.4 响应

```jsonc
{
  "code": 200,
  "lrc": {
    "version": 70,
    "lyric": "[00:00.000] 作词 : 周杰伦\n[00:01.000] 作曲 : 周杰伦\n..."
  },
  "tlyric":  { "version": 0, "lyric": "[00:00.950]\n..." },   // 翻译
  "romalrc": { "version": 0, "lyric": "" },                   // 罗马音
  "klyric":  { "version": 0, "lyric": "" },                   // 逐字（v0 里一般为空）
  "lyricUser": {
    "id": 681200, "status": 99, "demand": 0,
    "userid": 44813993, "nickname": "...", "uptime": 1411527379418
  },
  "sgc": false, "sfy": false, "qfy": false
}
```

| 字段 | 含义 |
|---|---|
| `lrc.lyric` | 原文歌词（标准 LRC 文本） |
| `tlyric.lyric` | 翻译歌词 |
| `romalrc.lyric` | 罗马音歌词 |
| `klyric.lyric` | 逐字歌词 |
| `lyricUser` | 歌词贡献者信息 |

### 4.5 逐字歌词格式（v1）

v1 的 `lrc.lyric` 变成 **JSON Lines**，每行一个 JSON：

```jsonl
{"t":0,"c":[{"tx":"作词: "},{"tx":"周杰伦","li":"http://p1.music.126.net/...jpg","or":"orpheus://nm/artist/home?id=6452&type=artist"}]}
{"t":1000,"c":[{"tx":"作曲: "},{"tx":"周杰伦"}]}
```

| 字段 | 说明 |
|---|---|
| `t` | 该行起始时间，**毫秒** |
| `c[].tx` | 文本片段 |
| `c[].li` | 关联图片 URL |
| `c[].or` | 关联实体（如 `orpheus://nm/artist/home?id=6452&type=artist`） |

### 4.6 LRC 解析

**标准 LRC**

```
[mm:ss] / [mm:ss.xx] / [mm:ss.xxx]
```

```python
import re

def parse_lrc(text):
    out = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line.startswith("["):
            continue
        stamps = []
        while line.startswith("["):
            end = line.find("]")
            if end < 0:
                break
            parts = line[1:end].split(":")
            if len(parts) != 2:
                break
            try:
                sec = int(parts[0]) * 60 + float(parts[1])
            except ValueError:
                break
            stamps.append(round(sec, 3))
            line = line[end + 1:].strip()
        for sec in stamps:
            out.append({"time": sec, "text": line})
    out.sort(key=lambda x: x["time"])
    return out
```

输出：

```python
[{"time": 0.0, "text": "作词 : 周杰伦"}, {"time": 1.0, "text": "作曲 : 周杰伦"}]
```

**逐字歌词**

```python
import json

def parse_lrc_v1(text):
    out = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        t = obj.get("t")
        if t is None:
            continue
        words = []
        for seg in obj.get("c") or []:
            tx = seg.get("tx")
            if tx is None:
                continue
            item = {"text": tx}
            if seg.get("li"):
                item["link"] = seg["li"]
            if seg.get("or"):
                item["origin"] = seg["or"]
            words.append(item)
        out.append({"time": t / 1000, "words": words})
    out.sort(key=lambda x: x["time"])
    return out
```

输出：

```python
[{"time": 0.0, "words": [{"text": "作词: "}, {"text": "周杰伦", "link": "...", "origin": "..."}]}]
```

### 4.7 请求示例

```python
post_eapi("/api/song/lyric", {
    "id": 186016,
    "tv": -1, "lv": -1, "rv": -1, "kv": -1,
    "_nmclfl": 1,
})
```

---

## 5. 热评

### 5.1 接口

| 项目 | 内容 |
|---|---|
| **URL** | `POST https://interface.music.163.com/eapi/v2/resource/comments` |
| **加密 uri** | `/api/v2/resource/comments` |

> 热评和新评论是**同一个接口**，靠 `sortType` + `cursor` 区分。

### 5.2 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `threadId` | string | **是** | - | `资源类型前缀 + id`，歌曲为 `R_SO_4_{id}` |
| `sortType` | int | 否 | 99 | **`2` = 按热度排序（热评）** |
| `cursor` | string | 否 | - | **`"normalHot#{偏移}"`**，首页填 `normalHot#0` |
| `pageNo` | int | 否 | 1 | 页码 |
| `pageSize` | int | 否 | 20 | 每页条数 |
| `showInner` | bool | 否 | true | 是否返回内嵌回复 |

### 5.3 cursor 生成规则

| sortType | cursor 格式 | 首页 | 翻页 |
|---|---|---|---|
| 99（推荐） | 整数偏移 | `0` | `(pageNo-1)*pageSize` |
| **2（热度）** | `"normalHot#" + 偏移` | `normalHot#0` | `normalHot#{(pageNo-1)*pageSize}` |
| **3（时间）** | 上一页最后一条的 `time` | `"0"` | 传上一页返回的 `data.cursor` |

### 5.4 响应

```jsonc
{
  "code": 200,
  "data": {
    "comments": [
      {
        "commentId": 4956438,
        "content": "高一时候...",
        "time": 1713591518616,          // 毫秒时间戳
        "timeStr": "2024-04-20 13:38:38",
        "likedCount": 823187,
        "replyCount": 14,
        "parentCommentId": 0,           // 0 = 顶层评论
        "ipLocation": { "location": "江苏" },
        "user": {
          "userId": 123456,
          "nickname": "蛋蛋是圆D",
          "avatarUrl": "http://p2.music.126.net/...jpg"
        },
        "beReplied": [ ... ],
        "showFloorComment": { "replyCount": 14 },
        "medal": { ... }
      }
    ],
    "totalCount": 1969912,
    "hasMore": true,
    "cursor": 1582152631506,           // 下一页游标
    "sortType": 2,
    "sortTypeList": [ ... ],
    "commentsTitle": "...",
    "currentCommentTitle": "..."
  }
}
```

### 5.5 资源类型前缀表

| type | 前缀 | 含义 |
|---|---|---|
| 0 | `R_SO_4_` | 歌曲 |
| 1 | `R_MV_5_` | MV |
| 2 | `A_PL_0_` | 歌单 |
| 3 | `R_AL_3_` | 专辑 |
| 4 | `A_DJ_1_` | 电台节目 |
| 5 | `R_VI_62_` | 视频 |
| 6 | `A_EV_2_` | 动态 |
| 7 | `A_DR_14_` | 电台 |

### 5.6 请求示例

```python
post_eapi("/api/v2/resource/comments", {
    "threadId": "R_SO_4_186016",
    "pageNo": 1,
    "showInner": True,
    "pageSize": 20,
    "cursor": "normalHot#0",
    "sortType": 2,
})
```

### 5.7 老版评论接口（v1）

| 对外路由 | 真实路由 | 参数 |
|---|---|---|
| 歌曲评论 | `POST /eapi/v1/resource/comments/R_SO_4_{id}` | `rid`, `limit`, `offset`, `beforeTime` |
| 专辑评论 | `POST /eapi/v1/resource/comments/R_AL_3_{id}` | 同上 |
| 歌单评论 | `POST /eapi/v1/resource/comments/A_PL_0_{id}` | 同上 |
| MV 评论 | `POST /eapi/v1/resource/comments/R_MV_5_{id}` | 同上 |
| 电台评论 | `POST /eapi/v1/resource/comments/A_DJ_1_{id}` | 同上 |
| 视频评论 | `POST /eapi/v1/resource/comments/R_VI_62_{id}` | 同上 |
| 热门评论 | `POST /eapi/v1/resource/hotcomments/R_SO_4_{id}` | 同上 |
| 楼层评论 | `POST /eapi/resource/comment/floor/get` | `id`, `cid`, `time` |
| 点赞 | `POST /eapi/v1/comment/like` | `threadId`, `commentId` |
| 发评论 | `POST /eapi/resource/comments/add` | `threadId`, `content` |
| 删评论 | `POST /eapi/resource/comments/delete` | `threadId`, `commentId` |
| 回复评论 | `POST /eapi/resource/comments/reply` | `threadId`, `commentId`, `content` |

> v1 接口响应里 `comments` 是时间序列表，`hotComments` 是热评列表，两者分开返回。
> v2 接口更全（`replyCount`、`ipLocation`、`beReplied`），**推荐 v2**。

---

## 6. 新评论

### 6.1 接口

与热评完全相同：`POST https://interface.music.163.com/eapi/v2/resource/comments`

### 6.2 参数差异

| 参数 | 热评 | 新评论 |
|---|---|---|
| `sortType` | `2` | **`3`** |
| `cursor` 首页 | `"normalHot#0"` | **`"0"`** |
| `cursor` 翻页 | `"normalHot#{(pageNo-1)*pageSize}"` | **上一页返回的 `data.cursor`** |
| `pageNo` | 递增 | 递增 |

### 6.3 翻页逻辑

新评论（时间倒序）的 `cursor` 是**上一页最后一条评论的 `time` 值**，
服务端也把它放在 `data.cursor` 里，两者一致，直接透传即可。

```python
cursor = "0"
for page in range(1, pages + 1):
    r = post_eapi("/api/v2/resource/comments", {
        "threadId": f"R_SO_4_{song_id}",
        "pageNo": page,
        "showInner": True,
        "pageSize": 20,
        "cursor": cursor,
        "sortType": 3,
    })
    data = r.get("data") or {}
    comments = data.get("comments") or []
    if not comments:
        break
    out.extend(comments)
    cursor = data.get("cursor") or comments[-1].get("time")
    if not data.get("hasMore"):
        break
```

### 6.4 请求示例

```python
post_eapi("/api/v2/resource/comments", {
    "threadId": "R_SO_4_186016",
    "pageNo": 1,
    "showInner": True,
    "pageSize": 20,
    "cursor": "0",
    "sortType": 3,
})
```

### 6.5 排序验证

实测 20 条新评论的 `time` 严格递减；20 条热评的 `likedCount` 严格递减。

---

## 6.6 子评论（楼层评论）

### 6.6.1 接口

| 项目 | 内容 |
|---|---|
| **URL** | `POST https://interface.music.163.com/eapi/resource/comment/floor/get` |
| **加密 uri** | `/api/resource/comment/floor/get` |

> 这是**唯一**的子评论接口。App 端点击评论下的回复数就是调它。

### 6.6.2 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `parentCommentId` | int | **是** | - | 父评论的 `commentId` |
| `threadId` | string | **是** | - | 资源 id，如 `R_SO_4_186016` |
| `time` | int | 否 | -1 | 游标。**首页必须传 `-1`**；翻页传上次响应的 `data.time` |
| `limit` | int | 否 | 20 | 每页条数 |

### 6.6.3 ⚠️ `time` 参数的坑（实测）

| 传入 | 返回条数 |
|---|---|
| **`-1`** | ✅ 正常返回全部 |
| `0` | ❌ 0 条 |
| 父评论自己的 `time`（如 `1713591518616`） | ❌ 0 条 |
| 省略不传 | ✅ 正常返回（等同 -1） |

**所以首页一定要传 `time=-1`。** 传父评论的时间戳会拿到空列表。

### 6.6.4 响应

```jsonc
{
  "code": 200,
  "data": {
    "ownerComment": {            // 父评论本身（完整对象）
      "commentId": 4956438,
      "content": "高一时候...",
      "likedCount": 823187,
      "user": { ... }
    },
    "currentComment": null,      // 当前定位的评论
    "comments": [                // 子评论列表
      {
        "commentId": 1436921389,
        "parentCommentId": 4956438,      // 都指向父评论
        "content": "...",
        "time": 1554031500549,
        "likedCount": 3094,
        "status": 0,
        "user": { ... },
        "beReplied": [           // 该子评论所回复的原始评论（通常是父评论）
          {
            "beRepliedCommentId": 4956438,
            "content": "高一时候...",
            "user": { "nickname": "蛋蛋是圆D", ... },
            "ipLocation": { "location": "" }
          }
        ],
        "showFloorComment": { ... }
      }
    ],
    "bestComments": [],           // 精选回复（实测通常为空）
    "hasMore": true,
    "totalCount": 14,            // 回复总数
    "time": 1560355051380        // 下一页游标
  }
}
```

### 6.6.5 子评论数量从哪来？—— **全部来自主请求**

这是 App 端交互的关键：**主评论请求的响应里就已经带了回复数**，
点击时不需要额外请求就能显示"共 N 条回复"。

主请求 `/api/v2/resource/comments` 的每条评论自带：

| 字段 | 说明 |
|---|---|
| `replyCount` | **回复总数**（即 App 上点击的那个数字） |
| `showFloorComment.replyCount` | 同上，两处数值一致 |
| `showFloorComment.showReplyCount` | 是否显示回复数（true） |
| `showFloorComment.comments` | `null` —— **主请求不内嵌子评论内容** |
| `showFloorComment.topCommentIds` | `null` |
| `beReplied` | 空数组 |
| `replyCount` 为 0 时 | `showFloorComment.comments` 也是 `null` |

实测数据（歌曲 `186016` 热评前 20 条）：

| commentId | replyCount | showFloorComment.replyCount | beReplied 长度 | showFloorComment.comments |
|---|---|---|---|---|
| 4956438 | 14 | 14 | 0 | null |
| 5453734 | 2 | 2 | 0 | null |
| 129011021 | 0 | 0 | 0 | null |

**结论**：
- ✅ 回复数**来自主请求**，直接读 `replyCount` 即可，不用额外请求。
- ❌ 但子评论的**内容**主请求不给（`showFloorComment.comments` 恒为 `null`），
  必须点击时再调 `floor/get` 懒加载。
- `showInner: true` **不会**让主请求内嵌子评论（实测 `true` / `false` 结果完全一样）。

### 6.6.6 `replyCount` 与 `floor/get` 返回条数不一致（实测）

| 父评论 | 主请求 `replyCount` | `floor/get` 的 `totalCount` | 实际返回条数 |
|---|---|---|---|
| 4956438 | 14 | 14 | **12** |
| 5453734 | 2 | 2 | 2 |
| 1418129604 | 1 | 1 | 1 |
| 1491949703 | 4 | 4 | 4 |

父评论 `4956438` 声称有 14 条回复，但只返回 12 条 —— 差的 2 条是**已被删除的评论**。
（该楼层里恰好有用户留言「怎么才有12条评论」「好多评论都被删了」）

**所以**：
- 用 `replyCount`（或 `totalCount`）显示数字 —— 与 App 一致
- 实际能拿到的条数可能更少，属于正常现象

### 6.6.7 翻页

游标是 `data.time`（**毫秒时间戳**，取最后一条子评论的时间），向下翻页：

```python
cursor = -1
page = 1
while True:
    r = post_eapi("/api/resource/comment/floor/get", {
        "parentCommentId": 4956438,
        "threadId": "R_SO_4_186016",
        "time": cursor,
        "limit": 5,
    })
    data = r.get("data") or {}
    subs = data.get("comments") or []
    if not subs:
        break
    # ... 处理 subs ...
    if not data.get("hasMore"):
        break
    cursor = data["time"]
```

实测（limit=5）：第 1 页 5 条 `hasMore=True` → 第 2 页 5 条 → 第 3 页 2 条 `hasMore=False`，
共 12 条，无重复。

### 6.6.8 二级嵌套

子评论的 `parentCommentId` 都直接指向**顶层父评论**，不存在二级嵌套：

```python
# 用子评论的 id 当 parentCommentId 再查 -> 0 条
post_eapi("/api/resource/comment/floor/get", {
    "parentCommentId": 1436921389,  # 子评论的 id
    "threadId": "R_SO_4_186016",
    "time": -1, "limit": 20,
})
# -> code=200, comments=[], totalCount=0
```

回复关系通过子评论的 `beReplied[0].beRepliedCommentId` 体现（指向被回复的那条评论）。

### 6.6.9 请求示例

```python
# 首页
r = post_eapi("/api/resource/comment/floor/get", {
    "parentCommentId": 4956438,
    "threadId": "R_SO_4_186016",
    "time": -1,
    "limit": 20,
})
subs = (r.get("data") or {}).get("comments") or []
```

### 6.6.10 完整交互流程（对应 App）

```python
# 1) 主请求：拿到评论列表 + 每条的回复数（无需额外请求）
r = post_eapi("/api/v2/resource/comments", {
    "threadId": "R_SO_4_186016", "pageNo": 1, "showInner": True,
    "pageSize": 20, "cursor": "normalHot#0", "sortType": 2,
})
comments = (r.get("data") or {}).get("comments") or []

for c in comments:
    reply_count = c.get("replyCount")          # 直接显示这个数字
    if reply_count > 0:
        print(f"{c['content'][:20]}  共 {reply_count} 条回复")
        # 2) 用户点击时才懒加载子评论
        subs = post_eapi("/api/resource/comment/floor/get", {
            "parentCommentId": c["commentId"],
            "threadId": "R_SO_4_186016",
            "time": -1,            # ← 必须是 -1
            "limit": 20,
        })
        for s in (subs.get("data") or {}).get("comments") or []:
            print("   └─", s.get("content"))
```

---

## 7. 批量接口

### 7.1 接口

```
POST https://interface.music.163.com/eapi/batch
```

### 7.2 格式

请求体（加密前）是一个对象，key 是路由，value 是**该路由参数的 JSON 字符串**：

```json
{
  "/api/song/lyric":  "{\"id\":\"186016\",\"tv\":-1,\"lv\":-1,\"rv\":-1,\"kv\":-1}",
  "/api/song/detail": "{\"ids\":[186016,347230]}"
}
```

> ⚠️ **value 必须是 JSON 字符串，不能直接放对象。**
> 传对象会返回 `code: 400`；传 JSON 字符串才返回 200。

响应按同样的 key 返回，value 是解析后的对象：

```jsonc
{
  "code": 200,
  "/api/song/lyric":  { "code": 200, "lrc": { "lyric": "..." } },
  "/api/song/detail": { "code": 200, "songs": [ ... ] }
}
```

### 7.3 Python 示例

```python
import json

def post_batch(tasks):
    """tasks = {"/api/路由": 参数字典}"""
    payload = {}
    for route, params in tasks.items():
        payload[route] = json.dumps(params, ensure_ascii=False, separators=(",", ":"))
    return post_eapi("/api/batch", payload)


r = post_batch({
    "/api/song/lyric":  {"id": "186016", "tv": -1, "lv": -1, "rv": -1, "kv": -1},
    "/api/song/detail": {"ids": [186016, 347230]},
})
```

### 7.4 实测限制

| 情况 | 结果 |
|---|---|
| `/api/song/detail` 传 `ids: [186016, 347230]`（数组） | ✅ 200 |
| `/api/song/detail` 传 `ids: "186016,347230"`（字符串） | ❌ 400 |
| `/api/song/lyric` 传 `id: "186016"`（单个） | ✅ 200 |
| `/api/song/lyric` 传 `id: "186016,347230"` | ❌ 400 wrong params |
| `/api/song/lyric` 传 `id: [186016, 347230]` | ❌ 400 wrong params |
| 多个不同路由各一次 | ✅ 全部 200 |

> **结论：`/api/batch` 不能用来批量取歌词。**
> 批量歌词请用**并发**（见第 8 节）。
> 唯一例外：`/api/song/detail` 传 `ids: [数组]` 可一次拿多首详情。

---

## 8. 性能

### 8.1 实测数据（14 首歌，同一网络环境）

| 方案 | 耗时 | 吞吐 |
|---|---|---|
| 单条串行 `POST /eapi/song/lyric` | 2.64 s | 5.3 首/s |
| 线程池 4 线程 | 0.74 s | 18.8 首/s |
| **线程池 8 线程** | **0.48 s** | **29.2 首/s** |
| `/api/batch` + 8 线程 | 0.51 s | 27.5 首/s |
| 搜索（4 次） | 1.28 s | 3.1 次/s |

### 8.2 最快方案

**线程池 8 线程并发，比串行快 5.5 倍。**

```python
from concurrent.futures import ThreadPoolExecutor

def lyrics_batch(song_ids, workers=8):
    def job(i):
        return i, post_eapi("/api/song/lyric", {
            "id": i, "tv": -1, "lv": -1, "rv": -1, "kv": -1, "_nmclfl": 1,
        }).get("lrc", {}).get("lyric", "")
    with ThreadPoolExecutor(max_workers=workers) as ex:
        return dict(ex.map(job, song_ids))
```

要点：
- 网络 I/O 密集，GIL 不影响，多线程即可吃满带宽。
- 用 `requests.Session` 复用 TCP 连接。
- **不要超过 16 线程**，容易触发风控（返回 `code: -6` / `418`）。
- 搜索比歌词慢 2 倍，尽量只搜一次并缓存 id。

### 8.3 YouTube Music 客户端接入建议

| 场景 | 做法 |
|---|---|
| 首次定位 | 搜索拿 id 后缓存（`歌名+歌手+时长 -> id`） |
| 播放前预取 | 提前 3~5 首并发预取歌词 |
| 缓存 | LRU + 本地持久化（sqlite / json），避免重复请求 |
| 降速 | 触发风控后指数退避 |

---

## 9. 完整调用示例

### 9.1 只有歌名/歌手/时长 → 拿歌词 + 热评 + 新评论

```python
import time
from concurrent.futures import ThreadPoolExecutor
import requests, urllib3
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad

urllib3.disable_warnings()

API = "https://interface.music.163.com"
EAPI_KEY, EAPI_SALT = "e82ckenh8dichen8", "36cd479b6b5"
UA = "NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)"
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": UA,
                         "Content-Type": "application/x-www-form-urlencoded"})


def build_header():
    now = int(time.time() * 1000)
    return {"osver": "16.2", "deviceId": "F0000000000000000000000000000000",
            "os": "iPhone OS", "appver": "9.0.90", "versioncode": "140",
            "mobilename": "", "buildver": str(now)[:10],
            "resolution": "1920x1080", "__csrf": "", "channel": "distribution",
            "requestId": f"{now}_{now % 10000:04d}"}


def eapi_encrypt(uri, data):
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    digest = hashlib.md5(("nobody" + uri + "use" + text + "md5forencrypt").encode()).hexdigest()
    payload = f"{uri}-{EAPI_SALT}-{text}-{EAPI_SALT}-{digest}"
    return AES.new(EAPI_KEY.encode(), AES.MODE_ECB).encrypt(pad(payload.encode(), 16)).hex().upper()


def post_eapi(uri, data):
    body = dict(data)
    body["header"] = build_header()
    params = eapi_encrypt(uri, body)
    r = SESSION.post(API + "/eapi/" + uri.lstrip("/api/"),
                     data={"params": params}, timeout=20, verify=False)
    return r.json()


# --- 1) 搜索 + 时长定位 ---
hits = post_eapi("/api/search/get", {"s": "周杰伦 晴天", "type": 1, "limit": 15, "offset": 0})
songs = (hits.get("result") or {}).get("songs") or []
song = min(songs, key=lambda s: abs((s.get("duration") or 0) - 269000))
song_id = song["id"]

# --- 2) 并发取歌词 / 热评 / 新评 ---
def get_lyric():
    r = post_eapi("/api/song/lyric", {"id": song_id, "tv": -1, "lv": -1, "rv": -1, "kv": -1, "_nmclfl": 1})
    return (r.get("lrc") or {}).get("lyric", "")


def get_hot():
    r = post_eapi("/api/v2/resource/comments", {
        "threadId": f"R_SO_4_{song_id}", "pageNo": 1, "showInner": True,
        "pageSize": 20, "cursor": "normalHot#0", "sortType": 2})
    return (r.get("data") or {}).get("comments") or []


def get_new():
    r = post_eapi("/api/v2/resource/comments", {
        "threadId": f"R_SO_4_{song_id}", "pageNo": 1, "showInner": True,
        "pageSize": 20, "cursor": "0", "sortType": 3})
    return (r.get("data") or {}).get("comments") or []


with ThreadPoolExecutor(max_workers=3) as ex:
    lrc, hot, new = ex.map(lambda f: f(), [get_lyric, get_hot, get_new])

print(song["name"], song_id)
print("歌词", len(lrc), "字符 | 热评", len(hot), "条 | 新评", len(new), "条")
```

### 9.2 只要热评 + 新评论，一行搞定

```python
def comments_by_title(title, artist, hot_limit=20, new_limit=20):
    r = post_eapi("/api/cloudsearch/pc", {"s": f"{title} {artist}", "type": 1,
                                           "limit": 5, "offset": 0, "total": True})
    songs = (r.get("result") or {}).get("songs") or []
    if not songs:
        return None, [], []
    sid = songs[0]["id"]
    hot = post_eapi("/api/v2/resource/comments", {
        "threadId": f"R_SO_4_{sid}", "pageNo": 1, "showInner": True,
        "pageSize": hot_limit, "cursor": "normalHot#0", "sortType": 2})
    new = post_eapi("/api/v2/resource/comments", {
        "threadId": f"R_SO_4_{sid}", "pageNo": 1, "showInner": True,
        "pageSize": new_limit, "cursor": "0", "sortType": 3})
    return (sid,
            (hot.get("data") or {}).get("comments") or [],
            (new.get("data") or {}).get("comments") or [])
```

---

## 10. 错误码

| code / message | 含义 | 处理 |
|---|---|---|
| `200` | 成功 | - |
| `400 wrong params` | 缺参数或参数格式错（如歌词传了多个 id） | 检查参数 |
| `400 参数错误` | 同上 | 检查参数 |
| `404 接口未找到！` | 路由不存在 | 检查 URL 拼写 |
| `404` | 资源不存在（如该路由不存在） | - |
| `-6` | 频率过高被风控 | 降速 + 退避 |
| `418` | 被限流 | 降低并发 + 缓存 |
| HTTP 200 + 空 body | 加密串错误 | 检查 `uri` 是否含 `/api` 前缀、密钥、MD5 拼接顺序 |

> 业务层面的「失败」几乎都返回 HTTP 200，靠 body 里的 `code` 判断。
> 查歌词时 `code=200` 但 `lrc.lyric` 为空 = 该歌曲没有歌词（正常情况，不是错误）。

---

## 附：接口速查表

| 用途 | 路由 | 关键参数 |
|---|---|---|
| 模糊搜索 | `POST /eapi/search/get` | `s`, `type`, `limit`, `offset` |
| 云搜索 | `POST /eapi/cloudsearch/pc` | `s`, `type`, `limit`, `offset`, `total` |
| 歌词 | `POST /eapi/song/lyric` | `id`, `tv`, `lv`, `rv`, `kv` |
| 逐字歌词 | `POST /eapi/song/lyric/v1` | `id`, `cp`, `tv`~`yrv` |
| 热评 | `POST /eapi/v2/resource/comments` | `threadId`, `sortType=2`, `cursor="normalHot#0"` |
| 新评论 | `POST /eapi/v2/resource/comments` | `threadId`, `sortType=3`, `cursor="0"` |
| **子评论** | `POST /eapi/resource/comment/floor/get` | `parentCommentId`, `threadId`, **`time=-1`**, `limit` |
| 批量 | `POST /eapi/batch` | `{"/api/xxx": "<JSON字符串>"}` |
