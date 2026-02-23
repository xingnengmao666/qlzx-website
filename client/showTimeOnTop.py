"""
ShowTimeOnTop — Fluent UI Edition
A modern always-on-top clock with acrylic-glass aesthetic,
smooth animations, and optional NTP time synchronization.
"""

# ╔══════════════════════════════════════════════════════════════════════════╗
# ║                        用 户 自 定 义 区                                ║
# ║  修改下方数值后重新运行程序即可生效，无需改动其他代码。                 ║
# ╠══════════════════════════════════════════════════════════════════════════╣
# ║  窗口尺寸（像素）                                                       ║
WIN_WIDTH        = 675    # 窗口宽度
WIN_HEIGHT       = 300    # 窗口高度
# ║  窗口初始位置：距屏幕右/上边缘的距离（像素）                            ║
WIN_MARGIN_RIGHT = 20
WIN_MARGIN_TOP   = 20
# ║  初始透明度（0.2 最透明 ～ 1.0 完全不透明）                             ║
WIN_ALPHA        = 0.93
# ║  默认 NTP 服务器                                                        ║
NTP_SERVER_DEFAULT = "pool.ntp.org"
# ║  字体（需系统已安装；Windows 推荐保持默认，macOS 可改为 SF Pro Display）║
FONT_MAIN        = "Segoe UI Light"   # 大时间数字字体
FONT_UI          = "Segoe UI"         # 日期 / 按钮等界面字体
FONT_SIZE_CLOCK  = 36                 # 时间数字大小（pt）
FONT_SIZE_DATE   = 9                  # 日期文字大小（pt）
# ║  CF Worker 时间服务 URL（填入你的 Worker 地址，留空则禁用此功能）        ║
# ║  示例: "https://my-time.yourname.workers.dev"                           ║
CF_WORKER_URL    = "https://timeapi.qlzx.lol"                 # ← 填入你的 Worker 域名（如 https://timeapi.qlzx.lol）
# ║  公告功能（CF_WORKER_URL 非空时自动启用，每 60 秒拉取一次）             ║
NOTICE_INTERVAL  = 15               # 公告刷新间隔（秒）
NOTICE_DURATION  = 8                  # 每条公告显示秒数（轮播）
# ╚══════════════════════════════════════════════════════════════════════════╝

import tkinter as tk
from datetime import datetime, timezone, timedelta
import threading
import socket
import struct
import time
import sys
import math
import urllib.request
import json

# ── Windows 高 DPI 感知（必须在创建任何窗口之前调用）──────────────────────
if sys.platform == "win32":
    try:
        import ctypes
        ctypes.windll.shcore.SetProcessDpiAwareness(2)   # Per-Monitor DPI Aware v1
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()    # 旧版 fallback
        except Exception:
            pass

# ── NTP ────────────────────────────────────────────────────────────────────
NTP_EPOCH_DELTA  = 2208988800
DEFAULT_NTP_HOST = NTP_SERVER_DEFAULT

def query_ntp(server: str, timeout: float = 3.0):
    try:
        pkt = bytearray(48)
        pkt[0] = 0x1B
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(timeout)
            s.sendto(pkt, (server, 123))
            data, _ = s.recvfrom(48)
        ntp_sec = struct.unpack("!I", data[40:44])[0]
        return datetime.fromtimestamp(ntp_sec - NTP_EPOCH_DELTA, tz=timezone.utc)
    except Exception:
        return None


