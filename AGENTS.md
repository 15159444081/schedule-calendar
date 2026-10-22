# AGENTS.md · 给 AI 的说明书

> 你正在接手一个本机日程表程序。读完这份就能正确操作它，不用先读源码。
> 最后更新：2026-10-22（v0.1.2）

## 一、这是什么

三层日历（月 / 周 / 日）+ 一个本地文件服务。

- **数据不是数据库**，是 Obsidian 库里的 Markdown 文件。删掉程序，数据还在。
- **程序是单个 Python 文件**，只用标准库，没有任何第三方依赖。
- **界面是原生 HTML/CSS/JS**，无框架、无构建步骤，改完刷新浏览器就生效。
- 服务同时充当：静态文件服务器 + Markdown ⇄ JSON 转换器 + 写入接口。

三类角色各取所需：人看网页，Obsidian 看文件，AI 看文件或调接口。

## 二、目录

```
程序目录（可任意移动，数据路径不跟着变）
├── server.py           全部后端逻辑（约 500 行）
├── web/
│   ├── index.html      骨架
│   ├── style.css       全部样式，含深色模式
│   └── app.js          全部前端逻辑（约 580 行）
├── auth.json           访问凭据（首次启动自动生成）
├── 启动.vbs            静默启动（无窗口）
├── 打开日历.bat        启动 + 打开浏览器
├── README.md           给人看的运行说明
├── DEVLOG.md           开发日志（客观记录改动与取舍）
└── AGENTS.md           本文档

数据目录（默认 D:\Obsidian笔记库\日程，可用环境变量 SCHEDULE_VAULT 覆盖）
├── 00_格式说明.md      数据格式规范（与本文第三节一致）
└── 2026/
    ├── 2026-10.md      月计划（YYYY-MM）
    ├── 2026-W43.md     周计划（YYYY-Www，ISO 周）
    └── 2026-10-22.md   日计划（YYYY-MM-DD）
```

## 三、数据格式

### 日文件 `2026-10-22.md`

```markdown
---
date: 2026-10-22
type: 日计划
tags:
  - 日程
---

# 2026-10-22 周四

## 时间块
<!-- AUTO:events:start -->
- 09:00-11:00 写代码 #项目
- 14:00-16:00 家教 #工作
- 全天 交作业 #学校
<!-- AUTO:events:end -->

## 待办
<!-- AUTO:todos:start -->
- [ ] 买笔记本
- [x] 回消息
<!-- AUTO:todos:end -->

## 备注
网页不解析这里，随便写。
```

### 周文件 / 月文件

```markdown
## 本周重点          ← 周文件用这个标题
- [ ] 日程框架上线 @2026-10-23
- [ ] 家教排课确认

## 本月目标          ← 月文件用这个标题
- [ ] 日程系统跑通

## 关键节点          ← 月文件专用
- [ ] 10-25 期中考试
```

### 规则

- 事件行只有两种：`- HH:MM-HH:MM 标题 #标签` 和 `- 全天 标题 #标签`。
- 标签用 `#` 开头、空格分隔，可多个可没有；标题里别用 `#`。
- 待办行：`- [ ] 未完成` / `- [x] 已完成`。
- **只改 `<!-- AUTO:xxx:start -->` 与 `<!-- AUTO:xxx:end -->` 之间的内容。** 标记外是用户手写区，改了会丢用户内容。
- 时间超出 06:00–24:00 的事件网页不画，但文件里保留。

## 四、HTTP API

默认 `http://127.0.0.1:8770`。端口改 `server.py` 顶部 `PORT`，或环境变量 `SCHEDULE_PORT`。

### 认证

- 本机 `127.0.0.1` **免密**。
- 其他来源需 HTTP Basic：`curl -u 用户名:密码`。
- 凭据在 `auth.json`：`{"user": "...", "password": "..."}`。首次启动若文件不存在会自动生成随机密码。
- 改密码直接改文件，**即时生效，不用重启**。

### GET /api/ping

探活。返回 `{"ok":true,"vault":"...","port":8770}`。

### GET /api/range?from=YYYY-MM-DD&to=YYYY-MM-DD

主力读接口。返回区间内每天的数据，外加区间涉及的月计划、周计划。

```json
{
  "from": "2026-10-19", "to": "2026-10-25", "today": "2026-10-22",
  "days": {
    "2026-10-22": {
      "date": "2026-10-22",
      "events": [{"start":"09:00","end":"11:00","title":"写代码","tags":["项目"],"allday":false}],
      "todos": [{"done":false,"text":"买笔记本"}]
    }
  },
  "months": {"2026-10": {"ym":"2026-10","goals":[],"milestones":[]}},
  "weeks":  {"2026-W43": {"iso":"2026-W43","goals":[]}}
}
```

