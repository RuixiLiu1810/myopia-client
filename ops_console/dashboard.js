const OPS_AUTH_KEY = "myopia_ops_auth_v1";
const OPS_SETTINGS_KEY = "myopia_ops_settings_v1";

function getDefaultApiBase() {
  const path = window.location.pathname || "";
  if (path.startsWith("/ops")) {
    return "/api";
  }
  const protocol = window.location.protocol.startsWith("http") ? window.location.protocol : "http:";
  const hostname = window.location.hostname || "127.0.0.1";
  return `${protocol}//${hostname}:8000`;
}

const OPS_DEFAULT_SETTINGS = {
  api_base: getDefaultApiBase(),
};

let opsSettings = { ...OPS_DEFAULT_SETTINGS };

let authState = {
  access_token: "",
  username: "",
  role: "",
  expires_at: 0,
};

const state = {
  backendStatus: null,
  health: {},
  modelInfo: null,
  users: [],
  audits: [],
  tables: [],
  metricsSummary: null,
  alerts: [],
  actionJobs: [],
};
let actionJobsPollTimer = null;
let actionJobsPollInFlight = false;

function $(id) {
  return document.getElementById(id);
}

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function valueToText(value) {
  if (value === null || value === undefined || value === "") return "-";
  if (value === true) return "true";
  if (value === false) return "false";
  if (Array.isArray(value)) {
    if (!value.length) return "-";
    return value.map((item) => valueToText(item)).join(", ");
  }
  if (typeof value === "object") {
    const pairs = Object.entries(value).map(([k, v]) => k + ": " + valueToText(v));
    return pairs.length ? pairs.join("; ") : "-";
  }
  return String(value);
}

function normalizeApiBase(value) {
  let raw = String(value || "").trim();
  if (!raw) return "";
  const toPathPrefix = (v) => `/${String(v).replace(/^(?:\.\.\/|\.\/)+/, "").replace(/^\/+/, "").replace(/\/+$/, "")}`;

  raw = raw.replace(/^['"]+|['"]+$/g, "").trim();
  if (!raw) return "";

  if (/^https?:\/\//i.test(raw) || raw.startsWith("//")) {
    return raw.replace(/\/+$/, "");
  }

  if (raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../")) {
    return toPathPrefix(raw);
  }

  const isIpv6 = /^\[[0-9a-fA-F:.]+\](?::\d+)?(?:\/.*)?$/.test(raw);
  const isLocalhost = /^localhost(?::\d+)?(?:\/.*)?$/i.test(raw);
  const isIpv4 = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/.*)?$/.test(raw);
  const isDomain = /^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+(?::\d+)?(?:\/.*)?$/.test(raw);
  const isHostWithPort = /^[a-zA-Z0-9-]+(?::\d+)(?:\/.*)?$/.test(raw);
  const looksLikeHost = isIpv6 || isLocalhost || isIpv4 || isDomain || isHostWithPort;
  if (looksLikeHost) {
    return `${window.location.protocol}//${raw}`.replace(/\/+$/, "");
  }

  return toPathPrefix(raw);
}

function absoluteApiBase(base) {
  const normalized = normalizeApiBase(base);
  if (!normalized) {
    throw new Error("API Base URL 不能为空");
  }
  if (/^https?:\/\//i.test(normalized)) {
    return `${normalized.replace(/\/+$/, "")}/`;
  }
  if (normalized.startsWith("//")) {
    return `${window.location.protocol}${normalized.replace(/\/+$/, "")}/`;
  }
  return `${window.location.origin}${normalized.replace(/\/+$/, "")}/`;
}

function isSetupRequiredPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.setup && payload.setup.setup_required === true) return true;
  return String(payload.status || "").toLowerCase() === "setup_required";
}

function buildSetupUrlFromApiBase(apiBase) {
  try {
    const normalized = normalizeApiBase(apiBase || opsSettings.api_base || OPS_DEFAULT_SETTINGS.api_base);
    const absBase = absoluteApiBase(normalized);
    const url = new URL(absBase);
    let path = url.pathname.replace(/\/+$/, "");
    if (path.toLowerCase().endsWith("/api")) {
      path = path.slice(0, -4);
    }
    const root = url.origin + (path ? (path + "/") : "/");
    return new URL("setup", root).toString();
  } catch (_err) {
    return "/setup";
  }
}

function createSetupRequiredError(detail, apiBase) {
  const err = new Error(String(detail || "server setup required"));
  err.code = "SERVER_SETUP_REQUIRED";
  err.setup_url = buildSetupUrlFromApiBase(apiBase);
  return err;
}

function isSetupRequiredError(err) {
  return !!(err && err.code === "SERVER_SETUP_REQUIRED");
}

function loadOpsSettings() {
  try {
    const raw = localStorage.getItem(OPS_SETTINGS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    opsSettings = {
      api_base: normalizeApiBase(parsed.api_base || OPS_DEFAULT_SETTINGS.api_base),
    };
  } catch (_err) {}
}

function saveOpsSettings(next) {
  opsSettings = {
    api_base: normalizeApiBase(next.api_base || OPS_DEFAULT_SETTINGS.api_base),
  };
  localStorage.setItem(OPS_SETTINGS_KEY, JSON.stringify(opsSettings));
  renderLoginApiBaseHint();
}

function renderKeyValueRows(tbodyId, rows) {
  const body = $(tbodyId);
  if (!body) return;
  if (!Array.isArray(rows) || rows.length === 0) {
    body.innerHTML = `<tr><td colspan="2">暂无数据</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map((row) => {
      const key = esc(row[0]);
      const val = esc(valueToText(row[1]));
      return `<tr><td>${key}</td><td class="wrap">${val}</td></tr>`;
    })
    .join("");
}

/* ---- Toast messages ---- */
function showToast(msg, type) {
  const root = $("toast-root");
  if (!root) return;
  const toast = document.createElement("div");
  toast.className = "toast toast-" + (type === "ok" ? "success" : type === "err" ? "error" : "info");
  toast.textContent = String(msg || "");
  root.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

/* Also keep ops-msg bar for persistent status */
function setMsg(msg, type) {
  showToast(msg, type);
}

/* ---- Modal ---- */
function showModal(title, bodyHTML, footerHTML) {
  const root = $("modal-root");
  if (!root) return;
  root.innerHTML =
    `<div class="modal-overlay" id="modal-overlay">` +
      `<div class="modal">` +
        `<div class="modal-header">` +
          `<span class="modal-title">${esc(title)}</span>` +
          `<button class="modal-close" id="modal-close-btn" title="关闭">` +
            `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">` +
              `<line x1="1" y1="1" x2="13" y2="13"></line>` +
              `<line x1="13" y1="1" x2="1" y2="13"></line>` +
            `</svg>` +
          `</button>` +
        `</div>` +
        `<div class="modal-body">${bodyHTML || ""}</div>` +
        (footerHTML ? `<div class="modal-footer">${footerHTML}</div>` : "") +
      `</div>` +
    `</div>`;
  const closeBtn = $("modal-close-btn");
  if (closeBtn) closeBtn.addEventListener("click", closeModal);
  const overlay = $("modal-overlay");
  if (overlay) {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal();
    });
  }
}

function closeModal() {
  const root = $("modal-root");
  if (root) root.innerHTML = "";
}

function renderLoginApiBaseHint() {
  const hintEl = $("login-api-base-preview");
  if (!hintEl) return;
  hintEl.textContent = opsSettings.api_base || OPS_DEFAULT_SETTINGS.api_base;
}

async function testOpsApiBaseHealth(apiBase) {
  const url = buildApiUrl("healthz", {}, apiBase);
  const resp = await fetch(url, { method: "GET", cache: "no-store" });
  let data = {};
  try {
    data = await resp.json();
  } catch (_err) {}
  if (isSetupRequiredPayload(data)) {
    return { setup_required: true, setup_url: buildSetupUrlFromApiBase(apiBase) };
  }
  if (!resp.ok) {
    throw new Error("健康检查失败（HTTP " + resp.status + "）");
  }
  return { setup_required: false };
}

