#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""日程系统 · 本地数据服务 (纯标准库, 无第三方依赖)

职责:
  1. 把 Obsidian 库里的 md 日程文件解析成 JSON 给网页用
  2. 把网页上的修改写回 md (只动 AUTO 标记区段, 不碰你手写的内容)
  3. 托管 web/ 目录下的日历界面

启动: 双击 启动.vbs  或  python server.py
访问: http://127.0.0.1:8770   (手机: http://<本机局域网IP>:8770)
"""
import http.server
import base64
import glob
import hmac
import json
import os
import re
import secrets
import socketserver
import datetime
import socket
import threading
import urllib.parse

BASE = os.path.dirname(os.path.abspath(__file__))
VAULT = os.environ.get("SCHEDULE_VAULT", r"D:\Obsidian笔记库\日程")
WEB = os.path.join(BASE, "web")
PORT = int(os.environ.get("SCHEDULE_PORT", "8770"))

LOCK = threading.Lock()


# ---------------------------------------------------------------- 认证

AUTH_FILE = os.path.join(BASE, "auth.json")
PWD_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"


def load_auth() -> dict:
    """每次现读，改 auth.json 后不用重启"""
    try:
        with open(AUTH_FILE, "r", encoding="utf-8") as f:
            cfg = json.load(f)
            return cfg if isinstance(cfg, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def ensure_auth() -> dict:
    """首次启动生成随机密码"""
    cfg = load_auth()
    if cfg.get("password"):
        return cfg
    cfg = {
        "user": cfg.get("user") or "dong",
        "password": "".join(secrets.choice(PWD_ALPHABET) for _ in range(8)),
    }
    try:
        with open(AUTH_FILE, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    except OSError:
        pass
    return cfg

# ---------------------------------------------------------------- 路径

def year_dir() -> str:
    p = os.path.join(VAULT, str(datetime.date.today().year))
    os.makedirs(p, exist_ok=True)
    return p


def day_path(d: str) -> str:
    return os.path.join(VAULT, d[:4], d + ".md")


def month_path(ym: str) -> str:
    return os.path.join(VAULT, ym[:4], ym + ".md")


def week_path(iso: str) -> str:
    return os.path.join(VAULT, iso[:4], iso + ".md")


# ---------------------------------------------------------------- 解析

EVENT_RE = re.compile(r"^- (\d{1,2}:\d{2})\s*[-–~]\s*(\d{1,2}:\d{2})\s+(.+)$")
ALLDAY_RE = re.compile(r"^- 全天\s+(.+)$")
TODO_RE = re.compile(r"^- \[( |x|X)\]\s*(.+)$")
TAG_RE = re.compile(r"#([^\s#]+)")


def split_tags(text: str):
    tags = TAG_RE.findall(text)
    title = TAG_RE.sub("", text).strip()
    return title, tags


def parse_day(date: str, text: str) -> dict:
    events, todos = [], []
    section = None
    for raw in text.splitlines():
        s = raw.strip()
        if not s:
            continue
        if s.startswith("<!-- AUTO:events:start"):
            section = "events"
            continue
        if s.startswith("<!-- AUTO:events:end"):
            section = None
            continue
        if s.startswith("<!-- AUTO:todos:start"):
            section = "todos"
            continue
        if s.startswith("<!-- AUTO:todos:end"):
            section = None
            continue
        if section == "events":
            m = EVENT_RE.match(s)
            if m:
                title, tags = split_tags(m.group(3))
                if title:
                    events.append({"start": m.group(1).zfill(5),
                                   "end": m.group(2).zfill(5),
                                   "title": title, "tags": tags, "allday": False})
                continue
            m = ALLDAY_RE.match(s)
            if m:
                title, tags = split_tags(m.group(1))
                if title:
                    events.append({"start": "", "end": "", "title": title,
                                   "tags": tags, "allday": True})
                continue
        elif section == "todos":
            m = TODO_RE.match(s)
            if m:
                todos.append({"done": m.group(1).lower() == "x", "text": m.group(2).strip()})
    return {"date": date, "events": events, "todos": todos}


def parse_list_section(text: str, heading_kw: str) -> list:
    """读取 `## 本月目标` / `## 本周重点` 之类小节下的 checklist 行"""
    out, inside = [], False
    for raw in text.splitlines():
        s = raw.strip()
        if s.startswith("## "):
            inside = heading_kw in s
            continue
        if not inside:
            continue
        m = TODO_RE.match(s)
        if m:
            body = m.group(2).strip()
            day = None
            dm = re.search(r"@(\d{4}-\d{2}-\d{2})", body)
            if dm:
                day = dm.group(1)
                body = body.replace(dm.group(0), "").strip()
            out.append({"done": m.group(1).lower() == "x", "text": body, "date": day})
    return out


def parse_month(ym: str, text: str) -> dict:
    return {"ym": ym,
            "goals": parse_list_section(text, "本月目标"),
            "milestones": parse_list_section(text, "关键节点")}


def parse_week(iso: str, text: str) -> dict:
    return {"iso": iso, "goals": parse_list_section(text, "本周重点")}


# ---------------------------------------------------------------- 写回

def render_events(events: list) -> list:
    rows = []
    for e in sorted(events, key=lambda x: ("99:99" if x.get("allday") else x.get("start", ""))):
        title = (e.get("title") or "").strip()
        if not title:
            continue
        tags = "".join(" #" + str(t).lstrip("#") for t in (e.get("tags") or []) if str(t).strip())
        if e.get("allday"):
            rows.append(f"- 全天 {title}{tags}")
        else:
            rows.append(f"- {e.get('start', '00:00')}-{e.get('end', '00:00')} {title}{tags}")
    return rows


def render_todos(todos: list) -> list:
    return [f"- [{'x' if t.get('done') else ' '}] {(t.get('text') or '').strip()}"
            for t in todos if (t.get("text") or "").strip()]


def replace_section(text: str, name: str, lines: list) -> str:
    start_tag = f"<!-- AUTO:{name}:start -->"
    end_tag = f"<!-- AUTO:{name}:end -->"
    body = "\n".join(lines)
    block = start_tag + ("\n" + body if body else "") + "\n" + end_tag
    if start_tag in text and end_tag in text:
        i = text.index(start_tag)
        j = text.index(end_tag) + len(end_tag)
        return text[:i] + block + text[j:]
    return text.rstrip("\n") + "\n\n" + block + "\n"


WEEKDAY_CN = "一二三四五六日"


def day_template(date: str) -> str:
    d = datetime.date.fromisoformat(date)
    return (f"---\ndate: {date}\ntype: 日计划\ntags:\n  - 日程\n---\n\n"
            f"# {date} 周{WEEKDAY_CN[d.weekday()]}\n\n"
            "## 时间块\n<!-- AUTO:events:start -->\n<!-- AUTO:events:end -->\n\n"
            "## 待办\n<!-- AUTO:todos:start -->\n<!-- AUTO:todos:end -->\n\n"
            "## 备注\n")


def read_text(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return ""
    except UnicodeDecodeError:
        with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
            return f.read()


def write_text(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, path)


def iso_week(d: datetime.date) -> str:
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def api_search(q: str) -> dict:
    """模糊搜索：日期数字（1022 / 10-22）或正文关键词"""
    q = (q or "").strip()
    if not q or not os.path.isdir(VAULT):
        return {"q": q, "results": []}
    ql = q.lower().replace(" ", "")
    digits = re.sub(r"\D", "", ql)

    out = []
    for path in sorted(glob.glob(os.path.join(VAULT, "**", "*.md"), recursive=True)):
        base = os.path.basename(path)
        name = os.path.splitext(base)[0]
        if not re.fullmatch(r"\d{4}(-\d{2}-\d{2}|-\d{2}|-W\d{2})", name):
            continue
        kind = "day" if re.fullmatch(r"\d{4}-\d{2}-\d{2}", name) else (
            "week" if "W" in name else "month")
        text = read_text(path)

        compact = name.replace("-", "").lower()
        date_hit = len(digits) >= 3 and digits in compact

        body = text.split("---", 2)[-1] if text.lstrip().startswith("---") else text
        hits = []
        for line in body.splitlines():
            s = line.strip()
            if not s or s.startswith("#") or s.startswith("<!--"):
                continue
            if ql in s.lower().replace(" ", ""):
                hit = re.sub(r"^\[( |x|X)\]\s*", "", s.lstrip("- ")).strip()
                hits.append(hit[:70])
        if not hits and not date_hit:
            continue
        out.append({"kind": kind, "id": name, "hits": hits[:3], "n": len(hits), "_d": date_hit})

    out.sort(key=lambda x: (not x["_d"], x["id"]))
    for o in out:
        o.pop("_d", None)
    return {"q": q, "results": out[:25]}


def daterange(start: datetime.date, end: datetime.date):
    cur = start
    while cur <= end:
        yield cur
        cur += datetime.timedelta(days=1)


# ---------------------------------------------------------------- API


def api_range(qs: dict) -> dict:
    today = datetime.date.today()
    try:
        start = datetime.date.fromisoformat(qs.get("from", today.isoformat()))
        end = datetime.date.fromisoformat(qs.get("to", start.isoformat()))
    except ValueError:
        start = end = today
    if end < start:
        start, end = end, start
    if (end - start).days > 400:
        end = start + datetime.timedelta(days=400)

    days = {}
    for d in daterange(start, end):
        ds = d.isoformat()
        text = read_text(day_path(ds))
        days[ds] = parse_day(ds, text) if text else {"date": ds, "events": [], "todos": []}

    months, weeks = {}, {}
    for d in daterange(start, end):
        ym = d.strftime("%Y-%m")
        if ym not in months:
            t = read_text(month_path(ym))
            if t:
                months[ym] = parse_month(ym, t)
        iso = iso_week(d)
        if iso not in weeks:
            t = read_text(week_path(iso))
            if t:
                weeks[iso] = parse_week(iso, t)

    return {"from": start.isoformat(), "to": end.isoformat(),
            "today": today.isoformat(), "days": days,
            "months": months, "weeks": weeks}


def api_save_day(payload: dict) -> dict:
    date = (payload.get("date") or "").strip()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise ValueError("date 必须是 YYYY-MM-DD")
    path = day_path(date)
    with LOCK:
        text = read_text(path)
        if not text:
            text = day_template(date)
        text = replace_section(text, "events", render_events(payload.get("events") or []))
        text = replace_section(text, "todos", render_todos(payload.get("todos") or []))
        write_text(path, text)
    return {"ok": True, "path": path, "day": parse_day(date, text)}


def api_save_text(payload: dict) -> dict:
    """供 AI / 外部脚本整文件写入 md (仅允许 VAULT 内)"""
    rel = (payload.get("path") or "").replace("\\", "/").lstrip("/")
    target = os.path.normpath(os.path.join(VAULT, rel))
    if not target.startswith(os.path.normpath(VAULT)):
        raise ValueError("路径越界")
    if not target.endswith(".md"):
        raise ValueError("只允许 .md")
    with LOCK:
        write_text(target, payload.get("content") or "")
    return {"ok": True, "path": target}


# ---------------------------------------------------------------- HTTP


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "ScheduleCalendar/0.1"

    def log_message(self, fmt, *args):
        pass  # 静音, 避免刷屏

    def _auth_ok(self) -> bool:
        """本机免密；外部访问走 Basic Auth"""
        ip = self.client_address[0] if self.client_address else ""
        if ip in ("127.0.0.1", "::1"):
            return True
        cfg = load_auth()
        if not cfg.get("password"):
            return True
        hdr = self.headers.get("Authorization", "")
        if not hdr.startswith("Basic "):
            return False
        try:
            raw = base64.b64decode(hdr[6:]).decode("utf-8")
            user, _, pwd = raw.partition(":")
        except Exception:  # noqa: BLE001
            return False
        return (hmac.compare_digest(user.encode("utf-8"), str(cfg.get("user", "")).encode("utf-8"))
                and hmac.compare_digest(pwd.encode("utf-8"), str(cfg["password"]).encode("utf-8")))

    def _deny(self):
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="schedule"')
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _send(self, code: int, body: bytes, ctype: str = "application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _static(self, path: str):
        rel = urllib.parse.unquote(path).lstrip("/") or "index.html"
        target = os.path.normpath(os.path.join(WEB, rel))
        if not target.startswith(os.path.normpath(WEB)) or not os.path.isfile(target):
            self._send(404, b"not found", "text/plain; charset=utf-8")
            return
        ext = os.path.splitext(target)[1].lower()
        ctype = {".html": "text/html; charset=utf-8",
                 ".js": "application/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8",
                 ".svg": "image/svg+xml",
                 ".json": "application/json; charset=utf-8"}.get(ext, "application/octet-stream")
        with open(target, "rb") as f:
            self._send(200, f.read(), ctype)

    def do_GET(self):
        if not self._auth_ok():
            self._deny()
            return
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/ping":
            self._json({"ok": True, "vault": VAULT, "port": PORT, "lan": lan_ip()})
        elif parsed.path == "/api/range":
            qs = urllib.parse.parse_qs(parsed.query)
            q = {k: v[0] for k, v in qs.items()}
            self._json(api_range(q))
        elif parsed.path == "/api/search":
            qs = urllib.parse.parse_qs(parsed.query)
            self._json(api_search((qs.get("q") or [""])[0]))
        else:
            self._static(parsed.path)

    def do_POST(self):
        if not self._auth_ok():
            self._deny()
            return
        parsed = urllib.parse.urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except UnicodeDecodeError:
            try:  # 有些命令行工具/旧脚本会发 GBK
                payload = json.loads(raw.decode("gbk") or "{}")
            except Exception:  # noqa: BLE001
                self._json({"ok": False, "error": "请求体既不是 UTF-8 也不是 GBK"}, 400)
                return
        except json.JSONDecodeError:
            self._json({"ok": False, "error": "JSON 解析失败"}, 400)
            return
        try:
            if parsed.path == "/api/day":
                self._json(api_save_day(payload))
            elif parsed.path == "/api/text":
                self._json(api_save_text(payload))
            else:
                self._json({"ok": False, "error": "unknown endpoint"}, 404)
        except Exception as e:  # noqa: BLE001
            self._json({"ok": False, "error": str(e)}, 500)


class Server(socketserver.ThreadingTCPServer):
    # Windows 上 SO_REUSEADDR 允许两个进程绑同一端口, 会导致并发写同一批文件。
    # 这里关掉, 保证同时只有一个服务实例。
    allow_reuse_address = False
    daemon_threads = True


def lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def main():
    os.makedirs(VAULT, exist_ok=True)
    auth = ensure_auth()
    try:
        httpd = Server(("0.0.0.0", PORT), Handler)
    except OSError as e:
        print(f"端口 {PORT} 已被占用，服务大概已经在运行了。({e})")
        print("浏览器直接开 http://127.0.0.1:%d 就行。" % PORT)
        return
    print(f"日程服务已启动")
    print(f"  电脑: http://127.0.0.1:{PORT}    (本机不用密码)")
    print(f"  手机: http://{lan_ip()}:{PORT}")
    print(f"        用户 {auth['user']}   密码 {auth['password']}")
    print(f"  数据: {VAULT}")
    print("Ctrl+C 停止")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