没有文件的日期也会出现在 `days` 里，内容为空数组——前端靠这个渲染空白格。

### GET /api/search?q=关键词

全库模糊搜索。日期数字（`10-23`、`1023`）和正文关键词都行。

```json
{"q":"10-23","results":[
  {"kind":"day","id":"2026-10-23","hits":[],"n":0},
  {"kind":"week","id":"2026-W43","hits":["日程框架上线 @2026-10-23"],"n":1}
]}
```

`kind` 为 `day` / `week` / `month`，`id` 可直接拿去跳转。

### POST /api/day

写某一天。**整体替换**当天的 events 和 todos——想追加就先 GET 再改再 POST。

```bash
curl -u 用户:密码 -X POST http://127.0.0.1:8770/api/day \
  -H "Content-Type: application/json" \
  -d '{"date":"2026-10-23",
       "events":[{"start":"09:00","end":"10:00","title":"写代码","tags":["项目"],"allday":false}],
       "todos":[{"done":false,"text":"买笔记本"}]}'
```

文件不存在会按模板新建；已存在只替换 AUTO 区段，标记外内容原样保留。

### POST /api/text

整文件写（给批量导入用）。`path` 相对数据目录，只允许 `.md`，不能越界。

```bash
curl -u 用户:密码 -X POST http://127.0.0.1:8770/api/text \
  -H "Content-Type: application/json" \
  -d '{"path":"2026/2026-10-26.md","content":"---\ndate: 2026-10-26\n---\n\n# ..."}'
```

## 五、启停

```bash
# 启动（静默，无窗口）
cscript //nologo 启动.vbs

# 或前台跑，看日志
python server.py
```

- 已在运行时再启动会打印「端口已被占用」并退出，不会起第二份。
- 停止：`powershell -Command "Get-Process pythonw | Stop-Process -Force"`。
- 开机自启：`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\日程表服务.lnk`。
- **改 server.py 必须重启**；改 `web/` 下的文件刷新浏览器即可；改 `auth.json` 即时生效。

## 六、代码地图

`server.py`

| 区块 | 作用 |
|---|---|
| 路径函数 | `day_path` / `month_path` / `week_path`，按年份分目录 |
| 解析 | `parse_day` / `parse_month` / `parse_week`，正则读 AUTO 区段 |
| 写回 | `render_events` / `render_todos` / `replace_section`，只替换标记区 |
| 搜索 | `api_search`，遍历全部 md 做子串匹配 |
| 认证 | `load_auth` / `ensure_auth` / `Handler._auth_ok` |
| HTTP | `Handler` 的 `do_GET` / `do_POST`；`_static` 托管 web/ |

`web/app.js`

| 区块 | 作用 |
|---|---|
| 基础工具 | 日期计算、ISO 周、HTML 转义、时间→像素换算 |
| 状态 | `state`（视图 / 光标日期 / 数据缓存） |
| 数据 | `load` 拉区间、`saveDay` 写回；30 秒自动重拉 |
| 渲染 | `renderMonth` / `renderWeek` / `renderDay` / `planBar` |
| 搜索 | `initSearch` / `doSearch` / `jumpTo` |
| 交互 | `bindStatic` / `bindMain`，事件委托统一处理点击 |

## 七、改动约束

1. 不要破坏 AUTO 标记的配对，否则解析失效、网页显示为空。
2. 不要在标记外写自动生成的内容——会覆盖用户手写。
3. 时间轴目前固定 06:00–24:00，改范围要同时改 `app.js` 的 `H0/H1` 与 `PX`。
4. 前端不引第三方库（CDN 也不行），保持离线可用。
5. 后端只用 Python 标准库，不引入依赖。
6. 端口、数据目录走 `PORT` / `SCHEDULE_VAULT`，别写死在多处。
7. 传播给别人时删掉 `auth.json`，让对方首次启动自动生成自己的密码。

## 八、已知限制

- 只支持单机局域网访问；跨网络要另配内网穿透或 Obsidian 同步插件。
- 认证是 HTTP Basic，明文传输，不做防抓包。
- 事件不支持跨天、重复规则（每周三）、提醒。
- 周计划里的 `@日期` 只是文本标注，没有自动落到对应日。
- 一次只跑一个实例（端口独占），没有多用户概念。