function openLoginConnectionSettingsModal() {
  const current = opsSettings.api_base || OPS_DEFAULT_SETTINGS.api_base;
  const bodyHTML =
    `<div class="form-field mb-12">` +
      `<label class="form-label">服务端 API Base URL <span style="color:var(--red-500)">*</span></label>` +
      `<input id="login-api-base-input" class="form-input" type="text" value="${esc(current)}" placeholder="/api 或 http://127.0.0.1:8000" />` +
      `<span class="form-hint">用于登录与 API 请求。可填写服务端 IP（如 <code>http://192.168.1.10:8000</code>）。</span>` +
    `</div>` +
    `<div id="login-api-base-test-msg" class="text-muted text-sm">点击“测试连接”验证后端可达性。</div>`;
  const footerHTML =
    `<button class="btn btn-outline" id="login-api-base-test-btn">测试连接</button>` +
    `<button class="btn btn-outline" id="login-api-base-cancel-btn">取消</button>` +
    `<button class="btn btn-primary" id="login-api-base-save-btn">保存</button>`;
  showModal("连接设置", bodyHTML, footerHTML);

  const testBtn = $("login-api-base-test-btn");
  const cancelBtn = $("login-api-base-cancel-btn");
  const saveBtn = $("login-api-base-save-btn");
  const msgEl = $("login-api-base-test-msg");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", closeModal);
  }
  if (testBtn) {
    testBtn.addEventListener("click", async () => {
      const input = $("login-api-base-input");
      const value = String(input ? input.value : "").trim();
      if (!msgEl) return;
      testBtn.disabled = true;
      testBtn.textContent = "测试中…";
      try {
        const result = await testOpsApiBaseHealth(value);
        if (result && result.setup_required) {
          msgEl.className = "badge badge-amber";
          msgEl.textContent = "服务端可达，但尚未完成首次安装：" + String(result.setup_url || "/setup");
        } else {
          msgEl.className = "badge badge-green";
          msgEl.textContent = "连接成功";
        }
      } catch (err) {
        msgEl.className = "error-msg";
        msgEl.textContent = "连接失败：" + String(err && err.message ? err.message : err);
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = "测试连接";
      }
    });
  }
  if (saveBtn) {
    saveBtn.addEventListener("click", () => {
      const input = $("login-api-base-input");
      const normalized = normalizeApiBase(String(input ? input.value : "").trim());
      if (!normalized) {
        if (msgEl) {
          msgEl.className = "error-msg";
          msgEl.textContent = "请输入有效的服务端 API 地址";
        }
        return;
      }
      saveOpsSettings({ api_base: normalized });
      closeModal();
      setMsg("连接地址已保存", "ok");
    });
  }
}

/* ---- Auth persistence ---- */
function loadAuth() {
  try {
    const raw = localStorage.getItem(OPS_AUTH_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    authState = {
      access_token: String(parsed.access_token || ""),
      username: String(parsed.username || ""),
      role: String(parsed.role || ""),
      expires_at: Number(parsed.expires_at || 0),
    };
  } catch (_err) {}
}

function saveAuth(next) {
  authState = {
    access_token: String(next.access_token || ""),
    username: String(next.username || ""),
    role: String(next.role || ""),
    expires_at: Number(next.expires_at || 0),
  };
  localStorage.setItem(OPS_AUTH_KEY, JSON.stringify(authState));
  renderAuthUI();
}

function clearAuth() {
  authState = { access_token: "", username: "", role: "", expires_at: 0 };
  localStorage.removeItem(OPS_AUTH_KEY);
  renderAuthUI();
}

function getToken() {
  const token = String(authState.access_token || "");
  const exp = Number(authState.expires_at || 0);
  if (!token) return "";
  if (exp > 0 && Date.now() > exp) {
    clearAuth();
    return "";
  }
  return token;
}

function renderAuthUI() {
  const nameEl = $("user-display-name");
  const roleBadge = $("user-role-badge");
  const avatarEl = $("user-avatar");
  if (!nameEl) return;
  const token = getToken();
  const name = token ? (authState.username || "用户") : "未登录";
  nameEl.textContent = name;
  if (avatarEl) {
    avatarEl.textContent = name ? name.charAt(0).toUpperCase() : "U";
  }
  if (roleBadge) {
    roleBadge.textContent = token ? (authState.role || "") : "";
    roleBadge.className = "role-badge" + (token && authState.role ? " role-" + authState.role.toLowerCase() : "");
  }
}

/* ---- API helpers ---- */
function buildApiUrl(path, query, overrideApiBase) {
  const cleanPath = String(path || "").replace(/^\/+/, "");
  const base = absoluteApiBase(
    normalizeApiBase(overrideApiBase || opsSettings.api_base || OPS_DEFAULT_SETTINGS.api_base)
  );
  const url = new URL(cleanPath, base);
  Object.entries(query || {}).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "") return;
    url.searchParams.set(k, String(v));
  });
  if (url.origin === window.location.origin) {
    return `${url.pathname}${url.search}`;
  }
  return url.toString();
}

async function apiFetch(path, options) {
  const opts = options || {};
  const reqMethod = String(opts.method || "GET").toUpperCase();
  const reqPath = String(path || "").replace(/^\/+/, "");
  const reqUrl = buildApiUrl(reqPath, opts.query);
  const reqUrlObj = new URL(reqUrl, window.location.origin);
  const endpointLabel = reqUrlObj.pathname + reqUrlObj.search;
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  const useAuth = opts.auth !== false;
  const token = useAuth ? getToken() : "";
  if (token) headers.Authorization = "Bearer " + token;

  const resp = await fetch(reqUrl, {
    method: reqMethod,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try {
    data = await resp.json();
  } catch (_err) {}

  if (!resp.ok) {
    const detail = data && data.detail ? data.detail : "请求失败 HTTP " + resp.status;
    if (resp.status === 503 && isSetupRequiredPayload(data)) {
      throw createSetupRequiredError(detail, opsSettings.api_base || OPS_DEFAULT_SETTINGS.api_base);
    }
    if (resp.status === 401) {
      clearAuth();
      showLoginScreen();
      setMsg("登录已失效，请重新登录", "err");
    }
    if (resp.status === 404) {
      throw new Error("接口不存在: " + endpointLabel + " (" + reqMethod + ")");
    }
    throw new Error(String(detail) + " (" + reqMethod + " " + endpointLabel + ")");
  }
  return data;
}

function parseDownloadFilename(contentDisposition, fallbackName) {
  const fallback = String(fallbackName || "export.csv");
  const raw = String(contentDisposition || "");
  if (!raw) return fallback;
  const utf8Match = raw.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match && utf8Match[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim());
    } catch (_err) {
      return utf8Match[1].trim();
    }
  }
  const quotedMatch = raw.match(/filename=\"([^\"]+)\"/i);
  if (quotedMatch && quotedMatch[1]) return quotedMatch[1].trim();
  const plainMatch = raw.match(/filename=([^;]+)/i);
  if (plainMatch && plainMatch[1]) return plainMatch[1].trim();
  return fallback;
}

async function apiDownload(path, options) {
  const opts = options || {};
  const reqMethod = String(opts.method || "GET").toUpperCase();
  const reqPath = String(path || "").replace(/^\/+/, "");
  const reqUrl = buildApiUrl(reqPath, opts.query);
  const reqUrlObj = new URL(reqUrl, window.location.origin);
  const endpointLabel = reqUrlObj.pathname + reqUrlObj.search;
  const headers = { ...(opts.headers || {}) };
  const useAuth = opts.auth !== false;
  const token = useAuth ? getToken() : "";
  if (token) headers.Authorization = "Bearer " + token;

  const resp = await fetch(reqUrl, {
    method: reqMethod,
    headers,
  });

  if (!resp.ok) {
    let detail = "请求失败 HTTP " + resp.status;
    let data = null;
    try {
      data = await resp.json();
      if (data && data.detail) detail = String(data.detail);
    } catch (_err) {}
    if (resp.status === 503 && isSetupRequiredPayload(data)) {
      throw createSetupRequiredError(detail, opsSettings.api_base || OPS_DEFAULT_SETTINGS.api_base);
    }
    if (resp.status === 401) {
      clearAuth();
      showLoginScreen();
      setMsg("登录已失效，请重新登录", "err");
    }
    if (resp.status === 404) {
      throw new Error("接口不存在: " + endpointLabel + " (" + reqMethod + ")");
    }
    throw new Error(detail + " (" + reqMethod + " " + endpointLabel + ")");
  }

  const blob = await resp.blob();
  const filename = parseDownloadFilename(
    resp.headers.get("Content-Disposition"),
    String(opts.filename || "export.csv")
  );
  const link = document.createElement("a");
  const href = URL.createObjectURL(blob);
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(href), 1500);
  return { filename, size: blob.size };
}