def query_cf_worker(url: str, timeout: float = 5.0, samples: int = 4):
    """
    多次采样 CF Worker /api/time，用卡尔曼滤波融合偏差估算。

    算法：
      1. 发送 samples 次请求，每次用往返时延中点补偿计算原始偏差
      2. 丢弃 RTT 最大的样本（网络毛刺），取剩余最小 RTT 样本的偏差
         作为卡尔曼观测值——NTP 也用同样的"最小延迟"策略
      3. 用简单 1-D 卡尔曼滤波器（过程噪声 Q=1e-5，观测噪声 R 由
         实测 RTT 方差动态估计）融合历次调用的历史估计
    返回 (offset_seconds, best_rtt_ms, colo) 或 None。
    """
    api_url = url.rstrip("/") + "/api/time"
    raw = []
    colo = "??"
    for _ in range(samples):
        try:
            t0 = time.time()
            req = urllib.request.Request(
                api_url, headers={"User-Agent": "ShowTimeOnTop/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                t1   = time.time()
                data = json.loads(resp.read().decode())
            rtt_s     = t1 - t0
            srv_s     = data["unix_ms"] / 1000.0
            local_mid = (t0 + t1) / 2
            offset    = srv_s - local_mid
            colo      = data.get("cf_colo", "??")
            raw.append((rtt_s, offset))
        except Exception:
            pass
        time.sleep(0.05)   # 50ms 间隔，避免边缘限速

    if not raw:
        return None

    # 丢弃最大 RTT（若样本≥3），取剩余中 RTT 最小的
    if len(raw) >= 3:
        raw.sort(key=lambda x: x[0])
        raw = raw[:-1]
    best_rtt_s, best_offset = min(raw, key=lambda x: x[0])

    # ── 1-D 卡尔曼滤波（跨调用持久化在模块级状态里）──
    # 状态：(x_est, p_est)  初始值由第一次观测确定
    state = query_cf_worker._kalman
    Q = 1e-6    # 过程噪声：时钟漂移率（秒²/次）
    # 观测噪声：用所有样本 RTT 方差估计（RTT/2 ≈ 单程误差上界）
    rtts  = [r for r, _ in raw]
    R = max((sum((r - best_rtt_s)**2 for r in rtts) / len(rtts)) / 4, 1e-8)

    if state["p"] is None:
        # 初始化
        state["x"] = best_offset
        state["p"] = R
    else:
        # 预测
        p_pred = state["p"] + Q
        # 更新
        K = p_pred / (p_pred + R)
        state["x"] = state["x"] + K * (best_offset - state["x"])
        state["p"] = (1 - K) * p_pred

    return state["x"], best_rtt_s * 1000, colo

query_cf_worker._kalman = {"x": 0.0, "p": None}  # 模块级卡尔曼状态


# ── Palette (Fluent dark acrylic) ──────────────────────────────────────────
C = {
    "bg"          : "#1c1c2e",
    "surface"     : "#20213a",
    "surface2"    : "#2a2d50",
    "surface3"    : "#33376a",
    "border"      : "#3c4180",
    "border_dim"  : "#2a2d50",
    "accent"      : "#0078d4",
    "accent_lit"  : "#429ce3",
    "accent_dim"  : "#005a9e",
    "text_hi"     : "#ffffff",
    "text_mid"    : "#9da5c4",
    "text_lo"     : "#4e5578",
    "ok"          : "#13a10e",
    "warn"        : "#f7630c",
    "err"         : "#c42b1c",
    "err_hi"      : "#e81123",
}

# 字体变量（引用用户自定义区）
_SF  = FONT_UI
_SFL = FONT_MAIN


# ── Pill button (Fluent-style) ──────────────────────────────────────────────
class PillButton:
    """
    Fluent 胶囊按钮。
    用组合而非继承：外层是 tk.Frame（提供 pack/grid/place 接口），
    内层是独立创建的 tk.Canvas，彻底避免 Canvas 子类在某些 tkinter
    版本下把 width 数值当成控件 Tcl 名称的 bug。
    """
    def __init__(self, parent, text="", btn_w=80, btn_h=26,
                 fill=C["surface2"], fill_h=C["surface3"], fill_p=C["border"],
                 fg=C["text_hi"], command=None):
        try:
            parent_bg = parent.cget("bg")
        except Exception:
            parent_bg = C["surface"]

        self._fill   = fill
        self._fill_h = fill_h
        self._fill_p = fill_p
        self._fg     = fg
        self._text   = text
        self._cmd    = command
        self._bw     = btn_w
        self._bh     = btn_h
        self._r      = btn_h // 2

        # 外层 Frame —— 让调用方可以直接 .pack() / .grid()
        self._frame = tk.Frame(parent, bg=parent_bg,
                               width=btn_w, height=btn_h)
        self._frame.pack_propagate(False)

        # 内层 Canvas —— 负责绘制
        self._cv = tk.Canvas(self._frame, width=btn_w, height=btn_h,
                             bg=parent_bg, highlightthickness=0, bd=0)
        self._cv.pack()

        self._render(fill)

        for w in (self._frame, self._cv):
            w.bind("<Enter>",           lambda e: self._on_enter())
            w.bind("<Leave>",           lambda e: self._on_leave())
            w.bind("<ButtonPress-1>",   lambda e: self._render(self._fill_p))
            w.bind("<ButtonRelease-1>", lambda e: self._on_release())

    # ── 让外部可以像普通 widget 一样调用 pack/grid/place ──
    def pack(self, **kw):
        self._frame.pack(**kw)
        return self

    def grid(self, **kw):
        self._frame.grid(**kw)
        return self

    def place(self, **kw):
        self._frame.place(**kw)
        return self

    def _on_enter(self):
        self._render(self._fill_h)
        self._cv.config(cursor="hand2")

    def _on_leave(self):
        self._render(self._fill)
        self._cv.config(cursor="")

    def _on_release(self):
        self._render(self._fill_h)
        if self._cmd:
            self._cmd()

    def _render(self, fill):
        self._cv.delete("all")
        w, h, r = self._bw, self._bh, self._r
        for args in [
            (0,     0,     2*r,   2*r,   90,  90),
            (w-2*r, 0,     w,     2*r,   0,   90),
            (0,     h-2*r, 2*r,   h,     180, 90),
            (w-2*r, h-2*r, w,     h,     270, 90),
        ]:
            x0,y0,x1,y1,st,ex = args
            self._cv.create_arc(x0,y0,x1,y1, start=st, extent=ex,
                                fill=fill, outline="")
        self._cv.create_rectangle(r, 0, w-r, h,  fill=fill, outline="")
        self._cv.create_rectangle(0, r, w,   h-r, fill=fill, outline="")
        self._cv.create_text(w//2, h//2, text=self._text,
                             fill=self._fg, font=(_SF, 8), anchor="center")

    def update_text(self, t):
        self._text = t
        self._render(self._fill)

    def update_fill(self, f, fh=None):
        self._fill   = f
        self._fill_h = fh or f
        self._render(f)


# ── NTP Settings popup ──────────────────────────────────────────────────────
class NTPPopup(tk.Toplevel):
    PRESETS = [
        ("pool.ntp.org",     "Pool"),
        ("time.windows.com", "Windows"),
        ("ntp.aliyun.com",   "Aliyun"),
        ("cn.ntp.org.cn",    "CN Pool"),
        ("time.google.com",  "Google"),
        ("time.apple.com",   "Apple"),
    ]

    def __init__(self, parent, current_ntp, on_apply_ntp,
                 current_cf="", on_apply_cf=None):
        super().__init__(parent)
        self._on_apply_ntp = on_apply_ntp
        self._on_apply_cf  = on_apply_cf
        self.attributes("-topmost", True)
        self.overrideredirect(True)
        self.configure(bg=C["bg"])
        self.resizable(False, False)

        self._parent = parent
        W = 340   # 宽度固定；高度由内容自动撑开，之后 after(0) 精确定位

        # thin border frame
        outer = tk.Frame(self, bg=C["border"], bd=1)
        outer.pack(fill="both", expand=True, padx=1, pady=1)

        # title bar
        bar = tk.Frame(outer, bg=C["surface"], height=34)
        bar.pack(fill="x")
        bar.pack_propagate(False)
        tk.Label(bar, text="  NTP Server", bg=C["surface"],
                 fg=C["text_hi"], font=(_SF, 10, "bold")).pack(side="left", padx=8)
        x_btn = tk.Label(bar, text=" ✕ ", bg=C["surface"],
                         fg=C["text_mid"], font=(_SF, 10), cursor="hand2")
        x_btn.pack(side="right")
        x_btn.bind("<Enter>", lambda e: x_btn.config(bg=C["err"], fg=C["text_hi"]))
        x_btn.bind("<Leave>", lambda e: x_btn.config(bg=C["surface"], fg=C["text_mid"]))
        x_btn.bind("<Button-1>", lambda e: self.destroy())

        body = tk.Frame(outer, bg=C["bg"])
        body.pack(fill="both", expand=True, padx=14, pady=10)

        tk.Label(body, text="Server address", bg=C["bg"],
                 fg=C["text_mid"], font=(_SF, 9)).pack(anchor="w")

        ef = tk.Frame(body, bg=C["border_dim"], padx=1, pady=1)
        ef.pack(fill="x", pady=(3, 10))
        self._entry = tk.Entry(ef, font=(_SF, 10), bg=C["surface2"],
                               fg=C["text_hi"], insertbackground=C["accent_lit"],
                               relief="flat", bd=6)
        self._entry.insert(0, current_ntp)
        self._entry.pack(fill="x")
        self._entry.bind("<FocusIn>",  lambda e: ef.config(bg=C["accent"]))
        self._entry.bind("<FocusOut>", lambda e: ef.config(bg=C["border_dim"]))

        tk.Label(body, text="快捷预设", bg=C["bg"],
                 fg=C["text_mid"], font=(_SF, 9)).pack(anchor="w", pady=(0, 5))

        grid = tk.Frame(body, bg=C["bg"])
        grid.pack(fill="x")
        for i, (srv, lbl) in enumerate(self.PRESETS):
            b = tk.Label(grid, text=lbl, bg=C["surface2"], fg=C["text_mid"],
                         font=(_SF, 8), padx=6, pady=4, cursor="hand2")
            b.grid(row=i // 3, column=i % 3, padx=3, pady=3, sticky="ew")
            grid.columnconfigure(i % 3, weight=1)
            b.bind("<Button-1>", lambda e, s=srv: self._set(s))
            b.bind("<Enter>",    lambda e, x=b: x.config(bg=C["surface3"], fg=C["text_hi"]))
            b.bind("<Leave>",    lambda e, x=b: x.config(bg=C["surface2"], fg=C["text_mid"]))

        # ── CF Worker URL ──
        tk.Frame(body, bg=C["border_dim"], height=1).pack(fill="x", pady=(10,8))
        tk.Label(body, text="CF Worker URL（可选）", bg=C["bg"],
                 fg=C["text_mid"], font=(_SF, 9)).pack(anchor="w")
        cf_ef = tk.Frame(body, bg=C["border_dim"], padx=1, pady=1)
        cf_ef.pack(fill="x", pady=(3, 0))
        self._cf_entry = tk.Entry(cf_ef, font=(_SF, 9), bg=C["surface2"],
                                  fg=C["text_hi"], insertbackground=C["accent_lit"],
                                  relief="flat", bd=5)
        self._cf_entry.insert(0, current_cf)
        self._cf_entry.pack(fill="x")
        self._cf_entry.bind("<FocusIn>",  lambda e: cf_ef.config(bg=C["warn"]))
        self._cf_entry.bind("<FocusOut>", lambda e: cf_ef.config(bg=C["border_dim"]))
        tk.Label(body, text="留空则不使用 CF Worker 时间源",
                 bg=C["bg"], fg=C["text_lo"], font=(_SF, 8)).pack(anchor="w", pady=(2,0))

        act = tk.Frame(body, bg=C["bg"])
        act.pack(fill="x", pady=(10, 0))
        PillButton(act, "Apply", btn_w=80, btn_h=24,
                   fill=C["accent"], fill_h=C["accent_lit"], fill_p=C["accent_dim"],
                   command=self._apply).pack(side="left")
        PillButton(act, "Cancel", btn_w=80, btn_h=24,
                   command=self.destroy).pack(side="left", padx=8)

        # drag
        for w in (bar, body):
            w.bind("<Button-1>",  self._ds)
            w.bind("<B1-Motion>", self._dm)

        # 布局完成后居中定位（必须 after，否则 winfo_reqheight 还未计算）
        self.after(0, lambda: self._reposition(W))

    def _reposition(self, W):
        """根据实际内容高度 + 主窗口位置居中弹窗，防止超出屏幕。"""
        self.update_idletasks()
        H  = self.winfo_reqheight()
        sw = self.winfo_screenwidth()
        sh = self.winfo_screenheight()
        px = self._parent.winfo_rootx() + (self._parent.winfo_width()  - W) // 2
        py = self._parent.winfo_rooty() + (self._parent.winfo_height() - H) // 2
        px = max(4, min(px, sw - W - 4))
        py = max(4, min(py, sh - H - 4))
        self.geometry(f"{W}x{H}+{px}+{py}")

    def _set(self, s):
        self._entry.delete(0, "end")
        self._entry.insert(0, s)

    def _apply(self):
        ntp_val = self._entry.get().strip()
        cf_val  = self._cf_entry.get().strip()
        if ntp_val:
            self._on_apply_ntp(ntp_val)
        if self._on_apply_cf is not None:
            self._on_apply_cf(cf_val)
        self.destroy()

    def _ds(self, e): self._ox, self._oy = e.x, e.y
    def _dm(self, e):
        self.geometry(f"+{self.winfo_x()+e.x-self._ox}+{self.winfo_y()+e.y-self._oy}")


# ── Main clock ──────────────────────────────────────────────────────────────
class FluentClock:

    def __init__(self):
        self.root = tk.Tk()
        self.root.title("Clock")
        self.root.attributes("-topmost", True)
        self.root.overrideredirect(True)
        self.root.configure(bg=C["bg"])

        self._alpha      = WIN_ALPHA
        self._use_ntp    = False
        self._ntp_server = DEFAULT_NTP_HOST
        self._ntp_offset = None
        self._ntp_status = ""
        self._ntp_lock   = threading.Lock()
        self._tick       = 0

        # 公告
        self._notices        = []
        self._notice_idx     = 0
        self._notice_tick    = 0
        self._notice_lock    = threading.Lock()

        # CF Worker 时间源
        self._use_cf     = False
        self._cf_url     = CF_WORKER_URL
        self._cf_offset  = None       # 秒偏差
        self._cf_status  = ""
        self._cf_rtt     = None       # ms
        self._cf_lock    = threading.Lock()

        W, H = WIN_WIDTH, WIN_HEIGHT
        sw = self.root.winfo_screenwidth()
        self.root.geometry(f"{W}x{H}+{sw - W - WIN_MARGIN_RIGHT}+{WIN_MARGIN_TOP}")
        self.root.attributes("-alpha", 0)   # start invisible → fade in

        self._W, self._H = W, H

        # ── 全屏模式状态 ──
        self._fullscreen      = False
        self._fs_win          = None   # 全屏 Toplevel
        self._fs_cursor_timer = None   # 自动隐藏光标计时器
        self._fs_mouse_moved  = False

        self._build()
        self._fade_in()
        self._update()
        if CF_WORKER_URL:
            self._cf_url = CF_WORKER_URL
            self.root.after(2000, self._start_notice_fetch)

    # ── Build ───────────────────────────────────────────────────────────────
    def _build(self):
        W, H = self._W, self._H

        # ── outer thin-border frame ──
        border_frame = tk.Frame(self.root, bg=C["border"], bd=0)
        border_frame.place(x=0, y=0, width=W, height=H)

        inner = tk.Frame(border_frame, bg=C["surface"], bd=0)
        inner.place(x=1, y=1, width=W-2, height=H-2)

        # ── Accent strip (left edge) ──
        accent_strip = tk.Frame(inner, bg=C["accent"], width=3)
        accent_strip.pack(side="left", fill="y")
        self._accent_strip = accent_strip

        main = tk.Frame(inner, bg=C["surface"])
        main.pack(side="left", fill="both", expand=True)

        # ── Top area: indicator dot + time ──
        top = tk.Frame(main, bg=C["surface"])
        top.pack(fill="x", padx=14, pady=(12, 0))

        # Status dot
        self._dot_c = tk.Canvas(top, width=8, height=8, bg=C["surface"],
                                highlightthickness=0)
        self._dot_c.pack(side="left", pady=2)
        self._set_dot(C["ok"])

        # "NTP" badge label
        self._badge = tk.Label(top, text="  NTP", font=(_SF, 7, "bold"),
                               fg=C["accent_lit"], bg=C["surface"])
        # hidden until NTP is on

        # ── Big time display（拆分为独立 label，冒号单独控色）──
        time_frame = tk.Frame(main, bg=C["surface"])
        time_frame.pack(fill="x", padx=14)

        lbl_cfg = dict(font=(_SFL, FONT_SIZE_CLOCK), bg=C["surface"], anchor="w")
        self._lbl_hh  = tk.Label(time_frame, text="--", fg=C["text_hi"],  **lbl_cfg)
        self._lbl_c1  = tk.Label(time_frame, text=":", fg=C["text_hi"],   **lbl_cfg)
        self._lbl_mm  = tk.Label(time_frame, text="--", fg=C["text_hi"],  **lbl_cfg)
        self._lbl_c2  = tk.Label(time_frame, text=":", fg=C["text_hi"],   **lbl_cfg)
        self._lbl_ss  = tk.Label(time_frame, text="--", fg=C["text_mid"], **lbl_cfg)
        for w in (self._lbl_hh, self._lbl_c1, self._lbl_mm,
                  self._lbl_c2, self._lbl_ss):
            w.pack(side="left")

        # 冒号动画状态（0.0 → 1.0 → 0.0，周期 1 秒，60fps）
        self._colon_phase = 0.0
        self._animate_colon()

        # ── Date row ──
        date_row = tk.Frame(main, bg=C["surface"])
        date_row.pack(fill="x", padx=14)

        self._date_var = tk.StringVar(value="")
        tk.Label(date_row, textvariable=self._date_var,
                 font=(_SF, FONT_SIZE_DATE), fg=C["text_mid"],
                 bg=C["surface"], anchor="w").pack(side="left")

        self._chip_var = tk.StringVar(value="")
        tk.Label(date_row, textvariable=self._chip_var,
                 font=(_SF, 8), fg=C["text_lo"],
                 bg=C["surface"], anchor="e").pack(side="right")

        # ── Notice bar ──
        self._notice_bar = tk.Frame(main, bg=C["surface2"])
        # 先不 pack，有公告时再显示

        self._notice_lvl_bar = tk.Frame(self._notice_bar, bg=C["accent"], width=3)
        self._notice_lvl_bar.pack(side="left", fill="y")

        self._notice_var = tk.StringVar(value="")
        self._notice_lbl = tk.Label(
            self._notice_bar, textvariable=self._notice_var,
            font=(_SF, 8), fg=C["text_mid"], bg=C["surface2"],
            anchor="w", wraplength=W - 60, justify="left",
            padx=6, pady=3
        )
        self._notice_lbl.pack(side="left", fill="x", expand=True)

        # ── Divider ──
        div = tk.Frame(main, bg=C["border_dim"], height=1)
        div.pack(fill="x", padx=10, pady=(4, 0))

        # ── Toolbar ──
        # 按钮尺寸随窗口宽度等比缩放：
        #   可用宽度 = WIN_WIDTH - accent条(3) - 左右内边距(20) - 左右bar内边距(20)
        #   固定按钮(◂ ▸ ⚙ ✕) 各占 _bsz，NTP/CF 按钮各分得剩余空间的一半
        _avail  = W - 3 - 40                             # 可用像素（减去 accent 条和内边距）
        _bh     = max(18, int(W * 22 / 318))             # 按钮高度
        _bsz    = max(20, int(_avail * 26 / 275))        # 小方按钮宽度（◂ ▸ ⚙ ✕）
        _gap    = max(2,  int(_avail * 8  / 275))        # 间距
        # NTP + CF 按钮平分剩余，极窄时 clamp 到 80px 避免负值
        _remain = max(80, _avail - _bsz * 4 - _gap * 5)
        _nbw    = _remain // 2                           # NTP 按钮宽度
        _cbw    = _remain - _nbw                         # CF  按钮宽度

        bar = tk.Frame(main, bg=C["surface"])
        bar.pack(fill="x", padx=10, pady=5)

        PillButton(bar, "◂", btn_w=_bsz, btn_h=_bh, command=self._dec_alpha).pack(side="left", padx=(0,2))
        PillButton(bar, "▸", btn_w=_bsz, btn_h=_bh, command=self._inc_alpha).pack(side="left")

        self._ntp_btn = PillButton(bar, "NTP OFF", btn_w=_nbw, btn_h=_bh,
                                   command=self._toggle_ntp)
        self._ntp_btn.pack(side="left", padx=(_gap, 0))

        self._cf_btn = PillButton(bar, "CF OFF", btn_w=_cbw, btn_h=_bh,
                                  command=self._toggle_cf)
        self._cf_btn.pack(side="left", padx=(max(2,_gap//2), 0))

        PillButton(bar, "⚙", btn_w=_bsz, btn_h=_bh,
                   command=self._open_settings).pack(side="left", padx=(max(2,_gap//2), 0))

        PillButton(bar, "✕", btn_w=_bsz, btn_h=_bh,
                   fill=C["err"], fill_h=C["err_hi"], fill_p=C["err"],
                   command=self.root.quit).pack(side="right")

        # ── Drag ──
        for w in (inner, main, top, time_frame,
                  self._lbl_hh, self._lbl_c1, self._lbl_mm,
                  self._lbl_c2, self._lbl_ss, date_row, bar):
            w.bind("<Button-1>",  self._ds)
            w.bind("<B1-Motion>", self._dm)

        # 双击时间区 → 全屏
        for w in (self._lbl_hh, self._lbl_c1, self._lbl_mm,
                  self._lbl_c2, self._lbl_ss, time_frame):
            w.bind("<Double-Button-1>", lambda e: self._enter_fullscreen())

    # ── Clock update loop ────────────────────────────────────────────────────
    def _update(self):
        self._tick += 1
        now = self._now()

        hh, mm, ss = now.strftime("%H"), now.strftime("%M"), now.strftime("%S")
        self._lbl_hh.config(text=hh)
        self._lbl_mm.config(text=mm)
        self._lbl_ss.config(text=ss)

        date_str = now.strftime("%Y年%m月%d日  %A")
        for en, zh in (("Monday","星期一"),("Tuesday","星期二"),
                       ("Wednesday","星期三"),("Thursday","星期四"),
                       ("Friday","星期五"),("Saturday","星期六"),
                       ("Sunday","星期日")):
            date_str = date_str.replace(en, zh)
        self._date_var.set(date_str)

        if self._use_cf:
            with self._cf_lock:
                self._chip_var.set(self._cf_status)
        elif self._use_ntp:
            with self._ntp_lock:
                self._chip_var.set(self._ntp_status)
        else:
            self._chip_var.set("本地时间")

        if self._fullscreen:
            self._fs_update()
        # 公告轮播
        self._rotate_notice()

        self.root.after(1000, self._update)

    # ── 公告 ─────────────────────────────────────────────────────────────────
    def _rotate_notice(self):
        """每秒调用，负责公告轮播。"""
        with self._notice_lock:
            notices = list(self._notices)
        if not notices:
            if self._notice_bar.winfo_ismapped():
                self._notice_bar.pack_forget()
            return
        if not self._notice_bar.winfo_ismapped():
            # 插在 divider 前
            self._notice_bar.pack(fill="x", padx=10, pady=(4, 0))
        self._notice_tick += 1
        if self._notice_tick >= NOTICE_DURATION:
            self._notice_tick = 0
            self._notice_idx  = (self._notice_idx + 1) % len(notices)
        n = notices[self._notice_idx % len(notices)]
        self._notice_var.set(n.get("content", ""))
        lvl_color = {"info": C["accent"], "warn": C["warn"], "error": C["err"]}.get(
            n.get("level", "info"), C["accent"])
        self._notice_lvl_bar.config(bg=lvl_color)
        self._notice_lbl.config(
            fg=C["text_hi"] if n.get("level") == "error" else C["text_mid"])

    def _fetch_notices(self):
        """后台线程：从 CF Worker 拉取公告列表。"""
        if not self._cf_url:
            return
        try:
            req = urllib.request.Request(
                self._cf_url.rstrip("/") + "/api/notice",
                headers={"User-Agent": "ShowTimeOnTop/1.0"}
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode())
            notices = data.get("notices", [])
            with self._notice_lock:
                self._notices     = notices
                self._notice_idx  = 0
                self._notice_tick = 0
        except Exception:
            pass   # 拉取失败静默保留上次内容
        # 下次定时
        self.root.after(NOTICE_INTERVAL * 1000, self._start_notice_fetch)

    def _start_notice_fetch(self):
        if self._cf_url:
            threading.Thread(target=self._fetch_notices, daemon=True).start()

    def _now(self):
        # 优先级：CF Worker > NTP > 本地
        if self._use_cf:
            with self._cf_lock:
                off = self._cf_offset
            if off is not None:
                return datetime.now() + timedelta(seconds=off)
        if self._use_ntp:
            with self._ntp_lock:
                off = self._ntp_offset
            if off is not None:
                return datetime.now() + timedelta(seconds=off)
        return datetime.now()

    # ── NTP ──────────────────────────────────────────────────────────────────
    def _toggle_ntp(self):
        self._use_ntp = not self._use_ntp
        if self._use_ntp:
            self._ntp_btn.update_text("NTP ON ")
            self._ntp_btn.update_fill(C["accent"], C["accent_lit"])
            self._accent_strip.config(bg=C["accent_lit"])
            self._set_dot(C["accent_lit"])
            self._badge.pack(side="left", padx=(6, 0))
            with self._ntp_lock:
                self._ntp_offset = None
                self._ntp_status = "⟳ syncing…"
            self._kick_sync()
        else:
            self._ntp_btn.update_text("NTP OFF")
            self._ntp_btn.update_fill(C["surface2"], C["surface3"])
            self._accent_strip.config(bg=C["accent"])
            self._set_dot(C["ok"])
            self._badge.pack_forget()
            with self._ntp_lock:
                self._ntp_offset = None
                self._ntp_status = ""

    def _toggle_cf(self):
        self._use_cf = not self._use_cf
        if self._use_cf:
            if not self._cf_url:
                # 没有配置 URL，弹出提示
                self._use_cf = False
                self._cf_btn.update_text("CF OFF")
                self._cf_btn.update_fill(C["surface2"], C["surface3"])
                self._open_settings(tab="cf")
                return
            self._cf_btn.update_text("CF ON")
            self._cf_btn.update_fill(C["warn"], "#f99a4a")
            self._accent_strip.config(bg=C["warn"])
            self._set_dot(C["warn"])
            with self._cf_lock:
                self._cf_offset = None
                self._cf_status = "⟳ connecting…"
            self._kick_cf()
            self._start_notice_fetch()
        else:
            self._cf_btn.update_text("CF OFF")
            self._cf_btn.update_fill(C["surface2"], C["surface3"])
            # 恢复 accent strip 颜色
            if self._use_ntp:
                self._accent_strip.config(bg=C["accent_lit"])
                self._set_dot(C["accent_lit"])
            else:
                self._accent_strip.config(bg=C["accent"])
                self._set_dot(C["ok"])
            with self._cf_lock:
                self._cf_offset = None
                self._cf_status = ""

    def _kick_cf(self):
        if not self._use_cf:
            return
        threading.Thread(target=self._do_cf_sync, daemon=True).start()

    def _do_cf_sync(self):
        result = query_cf_worker(self._cf_url)
        if result is None:
            with self._cf_lock:
                self._cf_status = "✗ CF 无法连接"
            self.root.after(0, lambda: self._set_dot(C["err"]))
            # 30 秒后重试
            if self._use_cf:
                self.root.after(30_000, self._kick_cf)
            return
        offset, rtt_ms, colo = result
        with self._cf_lock:
            self._cf_offset = offset
            self._cf_rtt    = rtt_ms
            self._cf_status = f"✓ CF-{colo}  RTT {rtt_ms:.0f}ms"
        self.root.after(0, lambda: self._set_dot(C["ok"]))
        # 每 30 秒重新同步
        if self._use_cf:
            self.root.after(30_000, self._kick_cf)

    def _kick_sync(self):
        if not self._use_ntp:
            return
        threading.Thread(target=self._do_sync, daemon=True).start()

    def _do_sync(self):
        t0  = time.time()
        utc = query_ntp(self._ntp_server)
        t1  = time.time()
        if utc is None:
            with self._ntp_lock:
                self._ntp_status = "✗ 无法连接"
            self.root.after(0, lambda: self._set_dot(C["err"]))
            return
        mid    = (t0 + t1) / 2
        offset = utc.timestamp() - mid + (datetime.now().timestamp() - time.time())
        with self._ntp_lock:
            self._ntp_offset = offset
            self._ntp_status = f"✓ {self._ntp_server}"
        self.root.after(0, lambda: self._set_dot(C["ok"]))
        if self._use_ntp:
            self.root.after(60_000, self._kick_sync)

    def _open_settings(self, tab=None):
        def apply_ntp(srv):
            self._ntp_server = srv
            if self._use_ntp:
                with self._ntp_lock:
                    self._ntp_offset = None
                    self._ntp_status = "⟳ syncing…"
                self._kick_sync()
        def apply_cf(url):
            self._cf_url = url
            if self._use_cf:
                with self._cf_lock:
                    self._cf_offset = None
                    self._cf_status = "⟳ connecting…"
                self._kick_cf()
        NTPPopup(self.root, self._ntp_server, apply_ntp,
                 self._cf_url, apply_cf)

    # ── Opacity ──────────────────────────────────────────────────────────────
    def _inc_alpha(self):
        self._alpha = min(1.0, round(self._alpha + 0.1, 1))
        self.root.attributes("-alpha", self._alpha)

    def _dec_alpha(self):
        self._alpha = max(0.2, round(self._alpha - 0.1, 1))
        self.root.attributes("-alpha", self._alpha)

    # ── Drag ─────────────────────────────────────────────────────────────────
    def _ds(self, e): self._ox, self._oy = e.x, e.y
    def _dm(self, e):
        self.root.geometry(
            f"+{self.root.winfo_x()+e.x-self._ox}+{self.root.winfo_y()+e.y-self._oy}")

    # ── Helpers ──────────────────────────────────────────────────────────────
    def _animate_colon(self):
        """
        冒号平滑闪动：每 16ms 更新一帧（约 60fps）。
        亮度曲线 = sin²(π·phase)，phase 在 [0,1] 间线性推进，1 秒一个完整周期。
        亮：#ffffff  暗：#2a2d50（与背景接近，给人"消隐"感）
        """
        BRIGHT = (255, 255, 255)
        DIM    = (42,  45,  80)
        STEP   = 16 / 1000.0   # 16ms → 秒

        self._colon_phase = (self._colon_phase + STEP) % 1.0
        t = math.sin(math.pi * self._colon_phase) ** 2   # 0→1→0，平滑

        r = int(DIM[0] + (BRIGHT[0] - DIM[0]) * t)
        g = int(DIM[1] + (BRIGHT[1] - DIM[1]) * t)
        b = int(DIM[2] + (BRIGHT[2] - DIM[2]) * t)
        color = f"#{r:02x}{g:02x}{b:02x}"

        self._lbl_c1.config(fg=color)
        self._lbl_c2.config(fg=color)
        self.root.after(16, self._animate_colon)

    def _set_dot(self, color):
        self._dot_c.delete("all")
        self._dot_c.create_oval(1, 1, 7, 7, fill=color, outline="")

    # ── 全屏模式 ─────────────────────────────────────────────────────────────
    def _enter_fullscreen(self):
        if self._fullscreen:
            return
        self._fullscreen = True

        sw = self.root.winfo_screenwidth()
        sh = self.root.winfo_screenheight()

        fs = tk.Toplevel(self.root)
        self._fs_win = fs
        fs.attributes("-topmost", True)
        fs.overrideredirect(True)
        fs.configure(bg=C["bg"])
        fs.geometry(f"{sw}x{sh}+0+0")
        fs.attributes("-alpha", 0)

        # ── 全屏背景 canvas（用于绘制极光晕圈）──
        bg_canvas = tk.Canvas(fs, bg=C["bg"], highlightthickness=0)
        bg_canvas.place(x=0, y=0, width=sw, height=sh)
        self._fs_canvas = bg_canvas
        self._fs_sw, self._fs_sh = sw, sh
        self._fs_phase = 0.0
        self._draw_fs_bg()

        # ── 中央内容框 ──
        center = tk.Frame(fs, bg=C["bg"])
        center.place(relx=.5, rely=.5, anchor="center")

        # 时间（字号 = 屏幕宽度 / 9，约全屏效果）
        fs_clock_size = max(48, sw // 9)
        time_row = tk.Frame(center, bg=C["bg"])
        time_row.pack()

        lbl_kw = dict(font=(_SFL, fs_clock_size), bg=C["bg"], fg=C["text_hi"])
        self._fs_hh = tk.Label(time_row, text="--", **lbl_kw)
        self._fs_c1 = tk.Label(time_row, text=":", **lbl_kw)
        self._fs_mm = tk.Label(time_row, text="--", **lbl_kw)
        self._fs_c2 = tk.Label(time_row, text=":", **lbl_kw)
        self._fs_ss = tk.Label(time_row, text="--",
                               font=(_SFL, fs_clock_size),
                               bg=C["bg"], fg=C["text_mid"])
        for w in (self._fs_hh, self._fs_c1, self._fs_mm, self._fs_c2, self._fs_ss):
            w.pack(side="left")

        # 日期
        date_size = max(14, sw // 60)
        self._fs_date = tk.Label(center, text="", font=(_SF, date_size),
                                 bg=C["bg"], fg=C["text_mid"])
        self._fs_date.pack(pady=(10, 0))

        # 时间源状态
        self._fs_src = tk.Label(center, text="", font=(_SF, max(10, sw // 100)),
                                bg=C["bg"], fg=C["text_lo"])
        self._fs_src.pack(pady=(6, 0))

        # 提示文字
        hint_size = max(9, sw // 130)
        tk.Label(center, text="双击或按 Esc 退出全屏",
                 font=(_SF, hint_size), bg=C["bg"],
                 fg=C["text_lo"]).pack(pady=(30, 0))

        # ── 事件绑定 ──
        fs.bind("<Escape>",           lambda e: self._exit_fullscreen())
        fs.bind("<Double-Button-1>",  lambda e: self._exit_fullscreen())
        fs.bind("<Motion>",           self._fs_mouse_move)
        for w in (self._fs_hh, self._fs_c1, self._fs_mm,
                  self._fs_c2, self._fs_ss, self._fs_date,
                  self._fs_src, center, time_row, bg_canvas):
            w.bind("<Double-Button-1>", lambda e: self._exit_fullscreen())
            w.bind("<Motion>",          self._fs_mouse_move)

        # 淡入
        self._fs_fade_in(fs, step=0)
        # 冒号动画（复用同一 phase）
        self._fs_colon_phase = 0.0
        self._fs_animate_colon()
        # 光标隐藏计时
        self._fs_reset_cursor_timer(fs)

    def _draw_fs_bg(self):
        """全屏背景：缓慢流动的径向极光晕（纯 tkinter canvas）。"""
        if not self._fullscreen or self._fs_win is None:
            return
        c = self._fs_canvas
        sw, sh = self._fs_sw, self._fs_sh
        c.delete("glow")

        self._fs_phase = (self._fs_phase + 0.003) % 1.0
        t = math.sin(math.pi * 2 * self._fs_phase)

        # 主晕：蓝紫色，中心偏上
        cx  = sw // 2 + int(sw * 0.06 * t)
        cy  = int(sh * 0.42)
        rx  = int(sw * 0.38)
        ry  = int(sh * 0.32)
        # 用多个半透明椭圆叠加模拟渐变晕
        layers = [
            (1.0, "#0d1a3a"), (0.75, "#0f2050"), (0.5, "#102860"),
            (0.3, "#0e3080"), (0.15, "#0a48a0"),
        ]
        for scale, color in layers:
            x0 = cx - int(rx * scale)
            y0 = cy - int(ry * scale)
            x1 = cx + int(rx * scale)
            y1 = cy + int(ry * scale)
            c.create_oval(x0, y0, x1, y1, fill=color, outline="", tags="glow")

        # 副晕：冷青色，右侧
        t2  = math.sin(math.pi * 2 * (self._fs_phase + 0.3))
        cx2 = int(sw * 0.72) + int(sw * 0.04 * t2)
        cy2 = int(sh * 0.58)
        rx2, ry2 = int(sw * 0.22), int(sh * 0.18)
        for scale, color in [(1.0, "#091828"), (0.55, "#0a2535"), (0.25, "#083a50")]:
            c.create_oval(cx2 - int(rx2*scale), cy2 - int(ry2*scale),
                          cx2 + int(rx2*scale), cy2 + int(ry2*scale),
                          fill=color, outline="", tags="glow")

        self._fs_canvas.after(50, self._draw_fs_bg)   # 20fps 足够流畅

    def _fs_animate_colon(self):
        """全屏冒号动画（和主窗口同算法，独立 phase）。"""
        if not self._fullscreen:
            return
        BRIGHT = (255, 255, 255)
        DIM    = (30, 32, 60)
        self._fs_colon_phase = (self._fs_colon_phase + 16/1000) % 1.0
        t = math.sin(math.pi * self._fs_colon_phase) ** 2
        r = int(DIM[0] + (BRIGHT[0]-DIM[0]) * t)
        g = int(DIM[1] + (BRIGHT[1]-DIM[1]) * t)
        b = int(DIM[2] + (BRIGHT[2]-DIM[2]) * t)
        col = f"#{r:02x}{g:02x}{b:02x}"
        try:
            self._fs_c1.config(fg=col)
            self._fs_c2.config(fg=col)
        except Exception:
            return
        self._fs_win.after(16, self._fs_animate_colon)

    def _fs_update(self):
        """全屏时间刷新，由主 _update 每秒调用。"""
        if not self._fullscreen or self._fs_win is None:
            return
        now = self._now()
        try:
            self._fs_hh.config(text=now.strftime("%H"))
            self._fs_mm.config(text=now.strftime("%M"))
            self._fs_ss.config(text=now.strftime("%S"))

            date_str = now.strftime("%Y年%m月%d日  %A")
            for en, zh in (("Monday","星期一"),("Tuesday","星期二"),
                           ("Wednesday","星期三"),("Thursday","星期四"),
                           ("Friday","星期五"),("Saturday","星期六"),
                           ("Sunday","星期日")):
                date_str = date_str.replace(en, zh)
            self._fs_date.config(text=date_str)

            if self._use_cf:
                with self._cf_lock:
                    src = self._cf_status
            elif self._use_ntp:
                with self._ntp_lock:
                    src = self._ntp_status
            else:
                src = "本地时间"
            self._fs_src.config(text=src)
        except Exception:
            pass

    def _exit_fullscreen(self):
        if not self._fullscreen:
            return
        self._fullscreen = False
        if self._fs_cursor_timer:
            try: self._fs_win.after_cancel(self._fs_cursor_timer)
            except: pass
            self._fs_cursor_timer = None
        if self._fs_win:
            try: self._fs_win.destroy()
            except: pass
            self._fs_win = None

    def _fs_fade_in(self, fs, step=0, total=20):
        if step <= total:
            try:
                fs.attributes("-alpha", self._alpha * step / total)
                fs.after(14, lambda: self._fs_fade_in(fs, step+1, total))
            except Exception:
                pass
        else:
            try: fs.attributes("-alpha", self._alpha)
            except: pass

    def _fs_mouse_move(self, e):
        """鼠标移动时恢复光标，并重置隐藏计时器。"""
        if not self._fullscreen or self._fs_win is None:
            return
        try:
            self._fs_win.config(cursor="")
        except: pass
        self._fs_reset_cursor_timer(self._fs_win)

    def _fs_reset_cursor_timer(self, fs):
        if self._fs_cursor_timer:
            try: fs.after_cancel(self._fs_cursor_timer)
            except: pass
        self._fs_cursor_timer = fs.after(3000, self._fs_hide_cursor)

    def _fs_hide_cursor(self):
        """3 秒无鼠标移动后隐藏光标。"""
        if self._fullscreen and self._fs_win:
            try: self._fs_win.config(cursor="none")
            except: pass

    def _fade_in(self, step=0, total=15):
        if step <= total:
            self.root.attributes("-alpha", self._alpha * step / total)
            self.root.after(18, lambda: self._fade_in(step + 1, total))
        else:
            self.root.attributes("-alpha", self._alpha)

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    clock = FluentClock()
    clock.run()