async function launcherFetch(path, options) {
  const opts = options || {};
  const resp = await fetch(path, {
    method: opts.method || "GET",
    headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try {
    data = await resp.json();
  } catch (_err) {}
  if (!resp.ok) {
    const message = data.message || data.detail || "请求失败 HTTP " + resp.status;
    throw new Error(String(message));
  }
  return data;
}

/* ---- Screen transitions ---- */
function showLoginScreen() {
  $("login-screen").classList.remove("hidden");
  $("app-shell").classList.add("hidden");
}

function showAppShell() {
  $("login-screen").classList.add("hidden");
  $("app-shell").classList.remove("hidden");
}

/* ---- Navigation ---- */
function getCurrentViewId() {
  const active = document.querySelector(".ops-view.active");
  return active ? String(active.id || "") : "";
}

function switchView(viewId) {
  const target = String(viewId || "overview-view");
  document.querySelectorAll(".ops-view").forEach((view) => {
    view.classList.toggle("active", view.id === target);
  });
  document.querySelectorAll(".nav-item[data-view]").forEach((item) => {
    item.classList.toggle("active", item.getAttribute("data-view") === target);
  });
  if (target !== "actions-view") {
    stopActionJobsAutoPoll();
  }
  if (target === "actions-view" && getToken()) {
    loadActionJobs().catch((err) => {
      setMsg("加载动作任务失败：" + String(err.message || err), "err");
    });
  }
}

/* ---- Backend status ---- */
function renderBackendPill() {
  const pill = $("backend-pill");
  const textEl = $("backend-text");
  if (!pill) return;
  const s = state.backendStatus;
  if (!s) {
    pill.className = "status-badge status-error";
    if (textEl) textEl.textContent = "后端不可达";
    return;
  }
  if (s.ready) {
    pill.className = "status-badge status-ok";
    if (textEl) textEl.textContent = "后端可达";
  } else {
    pill.className = "status-badge status-error";
    if (textEl) textEl.textContent = "后端不可达";
  }
}

/* ---- Render functions ---- */
function renderOverviewKpi() {
  const s = state.backendStatus || {};
  const summary = state.metricsSummary || {};
  const pred = summary.prediction || {};
  const summaryUsers = summary.users || {};
  const userTotal =
    state.users.length > 0 ? state.users.length : Number(summaryUsers.total || 0);
  const userActive =
    state.users.length > 0
      ? state.users.filter((u) => Boolean(u.is_active)).length
      : Number(summaryUsers.active || 0);
  const predTotal = Number(pred.total_runs || 0);
  const predFailed = Number(pred.failed_runs || 0);
  const predSuccessRate =
    pred.success_rate_pct == null || Number.isNaN(Number(pred.success_rate_pct))
      ? "—"
      : Number(pred.success_rate_pct).toFixed(2) + "%";
  const avgLatency =
    pred.avg_latency_ms == null || Number.isNaN(Number(pred.avg_latency_ms))
      ? "—"
      : Number(pred.avg_latency_ms).toFixed(2) + " ms";

  const setKpi = (id, val) => { const el = $(id); if (el) el.textContent = val; };
  setKpi("kpi-backend", s.ready ? "可达" : "不可达");
  setKpi("kpi-process", s.process_control ? "可控" : "托管");
  setKpi("kpi-users", String(userTotal));
  setKpi("kpi-users-active", String(userActive));
  setKpi("kpi-pred-total", String(predTotal));
  setKpi("kpi-pred-success-rate", predSuccessRate);
  setKpi("kpi-pred-failed", String(predFailed));
  setKpi("kpi-pred-latency", avgLatency);
}

function buildModelFamilyCoverageText() {
  const info = state.modelInfo || {};
  const familyGroups = info.family_groups || {};
  const keys = Object.keys(familyGroups);
  if (!keys.length) return "-";
  const order = { xu: 0, fen: 1, feng: 2 };
  keys.sort((a, b) => {
    const va = order[a] != null ? order[a] : 99;
    const vb = order[b] != null ? order[b] : 99;
    return va - vb;
  });
  return keys
    .map((family) => {
      const seqMap = familyGroups[family] || {};
      const seqLens = Object.keys(seqMap)
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v))
        .sort((a, b) => a - b);
      const horizonSet = new Set();
      Object.values(seqMap).forEach((rows) => {
        (Array.isArray(rows) ? rows : []).forEach((row) => {
          const h = Number(row && row.horizon);
          if (Number.isFinite(h)) horizonSet.add(h);
        });
      });
      const horizons = Array.from(horizonSet).sort((a, b) => a - b);
      const labelMap = { xu: "Xu", fen: "Fen", feng: "FenG" };
      const seqText = seqLens.length ? seqLens.join(",") : "-";
      const horizonText = horizons.length ? horizons.join(",") : "-";
      return `${labelMap[family] || family}: seq[${seqText}] h[${horizonText}]`;
    })
    .join(" | ");
}

function renderHealth(payload) {
  const p = payload || {};
  renderKeyValueRows("health-body", [
    ["服务状态", p.status],
    ["当前账号", p.actor],
    ["角色", p.role],
    ["模型目录", p.model_dir],
    ["模型数量", p.model_count],
    ["存储后端", p.storage_backend],
    ["本地存储目录", p.local_storage_dir],
    ["数据库连接", p.database && p.database.connected],
    ["数据库地址", p.database && p.database.url],
    ["模型家族覆盖", buildModelFamilyCoverageText()],
  ]);
}

function renderOverviewAlerts(rows) {
  const body = $("overview-alerts-body");
  if (!body) return;
  const items = Array.isArray(rows) ? rows : [];
  if (!items.length) {
    body.innerHTML = `<tr><td colspan="5" class="text-muted">当前无告警</td></tr>`;
    return;
  }
  const levelToBadge = (level) => {
    const key = String(level || "info").toLowerCase();
    if (key === "high") return "badge-red";
    if (key === "medium") return "badge-amber";
    if (key === "low") return "badge-blue";
    return "badge-gray";
  };
  body.innerHTML = items
    .map((it) => {
      const level = String(it.level || "info").toLowerCase();
      return (
        `<tr>` +
        `<td><span class="badge ${levelToBadge(level)}">${esc(level)}</span></td>` +
        `<td>${esc(it.title || "-")}</td>` +
        `<td class="wrap">${esc(it.detail || "-")}</td>` +
        `<td class="wrap">${esc(it.suggestion || "-")}</td>` +
        `<td>${esc(it.created_at || "-")}</td>` +
        `</tr>`
      );
    })
    .join("");
}

function userActionsCell(user) {
  const uid = Number(user.id);
  const displayName = esc(user.display_name || "");
  const role = esc(user.role || "operator");
  const username = esc(user.username || ("user-" + uid));
  const activeBtn = user.is_active
    ? `<button class="btn btn-sm btn-outline" data-action="deactivate" data-id="${uid}" data-username="${username}">停用</button>`
    : `<button class="btn btn-sm btn-outline" data-action="activate" data-id="${uid}" data-username="${username}">启用</button>`;
  return (
    `<div style="display:flex;gap:4px;flex-wrap:wrap">` +
    `<button class="btn btn-sm btn-outline" data-action="rename" data-id="${uid}" data-name="${displayName}" data-username="${username}">改名</button>` +
    `<button class="btn btn-sm btn-outline" data-action="role" data-id="${uid}" data-role="${role}" data-username="${username}">改角色</button>` +
    `<button class="btn btn-sm btn-outline" data-action="reset" data-id="${uid}" data-username="${username}">重置密码</button>` +
    activeBtn +
    `</div>`
  );
}

function renderUsers(users) {
  const body = $("users-body");
  if (!body) return;
  if (!Array.isArray(users) || users.length === 0) {
    body.innerHTML = `<tr><td colspan="7" class="text-muted">暂无用户</td></tr>`;
    return;
  }
  body.innerHTML = users
    .map((u) => {
      const statusClass = u.is_active ? "badge-green" : "badge-red";
      const statusText = u.is_active ? "active" : "inactive";
      return (
        `<tr>` +
        `<td>${Number(u.id)}</td>` +
        `<td>${esc(u.username)}</td>` +
        `<td>${esc(u.display_name || "-")}</td>` +
        `<td><span class="role-badge role-${esc(u.role)}">${esc(u.role)}</span></td>` +
        `<td><span class="status-pill ${statusClass}">${statusText}</span></td>` +
        `<td>${esc(u.last_login_at || "-")}</td>` +
        `<td>${userActionsCell(u)}</td>` +
        `</tr>`
      );
    })
    .join("");
}

function renderAudit(rows) {
  const body = $("audit-body");
  if (!body) return;
  const data = Array.isArray(rows) ? rows : [];
  if (!data.length) {
    body.innerHTML = `<tr><td colspan="6" class="text-muted">暂无审计记录</td></tr>`;
    return;
  }
  body.innerHTML = data
    .map((r) => {
      return (
        `<tr>` +
        `<td>${Number(r.id)}</td>` +
        `<td>${esc(r.created_at || "-")}</td>` +
        `<td>${esc(r.action || "-")}</td>` +
        `<td>${esc(r.actor || "-")}</td>` +
        `<td>${esc((r.target_type || "-") + ":" + (r.target_id || "-"))}</td>` +
        `<td class="wrap">${esc(valueToText(r.detail_json || {}))}</td>` +
        `</tr>`
      );
    })
    .join("");
}

function buildAuditFilterSummary(query) {
  const parts = [];
  if (query.q) parts.push(`关键词=${query.q}`);
  if (query.actor) parts.push(`执行人=${query.actor}`);
  if (query.action) parts.push(`动作=${query.action}`);
  if (query.target_type) parts.push(`目标=${query.target_type}`);
  if (query.date_from) parts.push(`开始=${query.date_from}`);
  if (query.date_to) parts.push(`结束=${query.date_to}`);
  parts.push(`limit=${query.limit}`);
  parts.push(`offset=${query.offset}`);
  if (!parts.length) return "当前筛选：全部记录";
  return "当前筛选：" + parts.join("，");
}

function renderAuditMeta(query, count) {
  const summaryEl = $("audit-filter-summary");
  if (summaryEl) {
    summaryEl.textContent = buildAuditFilterSummary(query || { limit: 100, offset: 0 });
  }
  const countEl = $("audit-result-count");
  if (countEl) {
    countEl.textContent = `${Math.max(0, Number(count) || 0)} 条`;
  }
}

function renderTableRows(payload) {
  const rows = payload.rows || [];
  const head = $("rows-head");
  const body = $("rows-body");
  if (!head || !body) return;
  if (!rows.length) {
    head.innerHTML = `<tr><th>结果</th></tr>`;
    body.innerHTML = `<tr><td class="text-muted">暂无数据</td></tr>`;
    return;
  }
  const cols = Object.keys(rows[0]);
  head.innerHTML = `<tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>`;
  body.innerHTML = rows
    .map((row) => {
      return (
        "<tr>" +
        cols
          .map((c) => {
            const cell = valueToText(row[c]);
            return `<td class="wrap">${esc(cell)}</td>`;
          })
          .join("") +
        "</tr>"
      );
    })
    .join("");
}

function renderSchema(schemaPayload) {
  const body = $("schema-body");
  if (!body) return;
  const columns = (schemaPayload && schemaPayload.columns) || [];
  if (!columns.length) {
    body.innerHTML = `<tr><td colspan="4" class="text-muted">暂无字段信息</td></tr>`;
    return;
  }
  body.innerHTML = columns
    .map((col) => {
      return (
        `<tr>` +
        `<td>${esc(col.name)}</td>` +
        `<td>${esc(col.type)}</td>` +
        `<td>${esc(col.nullable ? "是" : "否")}</td>` +
        `<td>${esc(col.primary_key ? "是" : "否")}</td>` +
        `</tr>`
      );
    })
    .join("");
}

function renderServerPanel() {
  const s = state.backendStatus || {};
  const hostEl = $("server-host");
  const portEl = $("server-port");
  if (hostEl) hostEl.value = String(s.host || hostEl.value || "127.0.0.1");
  if (portEl) portEl.value = String(s.port || portEl.value || "8000");

  const canControl = Boolean(s.process_control);
  const startBtn = $("server-start-btn");
  const stopBtn = $("server-stop-btn");
  if (startBtn) startBtn.disabled = !canControl;
  if (stopBtn) stopBtn.disabled = !canControl;

  const noteEl = $("server-control-note");
  if (noteEl) {
    noteEl.textContent = canControl
      ? "当前运行在可控模式，Ops 可通过本页启动/停止后端进程。"
      : "当前运行在托管模式（默认）。请使用 run_server.py/systemd/docker 管理后端生命周期。";
  }

  renderKeyValueRows("server-status-body", [
    ["运行中", s.running],
    ["可就绪", s.ready],
    ["进程ID", s.pid],
    ["目标地址", s.backend_url],
    ["绑定主机", s.host],
    ["绑定端口", s.port],
    ["模型目录", s.model_dir],
    ["推理设备", s.device],
    ["进程控制", s.process_control ? "enabled" : "disabled"],
    ["最近错误", s.last_error],
  ]);
}

function getActionJobsFilterValues() {
  const statusEl = $("action-jobs-status-filter");
  const typeEl = $("action-jobs-type-filter");
  return {
    status: String(statusEl ? statusEl.value : "").trim().toLowerCase(),
    type: String(typeEl ? typeEl.value : "").trim().toLowerCase(),
  };
}

function applyActionJobsFilters(rows) {
  const filters = getActionJobsFilterValues();
  const items = Array.isArray(rows) ? rows : [];
  return items.filter((job) => {
    const jobStatus = String(job && job.status ? job.status : "").toLowerCase();
    const jobType = String(job && job.job_type ? job.job_type : "").toLowerCase();
    if (filters.status && jobStatus !== filters.status) return false;
    if (filters.type && jobType !== filters.type) return false;
    return true;
  });
}

function renderActionJobs() {
  const body = $("actions-jobs-body");
  if (!body) return;
  const allRows = Array.isArray(state.actionJobs) ? state.actionJobs.slice() : [];
  if (!allRows.length) {
    body.innerHTML = `<tr><td colspan="7" class="text-muted">当前无动作任务</td></tr>`;
    return;
  }
  const jobs = applyActionJobsFilters(allRows);
  if (!jobs.length) {
    body.innerHTML = `<tr><td colspan="7" class="text-muted">无匹配任务，请调整筛选条件</td></tr>`;
    return;
  }
  const statusToBadge = (status) => {
    const key = String(status || "").toLowerCase();
    if (key === "succeeded") return "badge-green";
    if (key === "failed") return "badge-red";
    if (key === "running") return "badge-blue";
    if (key === "queued") return "badge-amber";
    return "badge-gray";
  };
  const shortText = (value, maxLen) => {
    const text = String(value || "");
    const size = Math.max(8, Number(maxLen) || 60);
    if (text.length <= size) return text || "-";
    return text.slice(0, size - 1) + "…";
  };
  body.innerHTML = jobs
    .map((job) => {
      const mode = String(job.mode || "execute");
      const typeText = `${String(job.job_type || "-")} (${mode})`;
      const startedAt = job.started_at || job.created_at || "-";
      const statusText = String(job.status || "-");
      const noteText = String(job.note || "-");
      const jobId = String(job.job_id || "");
      const canJumpAudit = statusText.toLowerCase() === "failed";
      return (
        `<tr>` +
        `<td>${esc(jobId || "-")}</td>` +
        `<td>${esc(typeText)}</td>` +
        `<td>${esc(job.actor || "-")}</td>` +
        `<td><span class="status-pill ${statusToBadge(statusText)}">${esc(statusText)}</span></td>` +
        `<td>${esc(startedAt)}</td>` +
        `<td class="wrap action-job-note" title="${esc(noteText)}">${esc(shortText(noteText, 66))}</td>` +
        `<td>` +
          `<div class="action-job-buttons">` +
            `<button class="btn btn-sm btn-outline" data-action-job-view="${esc(jobId)}">详情</button>` +
            (canJumpAudit
              ? `<button class="btn btn-sm btn-outline" data-action-job-audit="${esc(jobId)}" data-action-job-type="${esc(job.job_type || "")}">审计</button>`
              : "") +
          `</div>` +
        `</td>` +
        `</tr>`
      );
    })
    .join("");
}

function openActionJobDetailModal(jobId) {
  const targetId = String(jobId || "");
  const rows = Array.isArray(state.actionJobs) ? state.actionJobs : [];
  const job = rows.find((item) => String(item && item.job_id) === targetId);
  if (!job) {
    setMsg("任务详情不存在，请先刷新动作区", "err");
    return;
  }
  const payloadText = JSON.stringify(job.payload || {}, null, 2);
  const logs = Array.isArray(job.logs) ? job.logs : [];
  const logsText = logs.length
    ? logs
        .map((item) => `[${String(item && item.at ? item.at : "-")}] ${String(item && item.message ? item.message : "-")}`)
        .join("\n")
    : "无日志";
  const bodyHTML =
    `<div class="form-row">` +
    `<div class="form-field"><label class="form-label">任务ID</label><div class="form-hint"><code>${esc(job.job_id || "-")}</code></div></div>` +
    `<div class="form-field"><label class="form-label">状态</label><div class="form-hint">${esc(job.status || "-")}</div></div>` +
    `</div>` +
    `<div class="form-row">` +
    `<div class="form-field"><label class="form-label">类型</label><div class="form-hint">${esc(job.job_type || "-")} (${esc(job.mode || "-")})</div></div>` +
    `<div class="form-field"><label class="form-label">发起人</label><div class="form-hint">${esc(job.actor || "-")}</div></div>` +
    `</div>` +
    `<div class="form-row">` +
    `<div class="form-field"><label class="form-label">开始时间</label><div class="form-hint">${esc(job.started_at || "-")}</div></div>` +
    `<div class="form-field"><label class="form-label">结束时间</label><div class="form-hint">${esc(job.finished_at || "-")}</div></div>` +
    `</div>` +
    `<div class="form-field"><label class="form-label">备注</label><div class="form-hint">${esc(job.note || "-")}</div></div>` +
    `<div class="form-field"><label class="form-label">参数 payload</label><pre class="job-detail-pre">${esc(payloadText)}</pre></div>` +
    `<div class="form-field"><label class="form-label">执行日志</label><pre class="job-detail-pre">${esc(logsText)}</pre></div>`;
  const footerHTML = `<button class="btn btn-outline" id="job-detail-close-btn">关闭</button>`;
  showModal("动作任务详情", bodyHTML, footerHTML);
  const closeBtn = $("job-detail-close-btn");
  if (closeBtn) closeBtn.addEventListener("click", closeModal);
}

async function jumpToAuditForJob(jobId, jobType) {
  const targetJobId = String(jobId || "").trim();
  if (!targetJobId) {
    setMsg("缺少任务ID，无法跳转审计", "err");
    return;
  }
  const qEl = $("audit-filter");
  if (qEl) qEl.value = targetJobId;
  const actionEl = $("audit-action");
  const actionText = String(jobType || "").trim();
  if (actionEl) {
    actionEl.value = actionText ? ("ops.action." + actionText) : "";
  }
  const offsetEl = $("audit-offset");
  if (offsetEl) offsetEl.value = "0";
  setAuditPresetActive(0);
  switchView("audit-view");
  await loadAudit();
  setMsg("已跳转审计中心（按任务筛选）", "ok");
}

/* ---- Data fetchers ---- */
async function fetchBackendStatus() {
  try {
    const data = await launcherFetch("/_launcher/status");
    state.backendStatus = data;
  } catch (_err) {
    state.backendStatus = null;
  }
  renderBackendPill();
  renderServerPanel();
  renderActionJobs();
  renderOverviewKpi();
}

function hasPendingActionJobs() {
  const rows = Array.isArray(state.actionJobs) ? state.actionJobs : [];
  return rows.some((job) => {
    const status = String(job && job.status ? job.status : "").toLowerCase();
    return status === "queued" || status === "running";
  });
}

function stopActionJobsAutoPoll() {
  if (actionJobsPollTimer) {
    clearInterval(actionJobsPollTimer);
    actionJobsPollTimer = null;
  }
}

async function pollActionJobsTick() {
  if (actionJobsPollInFlight) return;
  if (!getToken()) {
    stopActionJobsAutoPoll();
    return;
  }
  if (getCurrentViewId() !== "actions-view") {
    stopActionJobsAutoPoll();
    return;
  }
  if (!hasPendingActionJobs()) {
    stopActionJobsAutoPoll();
    return;
  }
  actionJobsPollInFlight = true;
  try {
    await loadActionJobs();
    if (!hasPendingActionJobs()) {
      stopActionJobsAutoPoll();
      setMsg("动作任务已全部结束，自动刷新已停止", "info");
    }
  } catch (err) {
    stopActionJobsAutoPoll();
    setMsg("动作任务自动刷新失败：" + String(err.message || err), "err");
  } finally {
    actionJobsPollInFlight = false;
  }
}

function startActionJobsAutoPoll() {
  if (actionJobsPollTimer) return;
  actionJobsPollTimer = setInterval(() => {
    pollActionJobsTick();
  }, 2500);
}

function syncActionJobsAutoPoll() {
  if (getCurrentViewId() !== "actions-view") {
    stopActionJobsAutoPoll();
    return;
  }
  if (hasPendingActionJobs()) {
    startActionJobsAutoPoll();
  } else {
    stopActionJobsAutoPoll();
  }
}

function upsertActionJob(job) {
  if (!job || !job.job_id) return;
  const targetId = String(job.job_id);
  const rows = Array.isArray(state.actionJobs) ? state.actionJobs.slice() : [];
  const idx = rows.findIndex((x) => String(x && x.job_id) === targetId);
  if (idx >= 0) {
    rows[idx] = job;
  } else {
    rows.unshift(job);
  }
  state.actionJobs = rows.slice(0, 100);
  renderActionJobs();
  syncActionJobsAutoPoll();
}

async function loadActionJobs() {
  const payload = await apiFetch("v1/ops/jobs", { query: { limit: 40 } });
  const rows = payload && Array.isArray(payload.jobs) ? payload.jobs : [];
  state.actionJobs = rows;
  renderActionJobs();
  syncActionJobsAutoPoll();
}

async function submitOpsAction(actionType, precheck, extraBody) {
  const body = { precheck: Boolean(precheck), ...(extraBody || {}) };
  const payload = await apiFetch("v1/ops/actions/" + String(actionType), {
    method: "POST",
    body,
  });
  const job = payload && payload.job ? payload.job : null;
  if (job && job.job_id) {
    upsertActionJob(job);
    syncActionJobsAutoPoll();
  } else {
    await loadActionJobs();
  }
  return payload;
}

async function ensureOpsRole() {
  const me = await apiFetch("v1/auth/me");
  if (!["ops", "admin"].includes(String(me.role || "").toLowerCase())) {
    clearAuth();
    throw new Error("当前账号不是 ops/admin，无法进入运维管理台");
  }
  saveAuth({
    access_token: getToken(),
    username: me.username || authState.username,
    role: me.role || authState.role,
    expires_at: authState.expires_at,
  });
}

async function doLogin() {
  const username = String($("login-username").value || "").trim();
  const password = String($("login-password").value || "");
  if (!username || !password) {
    showLoginError("请输入用户名和密码");
    return;
  }
  const submitBtn = $("login-submit");
  const submitText = $("login-submit-text");
  const spinner = $("login-spinner");
  if (submitBtn) submitBtn.disabled = true;
  if (submitText) submitText.textContent = "登录中…";
  if (spinner) spinner.classList.remove("hidden");

  try {
    const data = await apiFetch("v1/auth/login", {
      method: "POST",
      auth: false,
      body: { username, password },
    });
    saveAuth({
      access_token: data.access_token,
      username: data.username,
      role: data.role,
      expires_at: Date.now() + Number(data.expires_in || 0) * 1000,
    });
    await ensureOpsRole();
    hideLoginError();
    showAppShell();
    await refreshAll();
    setMsg("登录成功", "ok");
  } catch (err) {
    if (isSetupRequiredError(err)) {
      showLoginError("服务端尚未初始化，请先访问 " + String(err.setup_url || "/setup") + " 完成安装");
    } else {
      showLoginError("登录失败：" + String(err.message || err));
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (submitText) submitText.textContent = "登 录";
    if (spinner) spinner.classList.add("hidden");
  }
}

function showLoginError(msg) {
  const el = $("login-error");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
}

function hideLoginError() {
  const el = $("login-error");
  if (!el) return;
  el.textContent = "";
  el.classList.add("hidden");
}

async function doLogout() {
  try {
    if (getToken()) {
      await apiFetch("v1/auth/logout", { method: "POST" });
    }
  } catch (_err) {
    // ignore
  } finally {
    stopActionJobsAutoPoll();
    clearAuth();
    showLoginScreen();
    setMsg("已退出", "ok");
  }
}

async function loadHealth() {
  const health = await apiFetch("v1/ops/health");
  state.health = health;
  renderHealth(health);
}

async function loadModelInfo() {
  const modelInfo = await apiFetch("v1/ops/model-info");
  state.modelInfo = modelInfo || null;
  if (state.health) {
    renderHealth(state.health);
  }
}

async function loadMetricsSummary() {
  const summary = await apiFetch("v1/ops/metrics/summary", { query: { window_hours: 24 } });
  state.metricsSummary = summary || null;
  renderOverviewKpi();
}

async function loadAlerts() {
  const payload = await apiFetch("v1/ops/alerts", { query: { window_hours: 24 } });
  state.alerts = Array.isArray(payload && payload.alerts) ? payload.alerts : [];
  renderOverviewAlerts(state.alerts);
}

function getUsersFilterQuery() {
  const qEl = $("users-filter-q");
  const roleEl = $("users-filter-role");
  const activeEl = $("users-filter-active");
  const q = qEl ? String(qEl.value || "").trim() : "";
  const role = roleEl ? String(roleEl.value || "").trim() : "";
  const activeValue = activeEl ? String(activeEl.value || "").trim() : "";
  const query = { limit: 200, offset: 0 };
  if (q) query.q = q;
  if (role) query.role = role;
  if (activeValue === "true" || activeValue === "false") {
    query.is_active = activeValue;
  }
  return query;
}

async function loadUsers() {
  const users = await apiFetch("v1/ops/users", { query: getUsersFilterQuery() });
  state.users = Array.isArray(users) ? users : [];
  renderUsers(state.users);
  renderOverviewKpi();
}

function getAuditFilterQuery() {
  const qEl = $("audit-filter");
  const actorEl = $("audit-actor");
  const actionEl = $("audit-action");
  const targetEl = $("audit-target");
  const fromEl = $("audit-date-from");
  const toEl = $("audit-date-to");
  const limitEl = $("audit-limit");
  const offsetEl = $("audit-offset");

  const limit = Math.max(1, Math.min(Number(limitEl ? limitEl.value : 100), 200));
  const offset = Math.max(0, Number(offsetEl ? offsetEl.value : 0));
  const query = { limit, offset };

  const q = String(qEl ? qEl.value : "").trim();
  const actor = String(actorEl ? actorEl.value : "").trim();
  const action = String(actionEl ? actionEl.value : "").trim();
  const targetType = String(targetEl ? targetEl.value : "").trim();
  const dateFrom = String(fromEl ? fromEl.value : "").trim();
  const dateTo = String(toEl ? toEl.value : "").trim();
  if (q) query.q = q;
  if (actor) query.actor = actor;
  if (action) query.action = action;
  if (targetType) query.target_type = targetType;
  if (dateFrom) query.date_from = dateFrom;
  if (dateTo) query.date_to = dateTo;
  return query;
}

function formatDateTimeLocalValue(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    "T" +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes())
  );
}

function setAuditPresetActive(hours) {
  [
    ["audit-preset-1h", 1],
    ["audit-preset-24h", 24],
    ["audit-preset-7d", 24 * 7],
  ].forEach(([id, val]) => {
    const el = $(id);
    if (!el) return;
    el.classList.toggle("is-active", Number(hours) === Number(val));
  });
}

async function applyAuditQuickRange(hours) {
  const to = new Date();
  const from = new Date(to.getTime() - Number(hours) * 3600 * 1000);
  const fromEl = $("audit-date-from");
  const toEl = $("audit-date-to");
  if (fromEl) fromEl.value = formatDateTimeLocalValue(from);
  if (toEl) toEl.value = formatDateTimeLocalValue(to);
  const offsetEl = $("audit-offset");
  if (offsetEl) offsetEl.value = "0";
  setAuditPresetActive(hours);
  await loadAudit();
}

async function loadAudit() {
  const query = getAuditFilterQuery();
  const logs = await apiFetch("v1/ops/audit-logs", { query });
  state.audits = Array.isArray(logs) ? logs : [];
  renderAudit(state.audits);
  renderAuditMeta(query, state.audits.length);
  renderOverviewKpi();
}

async function exportAuditCsv() {
  const btn = $("export-audit-btn");
  const prevLabel = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "导出中…";
  }
  const query = getAuditFilterQuery();
  const exportQuery = {
    ...query,
    limit: Math.max(1, Math.min(Number(query.limit || 1000), 5000)),
  };
  try {
    const result = await apiDownload("v1/ops/audit-logs/export", {
      query: exportQuery,
      filename: "audit_logs.csv",
    });
    setMsg("导出成功：" + result.filename, "ok");
  } catch (err) {
    setMsg("导出失败：" + String(err.message || err), "err");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = prevLabel || "导出 CSV";
    }
  }
}

async function loadTables() {
  const payload = await apiFetch("v1/ops/db/tables");
  const items = payload.tables || [];
  state.tables = Array.isArray(items) ? items : [];

  const selectEl = $("table-select");
  if (!selectEl) return;
  const prev = String(selectEl.value || "");
  if (!state.tables.length) {
    selectEl.innerHTML = `<option value="">无可视化表</option>`;
    const sb = $("schema-body");
    if (sb) sb.innerHTML = `<tr><td colspan="4" class="text-muted">暂无字段信息</td></tr>`;
    const rh = $("rows-head");
    if (rh) rh.innerHTML = "";
    const rb = $("rows-body");
    if (rb) rb.innerHTML = `<tr><td class="text-muted">暂无数据</td></tr>`;
    renderOverviewKpi();
    return;
  }
  selectEl.innerHTML = state.tables
    .map((t) => `<option value="${esc(t.name)}">${esc(t.name)} (${Number(t.row_count)})</option>`)
    .join("");
  if (prev && state.tables.some((t) => String(t.name) === prev)) {
    selectEl.value = prev;
  }
  renderOverviewKpi();
  await loadSelectedTable();
}

async function loadSelectedTable() {
  const selectEl = $("table-select");
  const table = selectEl ? String(selectEl.value || "") : "";
  if (!table) return;
  const limitEl = $("rows-limit");
  const offsetEl = $("rows-offset");
  const limit = Math.max(1, Math.min(Number(limitEl ? limitEl.value : 20), 200));
  const offset = Math.max(0, Number(offsetEl ? offsetEl.value : 0));
  const safeName = encodeURIComponent(table);

  const schema = await apiFetch("v1/ops/db/tables/" + safeName + "/schema");
  renderSchema(schema);
  const rows = await apiFetch("v1/ops/db/tables/" + safeName + "/rows", { query: { limit, offset } });
  renderTableRows(rows);
}

async function exportSelectedTableCsv() {
  const selectEl = $("table-select");
  const table = selectEl ? String(selectEl.value || "") : "";
  if (!table) {
    setMsg("请先选择要导出的表", "err");
    return;
  }
  const limitEl = $("rows-limit");
  const offsetEl = $("rows-offset");
  const limit = Math.max(1, Math.min(Number(limitEl ? limitEl.value : 20), 5000));
  const offset = Math.max(0, Number(offsetEl ? offsetEl.value : 0));
  const safeName = encodeURIComponent(table);

  try {
    const result = await apiDownload(
      "v1/ops/db/tables/" + safeName + "/rows/export",
      {
        query: { limit, offset },
        filename: String(table).toLowerCase() + "_rows.csv",
      }
    );
    setMsg("导出成功：" + result.filename, "ok");
  } catch (err) {
    setMsg("导出失败：" + String(err.message || err), "err");
  }
}

async function refreshAll() {
  await fetchBackendStatus();
  const jobs = [
    ["健康状态", loadHealth],
    ["模型信息", loadModelInfo],
    ["业务指标", loadMetricsSummary],
    ["告警面板", loadAlerts],
    ["用户列表", loadUsers],
    ["审计日志", loadAudit],
    ["动作任务", loadActionJobs],
    ["数据库表", loadTables],
  ];
  const results = await Promise.allSettled(
    jobs.map(async ([name, fn]) => {
      await fn();
      return name;
    })
  );

  const failed = [];
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    if (r.status === "rejected") {
      failed.push(jobs[i][0] + ": " + String(r.reason && r.reason.message ? r.reason.message : r.reason));
    }
  }

  if (!failed.length) {
    setMsg("已刷新", "ok");
    return;
  }
  setMsg("部分刷新失败：" + failed.join(" | "), "err");
}

async function startServerFromOps() {
  const hostEl = $("server-host");
  const portEl = $("server-port");
  const modelDirEl = $("server-model-dir");
  const deviceEl = $("server-device");
  const host = hostEl ? String(hostEl.value || "").trim() : "";
  const port = portEl ? Number(portEl.value || 0) : 0;
  const modelDir = modelDirEl ? String(modelDirEl.value || "").trim() : "";
  const device = deviceEl ? String(deviceEl.value || "").trim() : "";
  const body = {};
  if (host) body.host = host;
  if (port > 0) body.port = port;
  if (modelDir) body.model_dir = modelDir;
  if (device) body.device = device;
  try {
    const result = await launcherFetch("/_launcher/start-backend", { method: "POST", body });
    await fetchBackendStatus();
    setMsg(result.message || "已请求启动 Server", result.ok ? "ok" : "err");
  } catch (err) {
    setMsg("启动失败：" + String(err.message || err), "err");
  }
}

async function stopServerFromOps() {
  try {
    const result = await launcherFetch("/_launcher/stop-backend", { method: "POST", body: {} });
    await fetchBackendStatus();
    setMsg(result.message || "已请求停止 Server", result.ok ? "ok" : "err");
  } catch (err) {
    setMsg("停止失败：" + String(err.message || err), "err");
  }
}

async function createUserFromForm() {
  const username = String($("new-username").value || "").trim();
  const displayName = String($("new-display-name").value || "").trim();
  const password = String($("new-password").value || "");
  const role = String($("new-role").value || "operator");
  if (!username || !password) {
    setMsg("用户名和初始密码不能为空", "err");
    return;
  }
  try {
    await apiFetch("v1/ops/users", {
      method: "POST",
      body: {
        username,
        display_name: displayName || null,
        password,
        role,
        is_active: true,
      },
    });
    $("new-username").value = "";
    $("new-display-name").value = "";
    $("new-password").value = "";
    const card = $("create-user-card");
    if (card) card.style.display = "none";
    await Promise.all([loadUsers(), loadAudit()]);
    setMsg("用户创建成功", "ok");
  } catch (err) {
    setMsg("创建失败：" + String(err.message || err), "err");
  }
}

function buildRiskContextHTML(actionTitle, uid, username) {
  return (
    `<div class="form-hint" style="margin-top:10px;padding:10px;border:1px solid var(--amber-100);background:var(--amber-50);border-radius:8px">` +
    `<div><strong>${esc(actionTitle)}</strong>（高风险操作）</div>` +
    `<div>操作人：${esc(authState.username || "-")}</div>` +
    `<div>目标用户：${esc(username || ("user-" + uid))} (ID ${esc(uid)})</div>` +
    `<div>发起时间：${esc(new Date().toLocaleString("zh-CN"))}</div>` +
    `</div>`
  );
}

async function performUserMutation(requestFn, successMessage, errorElId) {
  try {
    await requestFn();
    await Promise.all([loadUsers(), loadAudit()]);
    closeModal();
    setMsg(successMessage, "ok");
  } catch (err) {
    const detail = String(err && err.message ? err.message : err);
    const errEl = $(errorElId);
    if (errEl) {
      errEl.textContent = detail;
      errEl.classList.remove("hidden");
    } else {
      setMsg("用户操作失败：" + detail, "err");
    }
  }
}

function openRenameUserModal(uid, dataName, username) {
  const bodyHTML =
    `<div class="form-field">` +
    `<label class="form-label">显示名</label>` +
    `<input id="user-rename-input" class="form-input" type="text" value="${esc(dataName || "")}" placeholder="可留空" />` +
    `<span class="form-hint">仅更新展示名称，不影响登录用户名。</span>` +
    `</div>` +
    `<div id="user-action-error" class="error-msg hidden"></div>`;
  const footerHTML =
    `<button class="btn btn-outline" id="user-action-cancel-btn">取消</button>` +
    `<button class="btn btn-primary" id="user-action-confirm-btn">保存</button>`;
  showModal("更新用户显示名", bodyHTML, footerHTML);
  const cancelBtn = $("user-action-cancel-btn");
  if (cancelBtn) cancelBtn.addEventListener("click", closeModal);
  const confirmBtn = $("user-action-confirm-btn");
  if (!confirmBtn) return;
  confirmBtn.addEventListener("click", async () => {
    const nameEl = $("user-rename-input");
    const nextName = String(nameEl ? nameEl.value : "");
    confirmBtn.disabled = true;
    confirmBtn.textContent = "提交中…";
    await performUserMutation(
      () =>
        apiFetch("v1/ops/users/" + uid, {
          method: "PATCH",
          body: { display_name: nextName },
        }),
      "显示名已更新",
      "user-action-error"
    );
    confirmBtn.disabled = false;
    confirmBtn.textContent = "保存";
  });
}

function openUpdateRoleModal(uid, dataRole, username) {
  const role = String(dataRole || "operator").toLowerCase();
  const bodyHTML =
    `<div class="form-field">` +
    `<label class="form-label">目标角色</label>` +
    `<select id="user-role-select" class="form-input">` +
    `<option value="doctor"${role === "doctor" ? " selected" : ""}>doctor</option>` +
    `<option value="operator"${role === "operator" ? " selected" : ""}>operator</option>` +
    `<option value="ops"${role === "ops" ? " selected" : ""}>ops</option>` +
    `<option value="admin"${role === "admin" ? " selected" : ""}>admin</option>` +
    `</select>` +
    `</div>` +
    buildRiskContextHTML("角色变更", uid, username) +
    `<div id="user-action-error" class="error-msg hidden"></div>`;
  const footerHTML =
    `<button class="btn btn-outline" id="user-action-cancel-btn">取消</button>` +
    `<button class="btn btn-primary" id="user-action-confirm-btn">确认变更</button>`;
  showModal("更新用户角色", bodyHTML, footerHTML);
  const cancelBtn = $("user-action-cancel-btn");
  if (cancelBtn) cancelBtn.addEventListener("click", closeModal);
  const confirmBtn = $("user-action-confirm-btn");
  if (!confirmBtn) return;
  confirmBtn.addEventListener("click", async () => {
    const selectEl = $("user-role-select");
    const nextRole = String(selectEl ? selectEl.value : "").trim().toLowerCase();
    if (!nextRole) {
      const errEl = $("user-action-error");
      if (errEl) {
        errEl.textContent = "请选择目标角色";
        errEl.classList.remove("hidden");
      }
      return;
    }
    confirmBtn.disabled = true;
    confirmBtn.textContent = "提交中…";
    await performUserMutation(
      () =>
        apiFetch("v1/ops/users/" + uid, {
          method: "PATCH",
          body: { role: nextRole },
        }),
      "角色已更新",
      "user-action-error"
    );
    confirmBtn.disabled = false;
    confirmBtn.textContent = "确认变更";
  });
}

function openResetPasswordModal(uid, username) {
  const bodyHTML =
    `<div class="form-row">` +
    `<div class="form-field"><label class="form-label">新密码</label><input id="user-reset-pwd-1" class="form-input" type="password" autocomplete="new-password" placeholder="至少8位" /></div>` +
    `<div class="form-field"><label class="form-label">确认新密码</label><input id="user-reset-pwd-2" class="form-input" type="password" autocomplete="new-password" placeholder="再次输入" /></div>` +
    `</div>` +
    buildRiskContextHTML("密码重置", uid, username) +
    `<div id="user-action-error" class="error-msg hidden"></div>`;
  const footerHTML =
    `<button class="btn btn-outline" id="user-action-cancel-btn">取消</button>` +
    `<button class="btn btn-danger" id="user-action-confirm-btn">确认重置</button>`;
  showModal("重置用户密码", bodyHTML, footerHTML);
  const cancelBtn = $("user-action-cancel-btn");
  if (cancelBtn) cancelBtn.addEventListener("click", closeModal);
  const confirmBtn = $("user-action-confirm-btn");
  if (!confirmBtn) return;
  confirmBtn.addEventListener("click", async () => {
    const p1 = String(($("user-reset-pwd-1") ? $("user-reset-pwd-1").value : "") || "");
    const p2 = String(($("user-reset-pwd-2") ? $("user-reset-pwd-2").value : "") || "");
    const errEl = $("user-action-error");
    if (errEl) errEl.classList.add("hidden");
    if (!p1 || !p2) {
      if (errEl) {
        errEl.textContent = "请完整输入新密码和确认密码";
        errEl.classList.remove("hidden");
      }
      return;
    }
    if (p1 !== p2) {
      if (errEl) {
        errEl.textContent = "两次输入密码不一致";
        errEl.classList.remove("hidden");
      }
      return;
    }
    confirmBtn.disabled = true;
    confirmBtn.textContent = "提交中…";
    await performUserMutation(
      () =>
        apiFetch("v1/ops/users/" + uid + "/reset-password", {
          method: "POST",
          body: { new_password: p1 },
        }),
      "密码已重置",
      "user-action-error"
    );
    confirmBtn.disabled = false;
    confirmBtn.textContent = "确认重置";
  });
}

function openToggleUserStatusModal(uid, username, activate) {
  const actionTitle = activate ? "账号启用" : "账号停用";
  const actionDesc = activate
    ? "启用后该用户可重新登录并访问授权功能。"
    : "停用后该用户将无法登录，请确认业务影响。";
  const bodyHTML =
    `<div class="form-hint">${esc(actionDesc)}</div>` +
    buildRiskContextHTML(actionTitle, uid, username) +
    `<div id="user-action-error" class="error-msg hidden"></div>`;
  const footerHTML =
    `<button class="btn btn-outline" id="user-action-cancel-btn">取消</button>` +
    `<button class="btn ${activate ? "btn-primary" : "btn-danger"}" id="user-action-confirm-btn">${activate ? "确认启用" : "确认停用"}</button>`;
  showModal(activate ? "启用用户" : "停用用户", bodyHTML, footerHTML);
  const cancelBtn = $("user-action-cancel-btn");
  if (cancelBtn) cancelBtn.addEventListener("click", closeModal);
  const confirmBtn = $("user-action-confirm-btn");
  if (!confirmBtn) return;
  confirmBtn.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "提交中…";
    await performUserMutation(
      () =>
        apiFetch("v1/ops/users/" + uid + (activate ? "/activate" : "/deactivate"), {
          method: "POST",
        }),
      activate ? "用户已启用" : "用户已停用",
      "user-action-error"
    );
    confirmBtn.disabled = false;
    confirmBtn.textContent = activate ? "确认启用" : "确认停用";
  });
}

async function handleUserAction(action, userId, dataRole, dataName, dataUsername) {
  const uid = Number(userId);
  if (!(uid > 0)) return;
  const username = String(dataUsername || ("user-" + uid));
  if (action === "activate") {
    openToggleUserStatusModal(uid, username, true);
    return;
  }
  if (action === "deactivate") {
    openToggleUserStatusModal(uid, username, false);
    return;
  }
  if (action === "reset") {
    openResetPasswordModal(uid, username);
    return;
  }
  if (action === "role") {
    openUpdateRoleModal(uid, dataRole, username);
    return;
  }
  if (action === "rename") {
    openRenameUserModal(uid, dataName, username);
  }
}

/* ---- Event binding ---- */
function bindEvents() {
  /* Login form submit */
  const loginForm = $("login-form");
  if (loginForm) {
    loginForm.addEventListener("submit", (e) => {
      e.preventDefault();
      doLogin();
    });
  }
  const loginConnBtn = $("login-conn-settings");
  if (loginConnBtn) {
    loginConnBtn.addEventListener("click", () => {
      openLoginConnectionSettingsModal();
    });
  }

  /* Logout */
  const logoutBtn = $("logout-btn");
  if (logoutBtn) logoutBtn.addEventListener("click", doLogout);

  /* Navigation */
  document.querySelectorAll(".nav-item[data-view]").forEach((item) => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      switchView(item.getAttribute("data-view"));
    });
  });

  /* Refresh all */
  const refreshBtn = $("refresh-all-btn");
  if (refreshBtn) refreshBtn.addEventListener("click", refreshAll);

  const quickMap = [
    ["quick-go-users", "users-view"],
    ["quick-go-data", "data-view"],
    ["quick-go-actions", "actions-view"],
    ["quick-go-audit", "audit-view"],
  ];
  quickMap.forEach(([id, target]) => {
    const btn = $(id);
    if (!btn) return;
    btn.addEventListener("click", () => switchView(target));
  });

  /* Health refresh */
  const healthBtn = $("health-refresh-btn");
  if (healthBtn) {
    healthBtn.addEventListener("click", async () => {
      try {
        await loadHealth();
        await loadModelInfo();
        setMsg("健康状态已刷新", "ok");
      } catch (err) {
        setMsg("刷新健康状态失败：" + String(err.message || err), "err");
      }
    });
  }
  const alertsBtn = $("alerts-refresh-btn");
  if (alertsBtn) {
    alertsBtn.addEventListener("click", async () => {
      try {
        await loadAlerts();
        setMsg("告警面板已刷新", "ok");
      } catch (err) {
        setMsg("刷新告警失败：" + String(err.message || err), "err");
      }
    });
  }

  /* Create user toggle */
  const openCreateBtn = $("open-create-user-btn");
  const cancelCreateBtn = $("cancel-create-user-btn");
  const createCard = $("create-user-card");
  if (openCreateBtn && createCard) {
    openCreateBtn.addEventListener("click", () => {
      createCard.style.display = createCard.style.display === "none" ? "" : "none";
    });
  }
  if (cancelCreateBtn && createCard) {
    cancelCreateBtn.addEventListener("click", () => {
      createCard.style.display = "none";
    });
  }

  /* Create user submit */
  const createBtn = $("create-user-btn");
  if (createBtn) createBtn.addEventListener("click", createUserFromForm);

  /* Users filter & reload */
  const reloadUsersBtn = $("reload-users-btn");
  if (reloadUsersBtn) {
    reloadUsersBtn.addEventListener("click", async () => {
      try {
        await loadUsers();
        setMsg("用户列表已刷新", "ok");
      } catch (err) {
        setMsg("刷新用户失败：" + String(err.message || err), "err");
      }
    });
  }
  const applyFilterBtn = $("apply-users-filter-btn");
  if (applyFilterBtn) {
    applyFilterBtn.addEventListener("click", async () => {
      try {
        await loadUsers();
        setMsg("筛选已应用", "ok");
      } catch (err) {
        setMsg("筛选失败：" + String(err.message || err), "err");
      }
    });
  }

  /* Users table action delegation */
  const usersBody = $("users-body");
  if (usersBody) {
    usersBody.addEventListener("click", async (event) => {
      const btn = event.target.closest("button[data-action]");
      if (!btn) return;
      await handleUserAction(
        btn.getAttribute("data-action"),
        btn.getAttribute("data-id"),
        btn.getAttribute("data-role"),
        btn.getAttribute("data-name"),
        btn.getAttribute("data-username")
      );
    });
  }

  /* Server panel */
  const actionsRefreshBtn = $("actions-refresh-btn");
  if (actionsRefreshBtn) {
    actionsRefreshBtn.addEventListener("click", async () => {
      await fetchBackendStatus();
      await loadActionJobs();
      setMsg("动作中心状态已刷新", "ok");
    });
  }
  const actionJobsApplyBtn = $("action-jobs-apply-btn");
  if (actionJobsApplyBtn) {
    actionJobsApplyBtn.addEventListener("click", () => {
      renderActionJobs();
      setMsg("动作任务筛选已应用", "ok");
    });
  }
  const actionJobsResetBtn = $("action-jobs-reset-btn");
  if (actionJobsResetBtn) {
    actionJobsResetBtn.addEventListener("click", () => {
      const statusEl = $("action-jobs-status-filter");
      const typeEl = $("action-jobs-type-filter");
      if (statusEl) statusEl.value = "";
      if (typeEl) typeEl.value = "";
      renderActionJobs();
      setMsg("动作任务筛选已重置", "ok");
    });
  }
  ["action-jobs-status-filter", "action-jobs-type-filter"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("change", () => renderActionJobs());
  });
  const startBtn = $("server-start-btn");
  if (startBtn) startBtn.addEventListener("click", startServerFromOps);
  const stopBtn = $("server-stop-btn");
  if (stopBtn) stopBtn.addEventListener("click", stopServerFromOps);
  [
    ["precheck-backup-btn", "backup", true, "备份预检查任务已提交"],
    ["run-backup-btn", "backup", false, "备份任务已提交"],
    ["precheck-migration-btn", "migration-check", true, "迁移检查预检查任务已提交"],
    ["run-migration-check-btn", "migration-check", false, "迁移检查任务已提交"],
    ["precheck-reindex-btn", "reindex", true, "索引维护预检查任务已提交"],
    ["run-reindex-btn", "reindex", false, "索引维护任务已提交"],
  ].forEach(([id, actionType, precheck, okMsg]) => {
    const btn = $(id);
    if (!btn) return;
    btn.addEventListener("click", async () => {
      const prev = btn.textContent;
      btn.disabled = true;
      btn.textContent = "提交中…";
      try {
        const payload = await submitOpsAction(actionType, precheck);
        setMsg(String(payload.message || okMsg), "ok");
      } catch (err) {
        setMsg("动作提交失败：" + String(err.message || err), "err");
      } finally {
        btn.disabled = false;
        btn.textContent = prev;
      }
    });
  });
  const actionJobsBody = $("actions-jobs-body");
  if (actionJobsBody) {
    actionJobsBody.addEventListener("click", async (event) => {
      const detailBtn = event.target.closest("button[data-action-job-view]");
      if (detailBtn) {
        openActionJobDetailModal(detailBtn.getAttribute("data-action-job-view"));
        return;
      }
      const auditBtn = event.target.closest("button[data-action-job-audit]");
      if (!auditBtn) return;
      try {
        await jumpToAuditForJob(
          auditBtn.getAttribute("data-action-job-audit"),
          auditBtn.getAttribute("data-action-job-type")
        );
      } catch (err) {
        setMsg("跳转审计失败：" + String(err.message || err), "err");
      }
    });
  }

  /* DB view */
  const reloadTablesBtn = $("reload-tables-btn");
  if (reloadTablesBtn) {
    reloadTablesBtn.addEventListener("click", async () => {
      try {
        await loadTables();
        setMsg("表列表已刷新", "ok");
      } catch (err) {
        setMsg("刷新表列表失败：" + String(err.message || err), "err");
      }
    });
  }
  const reloadTableBtn = $("reload-table-btn");
  if (reloadTableBtn) {
    reloadTableBtn.addEventListener("click", async () => {
      try {
        await loadSelectedTable();
        setMsg("表数据已刷新", "ok");
      } catch (err) {
        setMsg("加载表数据失败：" + String(err.message || err), "err");
      }
    });
  }
  const exportTableBtn = $("export-table-btn");
  if (exportTableBtn) {
    exportTableBtn.addEventListener("click", exportSelectedTableCsv);
  }
  const tableSelect = $("table-select");
  if (tableSelect) tableSelect.addEventListener("change", loadSelectedTable);

  /* Audit */
  const reloadAuditBtn = $("reload-audit-btn");
  if (reloadAuditBtn) {
    reloadAuditBtn.addEventListener("click", async () => {
      try {
        await loadAudit();
        setMsg("审计已刷新", "ok");
      } catch (err) {
        setMsg("刷新审计失败：" + String(err.message || err), "err");
      }
    });
  }
  const applyAuditBtn = $("apply-audit-filter-btn");
  if (applyAuditBtn) {
    applyAuditBtn.addEventListener("click", async () => {
      try {
        setAuditPresetActive(0);
        await loadAudit();
        setMsg("审计筛选已应用", "ok");
      } catch (err) {
        setMsg("应用审计筛选失败：" + String(err.message || err), "err");
      }
    });
  }
  const resetAuditBtn = $("reset-audit-filter-btn");
  if (resetAuditBtn) {
    resetAuditBtn.addEventListener("click", async () => {
      ["audit-filter", "audit-actor", "audit-action", "audit-target", "audit-date-from", "audit-date-to"].forEach((id) => {
        const el = $(id);
        if (el) el.value = "";
      });
      setAuditPresetActive(0);
      const offsetEl = $("audit-offset");
      if (offsetEl) offsetEl.value = "0";
      try {
        await loadAudit();
        setMsg("审计筛选已重置", "ok");
      } catch (err) {
        setMsg("重置审计筛选失败：" + String(err.message || err), "err");
      }
    });
  }
  const exportAuditBtn = $("export-audit-btn");
  if (exportAuditBtn) {
    exportAuditBtn.addEventListener("click", exportAuditCsv);
  }
  [
    ["audit-preset-1h", 1, "已应用快捷筛选：近1小时"],
    ["audit-preset-24h", 24, "已应用快捷筛选：近24小时"],
    ["audit-preset-7d", 24 * 7, "已应用快捷筛选：近7天"],
  ].forEach(([id, hours, okMsg]) => {
    const btn = $(id);
    if (!btn) return;
    btn.addEventListener("click", async () => {
      try {
        await applyAuditQuickRange(hours);
        setMsg(String(okMsg), "ok");
      } catch (err) {
        setMsg("快捷筛选失败：" + String(err.message || err), "err");
      }
    });
  });
  ["audit-date-from", "audit-date-to"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("input", () => setAuditPresetActive(0));
  });
  ["audit-filter", "audit-actor", "audit-action", "audit-target", "audit-date-from", "audit-date-to"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      try {
        setAuditPresetActive(0);
        await loadAudit();
        setMsg("审计筛选已应用", "ok");
      } catch (err) {
        setMsg("应用审计筛选失败：" + String(err.message || err), "err");
      }
    });
  });
}

/* ---- Init ---- */
async function init() {
  bindEvents();
  loadOpsSettings();
  renderLoginApiBaseHint();
  loadAuth();
  renderAuthUI();
  await fetchBackendStatus();
  renderActionJobs();

  if (!getToken()) {
    showLoginScreen();
    return;
  }
  try {
    await ensureOpsRole();
    showAppShell();
    switchView("overview-view");
    await refreshAll();
  } catch (err) {
    setMsg(String(err.message || err), "err");
    showLoginScreen();
  }
}

init();
