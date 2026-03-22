/* ============================================================
   Myopia Prediction Clinical SPA — app.js v4
   ============================================================ */

const STORAGE_KEY = 'myopia_ui_v2';
const LEGACY_STORAGE_KEYS = ['myopia_ui_settings_v1'];
const AUTH_STORAGE_KEY = 'myopia_auth_v1';
const DOCTOR_PREFS_KEY = 'myopia_doctor_prefs_v1';
const ENCOUNTER_DRAFT_KEY = 'myopia_encounter_draft_v1';

function getDefaultApiBase() {
  const path = window.location.pathname || '';
  if (
    path.startsWith('/app') ||
    path.startsWith('/doctor') ||
    path.startsWith('/clinical') ||
    path.startsWith('/launcher') ||
    path.startsWith('/ops/launcher')
  ) {
    return '/api';
  }
  const protocol = window.location.protocol.startsWith('http') ? window.location.protocol : 'http:';
  const hostname = window.location.hostname || '127.0.0.1';
  return `${protocol}//${hostname}:8000`;
}

const DEFAULT_SETTINGS = {
  api_base: getDefaultApiBase(),
};

const DEFAULT_DOCTOR_PREFS = {
  default_horizons: [1, 2, 3],
  table_density: 'standard',
  font_size: 'normal',
  autosave_encounter_draft: true,
  confirm_before_submit: true,
};
const DEFAULT_PREDICTION_RISK_THRESHOLD = 0.5;
const PREDICTION_FAMILY_LABELS = {
  xu: 'Xu',
  fen: 'Fen',
  feng: 'FenG',
};

// ===== State =====
let settings = { ...DEFAULT_SETTINGS };
let doctorPrefs = { ...DEFAULT_DOCTOR_PREFS };
let sessionAssets = [];
let _searchDebounceTimer = null;
let _preSelectedPatientId = null;
let _activePreviewObjectUrl = '';
let availablePredictionModelFamilies = ['xu'];
let authState = {
  access_token: '',
  username: '',
  role: '',
  expires_at: 0,
};

// ===== DOM helpers =====
const $ = (id) => document.getElementById(id);

// ===== API URL helpers (preserved exactly) =====
function normalizeApiBase(value) {
  let raw = String(value || '').trim();
  if (!raw) return '';
  const toPathPrefix = (v) => `/${String(v).replace(/^(?:\.\.\/|\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '')}`;

  raw = raw.replace(/^['"]+|['"]+$/g, '').trim();
  if (!raw) return '';

  if (/^https?:\/\//i.test(raw) || raw.startsWith('//')) {
    return raw.replace(/\/+$/, '');
  }

  if (raw.startsWith('/') || raw.startsWith('./') || raw.startsWith('../')) {
    return toPathPrefix(raw);
  }

  const isIpv6 = /^\[[0-9a-fA-F:.]+\](?::\d+)?(?:\/.*)?$/.test(raw);
  const isLocalhost = /^localhost(?::\d+)?(?:\/.*)?$/i.test(raw);
  const isIpv4 = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/.*)?$/.test(raw);
  const isDomain = /^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+(?::\d+)?(?:\/.*)?$/.test(raw);
  const isHostWithPort = /^[a-zA-Z0-9-]+(?::\d+)(?:\/.*)?$/.test(raw);
  const looksLikeHost = isIpv6 || isLocalhost || isIpv4 || isDomain || isHostWithPort;
  if (looksLikeHost) {
    return `${window.location.protocol}//${raw}`.replace(/\/+$/, '');
  }

  return toPathPrefix(raw);
}

function absoluteApiBase(base) {
  const normalized = normalizeApiBase(base);
  if (!normalized) {
    throw new Error('API Base URL 不能为空');
  }
  if (/^https?:\/\//i.test(normalized)) {
    return `${normalized.replace(/\/+$/, '')}/`;
  }
  if (normalized.startsWith('//')) {
    return `${window.location.protocol}${normalized.replace(/\/+$/, '')}/`;
  }
  return `${window.location.origin}${normalized.replace(/\/+$/, '')}/`;
}

function buildApiUrl(pathname, query = {}) {
  const cleanPath = String(pathname || '').replace(/^\/+/, '');
  const url = new URL(cleanPath, absoluteApiBase(settings.api_base || DEFAULT_SETTINGS.api_base));
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    url.searchParams.set(key, String(value));
  });

  if (url.origin === window.location.origin) {
    return `${url.pathname}${url.search}`;
  }
  return url.toString();
}

function buildApiUrlWithBase(pathname, base, query = {}) {
  const normalizedBase = normalizeApiBase(base);
  if (!normalizedBase) {
    throw new Error('API Base URL 不能为空');
  }
  const cleanPath = String(pathname || '').replace(/^\/+/, '');
  const url = new URL(cleanPath, absoluteApiBase(normalizedBase));
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    url.searchParams.set(key, String(value));
  });
  if (url.origin === window.location.origin) {
    return `${url.pathname}${url.search}`;
  }
  return url.toString();
}

function isSetupRequiredPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.setup && payload.setup.setup_required === true) return true;
  return String(payload.status || '').toLowerCase() === 'setup_required';
}

function buildSetupUrlWithBase(apiBase) {
  try {
    const normalized = normalizeApiBase(apiBase || settings.api_base || DEFAULT_SETTINGS.api_base);
    const absBase = absoluteApiBase(normalized);
    const url = new URL(absBase);
    let path = url.pathname.replace(/\/+$/, '');
    if (path.toLowerCase().endsWith('/api')) {
      path = path.slice(0, -4);
    }
    const root = url.origin + (path ? (path + '/') : '/');
    return new URL('setup', root).toString();
  } catch (_) {
    return '/setup';
  }
}

function createSetupRequiredError(detail, apiBase) {
  const err = new Error(String(detail || 'server setup required'));
  err.code = 'SERVER_SETUP_REQUIRED';
  err.setup_url = buildSetupUrlWithBase(apiBase);
  return err;
}

function isSetupRequiredError(err) {
  return !!(err && err.code === 'SERVER_SETUP_REQUIRED');
}

function loadAuthState() {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    authState = {
      access_token: String(parsed.access_token || ''),
      username: String(parsed.username || ''),
      role: String(parsed.role || ''),
      expires_at: Number(parsed.expires_at || 0),
    };
  } catch (_) {}
}

function saveAuthState(next) {
  authState = {
    access_token: String(next.access_token || ''),
    username: String(next.username || ''),
    role: String(next.role || ''),
    expires_at: Number(next.expires_at || 0),
  };
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(authState));
  renderAuthState();
}

function clearAuthState() {
  authState = { access_token: '', username: '', role: '', expires_at: 0 };
  localStorage.removeItem(AUTH_STORAGE_KEY);
  renderAuthState();
}

function getAccessToken() {
  const token = String(authState.access_token || '');
  const exp = Number(authState.expires_at || 0);
  if (!token) return '';
  if (exp > 0 && Date.now() > exp) {
    clearAuthState();
    return '';
  }
  return token;
}

function renderAuthState() {
  const userInfo = $('user-info');
  const nameEl = $('user-display-name');
  const roleBadge = $('user-role-badge');
  const token = getAccessToken();
  if (userInfo) {
    userInfo.classList.toggle('hidden', !token);
  }
  var avatarEl = $('user-avatar');
  if (avatarEl) {
    var name = token ? (authState.username || '用户') : '';
    avatarEl.textContent = name ? name.charAt(0).toUpperCase() : 'U';
  }
  if (nameEl) {
    nameEl.textContent = token ? (authState.username || '用户') : '';
  }
  if (roleBadge) {
    roleBadge.textContent = token ? (authState.role || '') : '';
    roleBadge.className = 'role-badge' + (token && authState.role ? ' role-' + authState.role.toLowerCase() : '');
  }
}

function showLoginScreen() {
  const loginScreen = $('login-screen');
  const appShell = $('app-shell');
  if (loginScreen) loginScreen.classList.remove('hidden');
  if (appShell) appShell.classList.add('hidden');
}

function showAppShell() {
  const loginScreen = $('login-screen');
  const appShell = $('app-shell');
  if (loginScreen) loginScreen.classList.add('hidden');
  if (appShell) appShell.classList.remove('hidden');
}

function showLoginError(msg) {
  const el = $('login-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideLoginError() {
  const el = $('login-error');
  if (!el) return;
  el.textContent = '';
  el.classList.add('hidden');
}

function renderLoginApiBaseHint() {
  const hintEl = $('login-api-base-preview');
  if (!hintEl) return;
  hintEl.textContent = settings.api_base || DEFAULT_SETTINGS.api_base;
}

async function testApiBaseHealth(apiBase) {
  const url = buildApiUrlWithBase('/healthz', apiBase);
  const resp = await fetch(url, { method: 'GET', cache: 'no-store' });
  let data = {};
  try {
    data = await resp.json();
  } catch (_) {}
  if (isSetupRequiredPayload(data)) {
    return { setup_required: true, setup_url: buildSetupUrlWithBase(apiBase) };
  }
  if (!resp.ok) {
    throw new Error('健康检查失败（HTTP ' + resp.status + '）');
  }
  return { setup_required: false };
}

function openLoginConnectionSettingsModal() {
  const current = settings.api_base || DEFAULT_SETTINGS.api_base;
  const bodyHTML =
    '<div class="form-field mb-12">' +
      '<label class="form-label">服务端 API Base URL <span style="color:var(--red-500)">*</span></label>' +
      '<input id="login-api-base-input" class="form-input" type="text" placeholder="/api 或 http://127.0.0.1:8000" value="' + escHtml(current) + '" />' +
      '<span class="form-hint">用于登录与所有接口请求。可填写服务端 IP（如 <code>http://192.168.1.10:8000</code>）。</span>' +
    '</div>' +
    '<div id="login-api-base-test-msg" class="text-muted text-sm">点击“测试连接”验证后端可达性。</div>';
  const footerHTML =
    '<button class="btn btn-outline" id="login-api-base-test-btn">测试连接</button>' +
    '<button class="btn btn-outline" onclick="closeModal()">取消</button>' +
    '<button class="btn btn-primary" id="login-api-base-save-btn">保存</button>';
  showModal('连接设置', bodyHTML, footerHTML);

  const testMsgEl = $('login-api-base-test-msg');
  const testBtn = $('login-api-base-test-btn');
  const saveBtn = $('login-api-base-save-btn');
  if (testBtn) {
    testBtn.addEventListener('click', async function() {
      const input = $('login-api-base-input');
      const value = (input ? input.value : '').trim();
      if (!testMsgEl) return;
      testBtn.disabled = true;
      testBtn.textContent = '测试中…';
      try {
        const result = await testApiBaseHealth(value);
        if (result && result.setup_required) {
          testMsgEl.className = 'badge badge-amber';
          testMsgEl.textContent = '服务端可达，但尚未完成首次安装：' + String(result.setup_url || '/setup');
        } else {
          testMsgEl.className = 'badge badge-green';
          testMsgEl.textContent = '连接成功';
        }
      } catch (err) {
        testMsgEl.className = 'error-msg';
        testMsgEl.textContent = '连接失败：' + String(err.message || err);
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = '测试连接';
      }
    });
  }
  if (saveBtn) {
    saveBtn.addEventListener('click', function() {
      const input = $('login-api-base-input');
      const normalized = normalizeApiBase((input ? input.value : '').trim());
      if (!normalized) {
        if (testMsgEl) {
          testMsgEl.className = 'error-msg';
          testMsgEl.textContent = '请输入有效的服务端 API 地址';
        }
        return;
      }
      settings.api_base = normalized;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      renderLoginApiBaseHint();
      closeModal();
      showToast('连接地址已保存', 'success');
    });
  }
}

async function doLoginFromScreen() {
  const userEl = $('login-username');
  const passEl = $('login-password');
  const username = (userEl ? userEl.value : '').trim();
  const password = passEl ? passEl.value : '';
  if (!username || !password) {
    showLoginError('请输入用户名和密码');
    return;
  }
  const submitBtn = $('login-submit');
  const submitText = $('login-submit-text');
  const spinner = $('login-spinner');
  if (submitBtn) submitBtn.disabled = true;
  if (submitText) submitText.textContent = '登录中…';
  if (spinner) spinner.classList.remove('hidden');
  try {
    const loginResp = await apiFetch('/v1/auth/login', {
      method: 'POST',
      body: { username: username, password: password },
      auth: false,
    });
    saveAuthState({
      access_token: loginResp.access_token,
      username: loginResp.username,
      role: loginResp.role,
      expires_at: Date.now() + Number(loginResp.expires_in || 0) * 1000,
    });
    hideLoginError();
    showAppShell();
    await refreshAvailablePredictionFamilies();
    showToast('登录成功', 'success');
    resolveRoute();
  } catch (err) {
    if (isSetupRequiredError(err)) {
      showLoginError('服务端尚未初始化，请先访问 ' + String(err.setup_url || '/setup') + ' 完成安装');
    } else {
      showLoginError('登录失败：' + String(err.message || err));
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (submitText) submitText.textContent = '登 录';
    if (spinner) spinner.classList.add('hidden');
  }
}

async function logout() {
  try {
    if (getAccessToken()) {
      await apiFetch('/v1/auth/logout', { method: 'POST' });
    }
  } catch (_) {
    // ignore logout network failures and clear local state anyway
  } finally {
    clearAuthState();
    showLoginScreen();
    showToast('已退出登录', 'success');
  }
}

async function ensureAuthSession() {
  const token = getAccessToken();
  if (!token) {
    renderAuthState();
    return;
  }
  try {
    const me = await apiFetch('/v1/auth/me');
    saveAuthState({
      access_token: token,
      username: me.username || authState.username,
      role: me.role || authState.role,
      expires_at: authState.expires_at,
    });
  } catch (_) {
    clearAuthState();
  }
}

// ===== API fetch helper =====
async function apiFetch(path, options = {}) {
  const url = buildApiUrl(path, options.query || {});
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const useAuth = options.auth !== false;
  const token = useAuth ? getAccessToken() : '';
  if (token) {
    headers.Authorization = 'Bearer ' + token;
  }
  const fetchOptions = {
    method: options.method || 'GET',
    headers: headers,
    cache: options.cache || 'default',
  };
  if (options.body !== undefined) {
    fetchOptions.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }
  const resp = await fetch(url, fetchOptions);
  let data = null;
  try {
    data = await resp.json();
  } catch (_) {
    data = {};
  }
  if (!resp.ok) {
    const detail = data && data.detail ? data.detail : ('请求失败 (HTTP ' + resp.status + ')');
    if (resp.status === 503 && isSetupRequiredPayload(data)) {
      throw createSetupRequiredError(detail, settings.api_base || DEFAULT_SETTINGS.api_base);
    }
    if (resp.status === 401) {
      clearAuthState();
      if (!String(path || '').startsWith('/v1/auth/')) {
        setTimeout(showLoginScreen, 0);
      }
      throw new Error('请先登录后继续操作');
    }
    if (resp.status === 403) {
      throw new Error('权限不足：' + detail);
    }
    throw new Error(detail);
  }
  return data;
}

async function apiFetchBlob(path, options = {}) {
  const url = buildApiUrl(path, options.query || {});
  const headers = { ...(options.headers || {}) };
  const useAuth = options.auth !== false;
  const token = useAuth ? getAccessToken() : '';
  if (token) {
    headers.Authorization = 'Bearer ' + token;
  }
  const fetchOptions = {
    method: options.method || 'GET',
    headers: headers,
    cache: options.cache || 'default',
  };
  if (options.body !== undefined) {
    fetchOptions.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }
  }
  const resp = await fetch(url, fetchOptions);
  if (!resp.ok) {
    var detail = '请求失败 (HTTP ' + resp.status + ')';
    var data = null;
    try {
      data = await resp.json();
      if (data && data.detail) detail = String(data.detail);
    } catch (_) {}
    if (resp.status === 503 && isSetupRequiredPayload(data)) {
      throw createSetupRequiredError(detail, settings.api_base || DEFAULT_SETTINGS.api_base);
    }
    if (resp.status === 401) {
      clearAuthState();
      if (!String(path || '').startsWith('/v1/auth/')) {
        setTimeout(showLoginScreen, 0);
      }
      throw new Error('请先登录后继续操作');
    }
    if (resp.status === 403) {
      throw new Error('权限不足：' + detail);
    }
    throw new Error(detail);
  }
  return resp.blob();
}

// ===== Settings =====
function loadSettings() {
  try {
    let parsed = null;
    for (const key of [STORAGE_KEY, ...LEGACY_STORAGE_KEYS]) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try { parsed = JSON.parse(raw); break; } catch (_) {}
    }

    if (parsed) {
      settings = {
        api_base: normalizeApiBase(parsed.api_base || DEFAULT_SETTINGS.api_base) || DEFAULT_SETTINGS.api_base,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    }
  } catch (_) {}
}

function _normalizeHorizonList(value) {
  if (!Array.isArray(value)) return [...DEFAULT_DOCTOR_PREFS.default_horizons];
  var out = Array.from(new Set(value.map(function(x) { return Number(x); }).filter(function(x) {
    return Number.isInteger(x) && x >= 1 && x <= 5;
  }))).sort(function(a, b) { return a - b; });
  if (!out.length) return [...DEFAULT_DOCTOR_PREFS.default_horizons];
  return out;
}

function sanitizeDoctorPrefs(raw) {
  var src = raw || {};
  var tableDensity = src.table_density === 'compact' ? 'compact' : 'standard';
  var fontSize = src.font_size === 'large' ? 'large' : 'normal';
  return {
    default_horizons: _normalizeHorizonList(src.default_horizons),
    table_density: tableDensity,
    font_size: fontSize,
    autosave_encounter_draft: src.autosave_encounter_draft !== false,
    confirm_before_submit: src.confirm_before_submit !== false,
  };
}

function loadDoctorPrefs() {
  try {
    var raw = localStorage.getItem(DOCTOR_PREFS_KEY);
    if (!raw) {
      doctorPrefs = { ...DEFAULT_DOCTOR_PREFS };
      return;
    }
    doctorPrefs = sanitizeDoctorPrefs(JSON.parse(raw));
  } catch (_) {
    doctorPrefs = { ...DEFAULT_DOCTOR_PREFS };
  }
}

function saveDoctorPrefs(nextPrefs) {
  doctorPrefs = sanitizeDoctorPrefs(nextPrefs);
  localStorage.setItem(DOCTOR_PREFS_KEY, JSON.stringify(doctorPrefs));
  applyDoctorPrefs();
}

function applyDoctorPrefs() {
  var body = document.body;
  if (!body) return;
  body.classList.toggle('doctor-density-compact', doctorPrefs.table_density === 'compact');
  body.classList.toggle('doctor-font-large', doctorPrefs.font_size === 'large');
}

function getPreferredDefaultHorizons(maxH) {
  var limit = Math.max(1, Math.min(Number(maxH || 5), 5));
  var hs = _normalizeHorizonList(doctorPrefs.default_horizons).filter(function(h) { return h <= limit; });
  if (!hs.length) {
    hs = [];
    for (var i = 1; i <= limit; i++) hs.push(i);
  }
  return hs;
}

function normalizePredictionFamilies(raw) {
  var input = Array.isArray(raw) ? raw : [];
  var normalized = Array.from(new Set(input
    .map(function(x) { return String(x || '').trim().toLowerCase(); })
    .filter(function(x) { return x === 'xu' || x === 'fen' || x === 'feng'; })));
  var order = { xu: 0, fen: 1, feng: 2 };
  normalized.sort(function(a, b) { return order[a] - order[b]; });
  if (!normalized.length) return ['xu'];
  return normalized;
}

function setAvailablePredictionFamilies(raw) {
  availablePredictionModelFamilies = normalizePredictionFamilies(raw);
}

function getActivePredictionFamilies() {
  return normalizePredictionFamilies(availablePredictionModelFamilies);
}

async function refreshAvailablePredictionFamilies() {
  try {
    var mdata = await apiFetch('/model-info');
    var familyGroups = mdata && mdata.family_groups && typeof mdata.family_groups === 'object'
      ? mdata.family_groups
      : {};
    var familyKeys = Object.keys(familyGroups);
    if (!familyKeys.length) {
      var groups = mdata && mdata.groups && typeof mdata.groups === 'object' ? mdata.groups : {};
      if (Object.keys(groups).length > 0) familyKeys = ['xu'];
    }
    setAvailablePredictionFamilies(familyKeys);
  } catch (_) {
    setAvailablePredictionFamilies(['xu']);
  }
}

function confirmSubmitIfNeeded(message) {
  if (!doctorPrefs.confirm_before_submit) return true;
  return window.confirm(String(message || '确认提交本次操作？'));
}

// ===== Health check =====
async function checkHealth() {
  const badge = $('status-badge');
  const statusText = $('status-text');
  if (!badge) return;
  badge.className = 'status-badge status-checking';
  if (statusText) statusText.textContent = '检测中…';
  try {
    const resp = await fetch(buildApiUrl('/healthz'), { cache: 'no-store' });
    let data = {};
    try {
      data = await resp.json();
    } catch (_) {}
    if (resp.ok) {
      if (isSetupRequiredPayload(data)) {
        badge.className = 'status-badge status-error';
        if (statusText) statusText.textContent = '待初始化';
      } else {
        badge.className = 'status-badge status-ok';
        if (statusText) statusText.textContent = '已连接';
      }
    } else {
      badge.className = 'status-badge status-error';
      if (statusText) statusText.textContent = '连接异常';
    }
  } catch (_) {
    badge.className = 'status-badge status-error';
    if (statusText) statusText.textContent = '未连接';
  }
}

// ===== Toast =====
function showToast(message, type, duration) {
  type = type || 'success';
  duration = duration || 3000;
  const root = $('toast-root');
  if (!root) return;
  const toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.textContent = message;
  root.appendChild(toast);
  setTimeout(function() {
    toast.style.animation = 'toast-out .25s ease forwards';
    setTimeout(function() { toast.remove(); }, 250);
  }, duration);
}

// ===== Modal =====
function showModal(title, bodyHTML, footerHTML) {
  footerHTML = footerHTML || '';
  const root = $('modal-root');
  if (!root) return;
  root.innerHTML =
    '<div class="modal-overlay" id="modal-overlay">' +
      '<div class="modal">' +
        '<div class="modal-header">' +
          '<span class="modal-title">' + escHtml(title) + '</span>' +
          '<button class="modal-close" id="modal-close-btn" title="关闭">' +
            '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
              '<line x1="1" y1="1" x2="13" y2="13"/>' +
              '<line x1="13" y1="1" x2="1" y2="13"/>' +
            '</svg>' +
          '</button>' +
        '</div>' +
        '<div class="modal-body">' + bodyHTML + '</div>' +
        (footerHTML ? '<div class="modal-footer">' + footerHTML + '</div>' : '') +
      '</div>' +
    '</div>';
  $('modal-close-btn').addEventListener('click', closeModal);
  $('modal-overlay').addEventListener('click', function(e) {
    if (e.target === $('modal-overlay')) closeModal();
  });
}

function closeModal() {
  if (_activePreviewObjectUrl) {
    try { URL.revokeObjectURL(_activePreviewObjectUrl); } catch (_) {}
    _activePreviewObjectUrl = '';
  }
  const root = $('modal-root');
  if (root) root.innerHTML = '';
}

async function previewImageAsset(fileAssetId, title) {
  var id = Number(fileAssetId);
  if (!Number.isInteger(id) || id <= 0) {
    showToast('图像ID无效，无法预览', 'error');
    return;
  }
  showModal(
    title || '查看眼底图像',
    '<div class="et-loading"><div class="spinner-lg"></div> 加载图像中…</div>',
    '<button class="btn btn-primary" onclick="closeModal()">关闭</button>'
  );
  var modalEl = document.querySelector('.modal');
  if (modalEl) modalEl.classList.add('modal-wide');
  try {
    var blob = await apiFetchBlob('/v1/clinical/files/' + id + '/content', { cache: 'no-store' });
    if (_activePreviewObjectUrl) {
      try { URL.revokeObjectURL(_activePreviewObjectUrl); } catch (_) {}
      _activePreviewObjectUrl = '';
    }
    _activePreviewObjectUrl = URL.createObjectURL(blob);
    var bodyEl = document.querySelector('.modal-body');
    if (!bodyEl) return;
    bodyEl.innerHTML =
      '<div class="asset-preview-wrap">' +
        '<img class="asset-preview-image" src="' + escHtml(_activePreviewObjectUrl) + '" alt="眼底图像预览" />' +
      '</div>' +
      '<div class="asset-preview-meta">图像ID: <code>' + escHtml(String(id)) + '</code></div>';
  } catch (err) {
    var bodyErr = document.querySelector('.modal-body');
    if (bodyErr) bodyErr.innerHTML = '<div class="error-msg">图像加载失败：' + escHtml(String(err.message || err)) + '</div>';
  }
}

// ===== Utility =====
function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(str) {
  if (!str) return '—';
  try {
    return new Date(str).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch (_) { return str; }
}

function formatDateTime(str) {
  if (!str) return '—';
  try {
    return new Date(str).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch (_) { return str; }
}

// ===== Router =====
var routes = {
  '/dashboard': renderDashboard,
  '/patients': renderPatients,
  '/patients/:id': renderPatientDetail,
  '/encounters': renderEncounters,
  '/predict': renderQuickPredict,
  '/system': renderSystem,
};

function navigate(path) {
  window.location.hash = '#' + path;
}

function resolveRoute() {
  const hash = window.location.hash || '#/dashboard';
  const path = hash.replace(/^#/, '');

  var handler = null;
  var params = {};

  var patterns = Object.keys(routes);
  for (var i = 0; i < patterns.length; i++) {
    var pattern = patterns[i];
    var match = matchRoute(pattern, path);
    if (match !== null) {
      handler = routes[pattern];
      params = match;
      break;
    }
  }

  document.querySelectorAll('.nav-item').forEach(function(el) {
    el.classList.remove('active');
    var route = el.dataset.route;
    if (route && (path === route || (path.startsWith(route + '/') && route !== '/'))) {
      el.classList.add('active');
    }
  });

  const content = $('content-area');
  if (!content) return;

  if (handler) {
    handler(params);
  } else {
    renderDashboard({});
  }
}

function matchRoute(pattern, path) {
  var patternParts = pattern.split('/').filter(Boolean);
  var pathParts = path.split('/').filter(Boolean);

  if (patternParts.length !== pathParts.length) return null;

  var params = {};
  for (var i = 0; i < patternParts.length; i++) {
    if (patternParts[i].charAt(0) === ':') {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

// ===== Page: Dashboard =====
async function renderDashboard() {
  const content = $('content-area');
  content.innerHTML =
    '<div class="page-wrap">' +
      '<div class="page-header">' +
        '<div>' +
          '<h1 class="page-title">' +
            '<svg class="page-title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>' +
            '仪表盘' +
          '</h1>' +
          '<p class="page-subtitle">系统概览与快速入口</p>' +
        '</div>' +
        '<div class="page-actions">' +
          '<button class="btn btn-outline btn-sm" id="dash-refresh">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>' +
            '刷新' +
          '</button>' +
        '</div>' +
      '</div>' +
      '<div class="stat-grid">' +
        '<div class="stat-card"><div class="stat-icon-wrap stat-icon-blue"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div><div class="stat-content"><div class="stat-value" id="dash-status-val">—</div><div class="stat-label">连接状态</div></div></div>' +
        '<div class="stat-card"><div class="stat-icon-wrap stat-icon-teal"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 2h8l2 4-6 8-6-8z"/><line x1="4" y1="6" x2="12" y2="6"/></svg></div><div class="stat-content"><div class="stat-value" id="dash-model-count">—</div><div class="stat-label">可用模型数</div></div></div>' +
        '<div class="stat-card"><div class="stat-icon-wrap stat-icon-green"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/></svg></div><div class="stat-content"><div class="stat-value" id="dash-max-visits">—</div><div class="stat-label">最大随访次数</div></div></div>' +
        '<div class="stat-card"><div class="stat-icon-wrap stat-icon-amber"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></div><div class="stat-content"><div class="stat-value" id="dash-device">—</div><div class="stat-label">默认推理设备</div></div></div>' +
      '</div>' +
      '<div class="page-header" style="margin-bottom:12px"><h2 style="font-size:15px;font-weight:700;color:var(--slate-700)">快速入口</h2></div>' +
      '<div class="quick-actions" style="margin-bottom:24px">' +
        '<button class="quick-action-btn" onclick="navigate(\'/patients\')"><div class="quick-action-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/><line x1="19" y1="8" x2="23" y2="8"/><line x1="21" y1="6" x2="21" y2="10"/></svg></div><span class="quick-action-label">新建患者</span></button>' +
        '<button class="quick-action-btn" onclick="navigate(\'/encounters\')"><div class="quick-action-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/></svg></div><span class="quick-action-label">录入就诊</span></button>' +
        '<button class="quick-action-btn" onclick="navigate(\'/predict\')"><div class="quick-action-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg></div><span class="quick-action-label">快速预测</span></button>' +
      '</div>' +
      '<div class="info-card"><div class="info-card-header"><span class="info-card-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>路由规则（随访次数 → 可预测时间点）</span></div><div class="info-card-body" id="routing-rules-body"><div class="et-loading"><div class="spinner-lg"></div> 加载中…</div></div></div>' +
    '</div>';

  $('dash-refresh').addEventListener('click', function() {
    renderDashboard();
    checkHealth();
  });

  try {
    const data = await apiFetch('/healthz', { cache: 'no-store' });
    $('dash-status-val').innerHTML = '<span class="badge badge-green">在线</span>';
    $('dash-model-count').textContent = data.model_count != null ? data.model_count : '—';
    $('dash-max-visits').textContent = (data.limits && data.limits.max_visits != null) ? data.limits.max_visits : '—';
    $('dash-device').textContent = data.default_device || '—';
  } catch (err) {
    $('dash-status-val').innerHTML = '<span class="badge badge-red">离线</span>';
    showToast('无法连接到后端：' + err.message, 'error');
  }

  try {
    const rr = await apiFetch('/routing-rules');
    const rules = rr.rules || {};
    const keys = Object.keys(rules).sort(function(a, b) { return Number(a) - Number(b); });
    if (keys.length === 0) {
      $('routing-rules-body').innerHTML = '<div class="et-empty">暂无路由规则</div>';
    } else {
      var rows = '';
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var horizons = (rules[k] || []).map(function(h) { return '<span class="badge badge-blue" style="margin:1px">' + h + '</span>'; }).join(' ');
        rows += '<tr><td><strong>' + escHtml(k) + '</strong> 次随访</td><td>' + horizons + '</td></tr>';
      }
      $('routing-rules-body').innerHTML = '<table class="rules-table"><thead><tr><th>随访次数</th><th>可预测时间点</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }
  } catch (err) {
    $('routing-rules-body').innerHTML = '<div class="et-empty text-muted">加载失败：' + escHtml(err.message) + '</div>';
  }
}

// ===== Page: Patients =====
var _allPatients = [];

async function renderPatients(params) {
  params = params || {};
  const searchQuery = params.q || '';
  const content = $('content-area');
  content.innerHTML =
    '<div class="page-wrap">' +
      '<div class="page-header">' +
        '<div><h1 class="page-title"><svg class="page-title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>患者管理</h1></div>' +
        '<div class="page-actions"><button class="btn btn-primary" id="new-patient-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>新建患者</button></div>' +
      '</div>' +
      '<div class="entity-table">' +
        '<div class="et-toolbar">' +
          '<div class="et-search-wrap"><svg class="et-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><input id="patient-search" class="et-search" type="text" placeholder="搜索姓名或编号…" value="' + escHtml(searchQuery) + '" autocomplete="off" /></div>' +
          '<span id="patient-count" class="text-muted text-sm"></span>' +
        '</div>' +
        '<div class="et-table-scroll" id="patients-table-wrap"><div class="et-loading"><div class="spinner-lg"></div> 加载中…</div></div>' +
      '</div>' +
    '</div>';

  $('new-patient-btn').addEventListener('click', openNewPatientModal);
  $('patient-search').addEventListener('input', function(e) {
    renderPatientsTable(e.target.value.trim());
  });

  try {
    _allPatients = await apiFetch('/v1/clinical/patients', { query: { limit: 50, offset: 0 } });
    renderPatientsTable(searchQuery);
  } catch (err) {
    $('patients-table-wrap').innerHTML = '<div class="et-empty text-muted">加载失败：' + escHtml(err.message) + '</div>';
  }
}

function renderPatientsTable(query) {
  query = query || '';
  var q = query.toLowerCase();
  var filtered = q
    ? _allPatients.filter(function(p) {
        return (p.patient_code || '').toLowerCase().includes(q) || (p.full_name || '').toLowerCase().includes(q);
      })
    : _allPatients;

  var countEl = $('patient-count');
  if (countEl) countEl.textContent = '共 ' + filtered.length + ' 位患者';

  var wrap = $('patients-table-wrap');
  if (!wrap) return;

  if (filtered.length === 0) {
    wrap.innerHTML = '<div class="et-empty">暂无患者记录</div>';
    return;
  }

  function sexLabel(s) { return s === 'M' ? '男' : s === 'F' ? '女' : s || '—'; }

  var rows = filtered.map(function(p) {
    return '<tr>' +
      '<td><code style="font-size:12px;color:var(--slate-600)">' + escHtml(p.patient_code || '—') + '</code></td>' +
      '<td><strong>' + escHtml(p.full_name || '—') + '</strong></td>' +
      '<td>' + escHtml(sexLabel(p.sex)) + '</td>' +
      '<td>' + escHtml(formatDate(p.birth_date)) + '</td>' +
      '<td><span class="text-muted text-sm">' + escHtml(formatDateTime(p.created_at)) + '</span></td>' +
      '<td><button class="btn btn-sm btn-outline" onclick="navigate(\'/patients/' + escHtml(String(p.id)) + '\')">查看</button></td>' +
      '</tr>';
  }).join('');

  wrap.innerHTML =
    '<table class="et-table">' +
      '<thead><tr><th>患者编号</th><th>姓名</th><th>性别</th><th>出生日期</th><th>创建时间</th><th>操作</th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
    '</table>';
}

function openNewPatientModal() {
  var bodyHTML =
    '<div class="form-field mb-12">' +
      '<label class="form-label">患者编号 <span style="color:var(--red-500)">*</span></label>' +
      '<input id="modal-patient-code" class="form-input" type="text" placeholder="例如 P20240001" autocomplete="off" />' +
      '<span class="form-hint">唯一标识符，建议使用字母+日期格式</span>' +
    '</div>' +
    '<div class="form-row">' +
      '<div class="form-field"><label class="form-label">姓名 <span class="optional">可选</span></label><input id="modal-full-name" class="form-input" type="text" placeholder="患者姓名" autocomplete="off" /></div>' +
      '<div class="form-field"><label class="form-label">性别 <span class="optional">可选</span></label><select id="modal-sex" class="form-input"><option value="">未填写</option><option value="M">男</option><option value="F">女</option><option value="O">其他</option></select></div>' +
    '</div>' +
    '<div class="form-field"><label class="form-label">出生日期 <span class="optional">可选</span></label><input id="modal-birth-date" class="form-input" type="date" /></div>' +
    '<div id="modal-error" class="error-msg hidden" style="margin-top:10px"></div>';

  var footerHTML =
    '<button class="btn btn-outline" onclick="closeModal()">取消</button>' +
    '<button class="btn btn-primary" id="modal-submit-patient">创建患者</button>';

  showModal('新建患者', bodyHTML, footerHTML);

  $('modal-submit-patient').addEventListener('click', async function() {
    var code = ($('modal-patient-code').value || '').trim();
    if (!code) {
      $('modal-error').textContent = '患者编号不能为空';
      $('modal-error').classList.remove('hidden');
      return;
    }
    var payload = { patient_code: code };
    var name = ($('modal-full-name').value || '').trim();
    var sex = $('modal-sex').value;
    var birth = $('modal-birth-date').value;
    if (name) payload.full_name = name;
    if (sex) payload.sex = sex;
    if (birth) payload.birth_date = birth;

    var btn = $('modal-submit-patient');
    btn.disabled = true;
    btn.textContent = '创建中…';

    try {
      await apiFetch('/v1/clinical/patients', { method: 'POST', body: payload });
      closeModal();
      showToast('患者 ' + code + ' 创建成功', 'success');
      _allPatients = await apiFetch('/v1/clinical/patients', { query: { limit: 50, offset: 0 } });
      renderPatientsTable($('patient-search') ? $('patient-search').value : '');
      var countEl = $('patient-count');
      if (countEl) countEl.textContent = '共 ' + _allPatients.length + ' 位患者';
    } catch (err) {
      var errEl = $('modal-error');
      if (errEl) { errEl.textContent = err.message; errEl.classList.remove('hidden'); }
      btn.disabled = false;
      btn.textContent = '创建患者';
    }
  });
}

function getPredictionWorstSe(predictions) {
  var values = Object.values(predictions || {})
    .map(function(v) { return Number(v); })
    .filter(function(v) { return Number.isFinite(v); });
  if (!values.length) return null;
  return Math.min.apply(null, values);
}

function parsePredictionHorizon(rawKey) {
  var text = String(rawKey == null ? '' : rawKey).trim().toLowerCase();
  var m = text.match(/(\d+)/);
  if (!m) return null;
  var h = Number(m[1]);
  return Number.isInteger(h) && h > 0 ? h : null;
}

function mapEntriesByHorizon(obj) {
  return Object.entries(obj || {})
    .map(function(item) {
      return { horizon: parsePredictionHorizon(item[0]), value: item[1] };
    })
    .filter(function(item) { return item.horizon != null; })
    .sort(function(a, b) { return itemNum(a.horizon) - itemNum(b.horizon); });
}

function itemNum(value) {
  return Number(value) || 0;
}

function pickValueByHorizon(obj, horizon) {
  if (!obj || typeof obj !== 'object') return undefined;
  var keyStd = 't+' + horizon;
  if (Object.prototype.hasOwnProperty.call(obj, keyStd)) return obj[keyStd];
  var keyNum = String(horizon);
  if (Object.prototype.hasOwnProperty.call(obj, keyNum)) return obj[keyNum];
  return obj[horizon];
}

function clamp(value, minValue, maxValue) {
  if (!Number.isFinite(value)) return minValue;
  if (value < minValue) return minValue;
  if (value > maxValue) return maxValue;
  return value;
}

function renderXuTrendChart(entries) {
  var points = (entries || []).filter(function(item) {
    return Number.isFinite(Number(item && item.value)) && Number.isFinite(Number(item && item.horizon));
  });
  if (!points.length) return '<div class="et-empty">暂无趋势图数据</div>';

  var width = 480;
  var height = 220;
  var padLeft = 46;
  var padRight = 16;
  var padTop = 36;
  var padBottom = 34;
  var plotW = width - padLeft - padRight;
  var plotH = height - padTop - padBottom;
  var values = points.map(function(p) { return Number(p.value); });
  var minV = Math.min.apply(null, values);
  var maxV = Math.max.apply(null, values);
  if (!Number.isFinite(minV) || !Number.isFinite(maxV)) return '<div class="et-empty">暂无趋势图数据</div>';
  if (Math.abs(maxV - minV) < 0.05) {
    minV -= 0.5;
    maxV += 0.5;
  } else {
    var pad = (maxV - minV) * 0.25;
    minV -= pad;
    maxV += pad;
  }

  var chartId = 'xu-grad-' + Math.random().toString(36).slice(2, 8);

  function xAt(idx) {
    if (points.length === 1) return padLeft + plotW / 2;
    return padLeft + (plotW * idx / (points.length - 1));
  }
  function yAt(value) {
    var ratio = (value - minV) / (maxV - minV);
    return padTop + (1 - ratio) * plotH;
  }

  var yTicks = [];
  for (var i = 0; i <= 4; i++) {
    var rv = minV + (maxV - minV) * (i / 4);
    var yy = yAt(rv);
    yTicks.push(
      '<line x1="' + padLeft + '" y1="' + yy.toFixed(2) + '" x2="' + (width - padRight) + '" y2="' + yy.toFixed(2) + '" stroke="#f1f5f9" stroke-width="1"/>' +
      '<text x="' + (padLeft - 10) + '" y="' + (yy + 4).toFixed(2) + '" text-anchor="end" font-size="10" fill="#94a3b8" font-family="system-ui,sans-serif">' + rv.toFixed(2) + '</text>'
    );
  }

  var xLabels = points.map(function(item, idx) {
    var xx = xAt(idx);
    return '<text x="' + xx.toFixed(2) + '" y="' + (height - 10) + '" text-anchor="middle" font-size="10.5" fill="#94a3b8" font-family="system-ui,sans-serif">t+' + item.horizon + '</text>';
  }).join('');

  var polyline = points.map(function(item, idx) {
    return xAt(idx).toFixed(2) + ',' + yAt(Number(item.value)).toFixed(2);
  }).join(' ');

  // area fill polygon
  var areaPath = '';
  if (points.length > 1) {
    areaPath = points.map(function(item, idx) {
      return xAt(idx).toFixed(2) + ',' + yAt(Number(item.value)).toFixed(2);
    }).join(' ');
    var baseY = (height - padBottom).toFixed(2);
    areaPath = xAt(0).toFixed(2) + ',' + baseY + ' ' + areaPath + ' ' + xAt(points.length - 1).toFixed(2) + ',' + baseY;
  }

  var pointDots = points.map(function(item, idx) {
    var xx = xAt(idx);
    var yy = yAt(Number(item.value));
    return (
      '<circle cx="' + xx.toFixed(2) + '" cy="' + yy.toFixed(2) + '" r="5" fill="white" stroke="#4f46e5" stroke-width="2.5"/>' +
      '<rect x="' + (xx - 20).toFixed(2) + '" y="' + (yy - 24).toFixed(2) + '" width="40" height="17" rx="8.5" fill="#4f46e5"/>' +
      '<text x="' + xx.toFixed(2) + '" y="' + (yy - 12.5).toFixed(2) + '" text-anchor="middle" font-size="10" fill="#ffffff" font-weight="600" font-family="system-ui,sans-serif">' + Number(item.value).toFixed(2) + '</text>'
    );
  }).join('');

  var gradientDef =
    '<defs>' +
      '<linearGradient id="' + chartId + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="#4f46e5" stop-opacity="0.18"/>' +
        '<stop offset="100%" stop-color="#4f46e5" stop-opacity="0.02"/>' +
      '</linearGradient>' +
    '</defs>';

  return (
    '<div class="pred-chart-wrap">' +
      '<div class="pred-chart-title"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="2 14 7 9 11 12 18 5"/><polyline points="14 5 18 5 18 9"/></svg>SE 趋势预测</div>' +
      '<svg class="pred-chart-svg" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Xu 预测趋势图">' +
        gradientDef +
        yTicks.join('') +
        (areaPath ? '<polygon points="' + areaPath + '" fill="url(#' + chartId + ')"/>' : '') +
        '<polyline points="' + polyline + '" fill="none" stroke="#4f46e5" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>' +
        pointDots +
        xLabels +
      '</svg>' +
      '<div class="pred-chart-caption">纵轴：球镜当量 SE（D）</div>' +
    '</div>'
  );
}

function renderRiskProbabilityChart(points, threshold) {
  var items = (points || []).filter(function(item) {
    return Number.isFinite(Number(item && item.horizon)) && Number.isFinite(Number(item && item.probability));
  });
  if (!items.length) return '<div class="et-empty">暂无风险图数据</div>';

  var width = 480;
  var height = 220;
  var padLeft = 46;
  var padRight = 16;
  var padTop = 34;
  var padBottom = 34;
  var plotW = width - padLeft - padRight;
  var plotH = height - padTop - padBottom;
  var slotW = plotW / items.length;
  var barW = Math.min(48, slotW * 0.55);
  var barR = Math.min(8, barW / 2);
  var thresholdValue = Number.isFinite(Number(threshold)) ? clamp(Number(threshold), 0, 1) : null;

  var chartId = 'risk-grad-' + Math.random().toString(36).slice(2, 8);

  function yAt(rate01) {
    return padTop + (1 - clamp(rate01, 0, 1)) * plotH;
  }

  var gradients = '<defs>' +
    '<linearGradient id="' + chartId + '-green" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#22c55e" stop-opacity="0.9"/>' +
      '<stop offset="100%" stop-color="#22c55e" stop-opacity="0.55"/>' +
    '</linearGradient>' +
    '<linearGradient id="' + chartId + '-red" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#ef4444" stop-opacity="0.9"/>' +
      '<stop offset="100%" stop-color="#ef4444" stop-opacity="0.55"/>' +
    '</linearGradient>' +
  '</defs>';

  var yTicks = [0, 0.25, 0.5, 0.75, 1].map(function(v) {
    var yy = yAt(v);
    return (
      '<line x1="' + padLeft + '" y1="' + yy.toFixed(2) + '" x2="' + (width - padRight) + '" y2="' + yy.toFixed(2) + '" stroke="#f1f5f9" stroke-width="1"/>' +
      '<text x="' + (padLeft - 10) + '" y="' + (yy + 4).toFixed(2) + '" text-anchor="end" font-size="10" fill="#94a3b8" font-family="system-ui,sans-serif">' + Math.round(v * 100) + '%</text>'
    );
  }).join('');

  var bars = items.map(function(item, idx) {
    var p = clamp(Number(item.probability), 0, 1);
    var xx = padLeft + slotW * idx + (slotW - barW) / 2;
    var yy = yAt(p);
    var isHigh = item.labelValue === 1;
    var gradRef = isHigh ? 'url(#' + chartId + '-red)' : 'url(#' + chartId + '-green)';
    var labelBg = isHigh ? '#ef4444' : '#22c55e';

    // Rounded top bar using path
    var barPath = 'M' + xx.toFixed(2) + ',' + (height - padBottom).toFixed(2) +
      ' V' + (yy + barR).toFixed(2) +
      ' Q' + xx.toFixed(2) + ',' + yy.toFixed(2) + ' ' + (xx + barR).toFixed(2) + ',' + yy.toFixed(2) +
      ' H' + (xx + barW - barR).toFixed(2) +
      ' Q' + (xx + barW).toFixed(2) + ',' + yy.toFixed(2) + ' ' + (xx + barW).toFixed(2) + ',' + (yy + barR).toFixed(2) +
      ' V' + (height - padBottom).toFixed(2) + ' Z';

    var cx = xx + barW / 2;
    var pillW = 38;
    return (
      '<path d="' + barPath + '" fill="' + gradRef + '"/>' +
      '<rect x="' + (cx - pillW / 2).toFixed(2) + '" y="' + (yy - 22).toFixed(2) + '" width="' + pillW + '" height="16" rx="8" fill="' + labelBg + '"/>' +
      '<text x="' + cx.toFixed(2) + '" y="' + (yy - 11).toFixed(2) + '" text-anchor="middle" font-size="9.5" fill="#fff" font-weight="600" font-family="system-ui,sans-serif">' + (p * 100).toFixed(1) + '%</text>' +
      '<text x="' + cx.toFixed(2) + '" y="' + (height - 10) + '" text-anchor="middle" font-size="10.5" fill="#94a3b8" font-family="system-ui,sans-serif">t+' + item.horizon + '</text>'
    );
  }).join('');

  var thresholdLine = '';
  var thresholdLabel = '';
  if (thresholdValue != null) {
    var ty = yAt(thresholdValue);
    thresholdLine =
      '<line x1="' + padLeft + '" y1="' + ty.toFixed(2) + '" x2="' + (width - padRight) + '" y2="' + ty.toFixed(2) + '" stroke="#f59e0b" stroke-width="1.8" stroke-dasharray="6 4"/>' +
      '<rect x="' + (width - padRight - 42) + '" y="' + (ty - 9).toFixed(2) + '" width="38" height="16" rx="8" fill="#fffbeb" stroke="#f59e0b" stroke-width="0.8"/>' +
      '<text x="' + (width - padRight - 23) + '" y="' + (ty + 3).toFixed(2) + '" text-anchor="middle" font-size="9" fill="#d97706" font-weight="600" font-family="system-ui,sans-serif">' + (thresholdValue * 100).toFixed(0) + '%</text>';
    thresholdLabel =
      '<div class="pred-chart-note"><span class="pred-chart-note-dot"></span>阈值：' + (thresholdValue * 100).toFixed(0) + '%</div>';
  }

  return (
    '<div class="pred-chart-wrap">' +
      '<div class="pred-chart-title"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="10" width="4" height="7" rx="1"/><rect x="8" y="6" width="4" height="11" rx="1"/><rect x="13" y="3" width="4" height="14" rx="1"/></svg>风险概率分布</div>' +
      '<svg class="pred-chart-svg" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="风险概率图">' +
        gradients +
        yTicks +
        thresholdLine +
        bars +
      '</svg>' +
      '<div class="pred-chart-footer">' +
        '<div class="pred-chart-legend">' +
          '<span><i class="dot dot-green"></i>低风险</span>' +
          '<span><i class="dot dot-red"></i>高风险</span>' +
        '</div>' +
        thresholdLabel +
      '</div>' +
    '</div>'
  );
}

function normalizePredictionFamilyResults(run) {
  if (run && run.family_results && typeof run.family_results === 'object') {
    return run.family_results;
  }
  if ((run && run.models && Object.keys(run.models).length) || (run && run.predictions && Object.keys(run.predictions).length)) {
    return {
      xu: {
        kind: 'regression',
        models: run.models || {},
        predictions: run.predictions || {},
      },
    };
  }
  return {};
}

function getRequestedPredictionFamilies(run) {
  var raw = Array.isArray(run && run.requested_model_families) ? run.requested_model_families : [];
  var normalized = Array.from(new Set(raw
    .map(function(x) { return String(x || '').trim().toLowerCase(); })
    .filter(function(x) { return !!x; })));
  if (normalized.length) return normalized;
  var families = Object.keys(normalizePredictionFamilyResults(run));
  if (families.length) return families;
  return [];
}

function getXuPredictions(run) {
  var families = normalizePredictionFamilyResults(run);
  var xu = families.xu || {};
  var map = xu.predictions || run.predictions || {};
  if (!map || typeof map !== 'object') return {};
  return map;
}

function getPredictionWorstSeForRun(run) {
  return getPredictionWorstSe(getXuPredictions(run));
}

function formatPredictionHorizon(run) {
  var hs = (run.used_horizons && run.used_horizons.length ? run.used_horizons : run.requested_horizons) || [];
  if (!hs.length) return '—';
  return hs.map(function(h) { return 't+' + h; }).join(', ');
}

function formatPredictionModels(run) {
  var families = getRequestedPredictionFamilies(run);
  if (!families.length) return '—';
  return families.map(function(family) {
    return PREDICTION_FAMILY_LABELS[family] || family;
  }).join(' / ');
}

function showPredictionRunDetailModal(run) {
  var families = normalizePredictionFamilyResults(run);
  var requestedFamilies = getRequestedPredictionFamilies(run);
  var familyOrder = { xu: 0, fen: 1, feng: 2 };

  function renderModelSummary(models) {
    var names = Object.values(models || {}).filter(function(x) { return !!x; });
    if (!names.length) return '—';
    return escHtml(names.join(' / '));
  }

  function renderXuSection(data) {
    if (!data) return '';
    var trendEntries = mapEntriesByHorizon(data.predictions || {})
      .map(function(item) {
        return { horizon: item.horizon, value: Number(item.value) };
      })
      .filter(function(item) { return Number.isFinite(item.value); });
    var chartHTML = renderXuTrendChart(trendEntries);
    var predItems = trendEntries
      .map(function(item) {
        var txt = item.value.toFixed(2) + ' D';
        return '<div class="kv-item"><span class="kv-key">t+' + item.horizon + '</span><span class="kv-value"><strong>' + escHtml(txt) + '</strong></span></div>';
      })
      .join('') || '<div class="et-empty">暂无定量预测值</div>';
    return (
      '<div class="info-card" style="margin-top:10px">' +
        '<div class="info-card-header"><span class="info-card-title">Xu 定量预测</span></div>' +
        '<div class="info-card-body">' +
          '<div class="kv-list">' +
            '<div class="kv-item"><span class="kv-key">模型版本</span><span class="kv-value">' + renderModelSummary(data.models || {}) + '</span></div>' +
          '</div>' +
          '<div style="margin-top:10px">' + chartHTML + '</div>' +
          '<div class="kv-list" style="margin-top:10px">' + predItems + '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function renderRiskSection(title, data, runThreshold) {
    if (!data) return '';
    var probabilities = data.risk_probabilities || {};
    var labels = data.risk_labels || {};
    var horizonSet = new Set();
    Object.keys(probabilities).forEach(function(k) {
      var h = parsePredictionHorizon(k);
      if (h != null) horizonSet.add(h);
    });
    Object.keys(labels).forEach(function(k) {
      var h = parsePredictionHorizon(k);
      if (h != null) horizonSet.add(h);
    });
    var horizons = Array.from(horizonSet).sort(function(a, b) { return a - b; });
    var points = horizons.map(function(h) {
      var prob = Number(pickValueByHorizon(probabilities, h));
      var labelRaw = pickValueByHorizon(labels, h);
      var hasLabel = labelRaw !== undefined && labelRaw !== null && String(labelRaw).trim() !== '';
      var labelNum = Number(labelRaw);
      return {
        horizon: h,
        probability: prob,
        labelValue: hasLabel ? (labelNum === 1 ? 1 : 0) : null,
      };
    }).filter(function(item) {
      return Number.isFinite(item.probability);
    });
    var chartHTML = renderRiskProbabilityChart(points, data.risk_threshold != null ? data.risk_threshold : runThreshold);
    var rows = points.map(function(item) {
      var probTxt = (clamp(item.probability, 0, 1) * 100).toFixed(1) + '%';
      var riskLabel = item.labelValue == null ? '—' : (item.labelValue === 1 ? '高风险' : '低风险');
      var badgeClass = item.labelValue == null ? 'badge-gray' : (item.labelValue === 1 ? 'badge-red' : 'badge-green');
      return (
        '<tr>' +
          '<td><strong>t+' + item.horizon + '</strong></td>' +
          '<td>' + escHtml(probTxt) + '</td>' +
          '<td><span class="badge ' + badgeClass + '">' + riskLabel + '</span></td>' +
        '</tr>'
      );
    }).join('');
    var threshold = Number(data.risk_threshold);
    if (!Number.isFinite(threshold)) threshold = Number(runThreshold);
    var thresholdTxt = Number.isFinite(threshold) ? threshold.toFixed(2) : '—';
    var table = rows
      ? '<div class="et-table-scroll"><table class="et-table"><thead><tr><th>时间点</th><th>风险概率</th><th>判定</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      : '<div class="et-empty">暂无风险预测值</div>';
    return (
      '<div class="info-card" style="margin-top:10px">' +
        '<div class="info-card-header"><span class="info-card-title">' + escHtml(title) + '</span></div>' +
        '<div class="info-card-body">' +
          '<div class="kv-list">' +
            '<div class="kv-item"><span class="kv-key">模型版本</span><span class="kv-value">' + renderModelSummary(data.models || {}) + '</span></div>' +
            '<div class="kv-item"><span class="kv-key">风险阈值</span><span class="kv-value">' + escHtml(thresholdTxt) + '</span></div>' +
          '</div>' +
          '<div style="margin-top:10px">' + chartHTML + '</div>' +
          '<div style="margin-top:10px">' + table + '</div>' +
        '</div>' +
      '</div>'
    );
  }

  var sortedFamilyKeys = Object.keys(families).sort(function(a, b) {
    var va = familyOrder[a] != null ? familyOrder[a] : 99;
    var vb = familyOrder[b] != null ? familyOrder[b] : 99;
    return va - vb;
  });
  var familyListText = requestedFamilies.length
    ? requestedFamilies.map(function(f) { return PREDICTION_FAMILY_LABELS[f] || f; }).join(' / ')
    : (sortedFamilyKeys.length
      ? sortedFamilyKeys.map(function(f) { return PREDICTION_FAMILY_LABELS[f] || f; }).join(' / ')
      : '—');

  var bodyHTML =
    '<div class="kv-list">' +
      '<div class="kv-item"><span class="kv-key">预测ID</span><span class="kv-value font-mono">' + escHtml(String(run.id)) + '</span></div>' +
      '<div class="kv-item"><span class="kv-key">创建时间</span><span class="kv-value">' + escHtml(formatDateTime(run.created_at)) + '</span></div>' +
      '<div class="kv-item"><span class="kv-key">输入就诊</span><span class="kv-value">' + escHtml((run.encounter_ids || []).join(', ') || '—') + '</span></div>' +
      '<div class="kv-item"><span class="kv-key">预测时间点</span><span class="kv-value">' + escHtml(formatPredictionHorizon(run)) + '</span></div>' +
      '<div class="kv-item"><span class="kv-key">模型家族</span><span class="kv-value">' + escHtml(familyListText) + '</span></div>' +
      '<div class="kv-item"><span class="kv-key">延迟</span><span class="kv-value">' + escHtml(run.latency_ms != null ? String(run.latency_ms) + ' ms' : '—') + '</span></div>' +
    '</div>';
  bodyHTML += renderXuSection(families.xu);
  bodyHTML += renderRiskSection('Fen 近视风险', families.fen, run.risk_threshold);
  bodyHTML += renderRiskSection('FenG 高度近视风险', families.feng, run.risk_threshold);
  if (!families.xu && !families.fen && !families.feng) {
    bodyHTML += '<div class="et-empty" style="margin-top:10px">暂无可展示的模型结果</div>';
  }

  showModal('预测详情', bodyHTML, '<button class="btn btn-primary" onclick="closeModal()">关闭</button>');
  var modalEl = document.querySelector('.modal');
  if (modalEl) modalEl.classList.add('modal-wide');
}

function openPredictByEncountersModal(patientId, encounters, onDone) {
  var ordered = (encounters || []).slice().sort(function(a, b) {
    var ad = a.encounter_date || '';
    var bd = b.encounter_date || '';
    if (ad && bd && ad !== bd) return ad < bd ? -1 : 1;
    return Number(a.id) - Number(b.id);
  });

  var defaultSelectedIds = ordered
    .filter(function(enc) { return enc.se != null && enc.image_asset_id != null; })
    .slice(-5)
    .map(function(enc) { return String(enc.id); });

  var selectedSet = new Set(defaultSelectedIds);
  var horizonSet = new Set(getPreferredDefaultHorizons(5));
  var selectedFamilies = getActivePredictionFamilies();
  var selectedFamilyText = selectedFamilies.map(function(f) { return PREDICTION_FAMILY_LABELS[f] || f; }).join(' / ');

  function maxHorizon() {
    var n = selectedSet.size;
    if (n < 1) return 5;
    return Math.max(1, 6 - Math.min(n, 5));
  }

  function normalizeHorizons() {
    var maxH = maxHorizon();
    Array.from(horizonSet).forEach(function(h) {
      if (h > maxH) horizonSet.delete(h);
    });
    if (horizonSet.size === 0) {
      for (var h = 1; h <= maxH; h++) horizonSet.add(h);
    }
  }

  function renderHorizons() {
    normalizeHorizons();
    var maxH = maxHorizon();
    var hint = $('pred-horizon-hint');
    if (hint) hint.textContent = '可选 1~' + maxH;
    var chips = $('pred-horizon-chips');
    if (!chips) return;
    chips.innerHTML = '';
    for (var h = 1; h <= 5; h++) {
      (function(hVal) {
        var btn = document.createElement('button');
        var disabled = hVal > maxH;
        var active = !disabled && horizonSet.has(hVal);
        btn.type = 'button';
        btn.className = ['chip', active ? 'chip-active' : '', disabled ? 'chip-disabled' : ''].join(' ').trim();
        btn.textContent = 't+' + hVal;
        btn.disabled = disabled;
        btn.addEventListener('click', function() {
          if (disabled) return;
          if (horizonSet.has(hVal)) horizonSet.delete(hVal);
          else horizonSet.add(hVal);
          renderHorizons();
        });
        chips.appendChild(btn);
      })(h);
    }
  }

  function renderSelectedCount() {
    var countEl = $('pred-selected-count');
    if (countEl) countEl.textContent = selectedSet.size + ' / 5';
  }

  var rows = ordered.map(function(enc) {
    var valid = enc.se != null && enc.image_asset_id != null;
    var status = valid ? '<span class="badge badge-green">可用于预测</span>' : '<span class="badge badge-red">缺少 SE 或图像</span>';
    var checked = selectedSet.has(String(enc.id)) ? ' checked' : '';
    var disabled = valid ? '' : ' disabled';
    return (
      '<tr>' +
        '<td><input type="checkbox" class="pred-enc-check" data-enc-id="' + escHtml(String(enc.id)) + '"' + checked + disabled + ' /></td>' +
        '<td>' + escHtml(String(enc.id)) + '</td>' +
        '<td>' + escHtml(formatDate(enc.encounter_date)) + '</td>' +
        '<td>' + (enc.se != null ? Number(enc.se).toFixed(2) + ' D' : '—') + '</td>' +
        '<td>' + escHtml(enc.image_asset_id != null ? String(enc.image_asset_id) : '—') + '</td>' +
        '<td>' + status + '</td>' +
      '</tr>'
    );
  }).join('') || '<tr><td colspan="6">暂无可选就诊记录</td></tr>';

  var bodyHTML =
    '<div class="info-card" style="margin-bottom:10px">' +
      '<div class="info-card-body">' +
        '<div class="text-muted text-sm">请选择本次预测使用的就诊记录（最多 5 条）。系统将按就诊日期自动排序后推理。</div>' +
        '<div class="text-muted text-sm" style="margin-top:6px">本次执行模型家族：' + escHtml(selectedFamilyText || 'Xu') + '（风险阈值 ' + DEFAULT_PREDICTION_RISK_THRESHOLD.toFixed(2) + '）。</div>' +
      '</div>' +
    '</div>' +
    '<div class="entity-table" style="margin-bottom:10px">' +
      '<div class="et-toolbar"><span class="text-muted text-sm">已选择 <strong id="pred-selected-count">' + selectedSet.size + ' / 5</strong></span></div>' +
      '<div class="et-table-scroll"><table class="et-table"><thead><tr><th>选择</th><th>ID</th><th>日期</th><th>SE</th><th>图像</th><th>状态</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
    '</div>' +
    '<div class="form-field">' +
      '<label class="form-label">预测时间点 <span id="pred-horizon-hint" class="optional"></span></label>' +
      '<div id="pred-horizon-chips" class="chip-group"></div>' +
    '</div>' +
    '<div id="pred-modal-error" class="error-msg hidden" style="margin-top:10px"></div>';

  var footerHTML =
    '<button class="btn btn-outline" onclick="closeModal()">取消</button>' +
    '<button class="btn btn-primary" id="pred-submit-btn">执行预测</button>';

  showModal('发起预测（基于已有就诊）', bodyHTML, footerHTML);
  renderHorizons();
  renderSelectedCount();

  document.querySelectorAll('.pred-enc-check').forEach(function(checkbox) {
    checkbox.addEventListener('change', function() {
      var encId = String(checkbox.dataset.encId || '');
      if (!encId) return;
      if (checkbox.checked) {
        if (selectedSet.size >= 5) {
          checkbox.checked = false;
          var errEl = $('pred-modal-error');
          if (errEl) {
            errEl.textContent = '最多选择 5 条就诊记录';
            errEl.classList.remove('hidden');
          }
          return;
        }
        selectedSet.add(encId);
      } else {
        selectedSet.delete(encId);
      }
      var resetErrEl = $('pred-modal-error');
      if (resetErrEl) resetErrEl.classList.add('hidden');
      renderSelectedCount();
      renderHorizons();
    });
  });

  var submitBtn = $('pred-submit-btn');
  if (!submitBtn) return;
  submitBtn.addEventListener('click', async function() {
    var errEl = $('pred-modal-error');
    var selected = Array.from(selectedSet).map(function(x) { return Number(x); });
    var horizons = Array.from(horizonSet).sort(function(a, b) { return a - b; });
    if (!selected.length) {
      if (errEl) {
        errEl.textContent = '请至少选择 1 条就诊记录';
        errEl.classList.remove('hidden');
      }
      return;
    }
    if (!horizons.length) {
      if (errEl) {
        errEl.textContent = '请至少选择 1 个预测时间点';
        errEl.classList.remove('hidden');
      }
      return;
    }
    if (!confirmSubmitIfNeeded('确认提交本次预测任务？')) {
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = '预测中…';
    if (errEl) errEl.classList.add('hidden');

    try {
      var result = await apiFetch('/v1/clinical/predictions/by-encounters', {
        method: 'POST',
        body: {
          patient_id: Number(patientId),
          encounter_ids: selected,
          horizons: horizons,
          model_families: selectedFamilies,
          risk_threshold: DEFAULT_PREDICTION_RISK_THRESHOLD,
          actor: authState.username || null,
        },
      });
      closeModal();
      showToast('预测完成（ID: ' + result.id + '）', 'success');
      if (typeof onDone === 'function') onDone(result);
    } catch (err) {
      if (errEl) {
        errEl.textContent = String(err.message || err);
        errEl.classList.remove('hidden');
      }
      submitBtn.disabled = false;
      submitBtn.textContent = '执行预测';
    }
  });
}

// ===== Page: Patient Detail =====
async function renderPatientDetail(params) {
  params = params || {};
  var id = params.id;
  if (!id) { navigate('/patients'); return; }

  const content = $('content-area');
  content.innerHTML =
    '<div class="page-wrap">' +
      '<button class="back-btn" onclick="navigate(\'/patients\')">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>' +
        '返回患者列表' +
      '</button>' +
      '<div id="patient-detail-content"><div class="et-loading"><div class="spinner-lg"></div> 加载患者信息…</div></div>' +
    '</div>';

  try {
    const results = await Promise.all([
      apiFetch('/v1/clinical/patients/' + id),
      apiFetch('/v1/clinical/patients/' + id + '/encounters', { query: { limit: 50, offset: 0 } }).catch(function() { return []; }),
      apiFetch('/v1/clinical/patients/' + id + '/predictions', { query: { limit: 50, offset: 0 } }).catch(function() { return []; }),
    ]);
    var patient = results[0];
    var encounters = results[1];
    var predictions = results[2];

    function sexLabel(s) { return s === 'M' ? '男' : s === 'F' ? '女' : s === 'O' ? '其他' : '—'; }

    var encItems = (encounters || []).map(function(enc) {
      return '<div class="tl-item">' +
        '<div class="tl-left"><div class="tl-marker tl-marker-blue"></div><div class="tl-line"></div></div>' +
        '<div class="tl-body">' +
          '<div class="tl-date">' + escHtml(formatDate(enc.encounter_date)) + '</div>' +
          '<div class="tl-title">就诊记录</div>' +
          '<div class="tl-card"><div class="kv-list">' +
            '<div class="kv-item"><span class="kv-key">SE</span><span class="kv-value"><strong>' + (enc.se != null ? Number(enc.se).toFixed(2) : '—') + ' D</strong></span></div>' +
            (enc.image_asset_id ? '<div class="kv-item"><span class="kv-key">图像ID</span><span class="kv-value font-mono text-sm">' + escHtml(enc.image_asset_id) + '</span></div>' : '') +
            (enc.notes ? '<div class="kv-item"><span class="kv-key">备注</span><span class="kv-value">' + escHtml(encounterNotesToText(enc.notes)) + '</span></div>' : '') +
          '</div></div>' +
        '</div>' +
      '</div>';
    }).join('') || '<div class="et-empty">暂无就诊记录</div>';

    var predItems = (predictions || []).map(function(run) {
      var worst = getPredictionWorstSeForRun(run);
      var worstText = worst == null ? '—' : worst.toFixed(2) + ' D';
      return '<tr>' +
        '<td><span class="text-muted text-sm">' + escHtml(formatDateTime(run.created_at)) + '</span></td>' +
        '<td>' + escHtml(formatPredictionHorizon(run)) + '</td>' +
        '<td><strong>' + escHtml(worstText) + '</strong></td>' +
        '<td><span class="text-muted text-sm">' + escHtml(formatPredictionModels(run)) + '</span></td>' +
        '<td><button class="btn btn-sm btn-outline btn-view-pred" data-pred-id="' + escHtml(String(run.id)) + '">查看</button></td>' +
      '</tr>';
    }).join('') || '<tr><td colspan="5">暂无预测记录</td></tr>';

    $('patient-detail-content').innerHTML =
      '<div class="page-header">' +
        '<h1 class="page-title">' + escHtml(patient.full_name || patient.patient_code || '患者详情') + '</h1>' +
        '<div class="page-actions">' +
          '<button class="btn btn-outline" id="run-predict-from-detail"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>发起预测</button>' +
          '<button class="btn btn-primary" id="new-encounter-from-detail"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>新建就诊</button>' +
        '</div>' +
      '</div>' +
      '<div class="detail-layout">' +
        '<div class="detail-sidebar">' +
          '<div class="info-card">' +
            '<div class="info-card-header"><span class="info-card-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>患者信息</span></div>' +
            '<div class="info-card-body"><div class="kv-list">' +
              '<div class="kv-item"><span class="kv-key">编号</span><span class="kv-value font-mono">' + escHtml(patient.patient_code || '—') + '</span></div>' +
              '<div class="kv-item"><span class="kv-key">姓名</span><span class="kv-value">' + escHtml(patient.full_name || '—') + '</span></div>' +
              '<div class="kv-item"><span class="kv-key">性别</span><span class="kv-value">' + escHtml(sexLabel(patient.sex)) + '</span></div>' +
              '<div class="kv-item"><span class="kv-key">出生日期</span><span class="kv-value">' + escHtml(formatDate(patient.birth_date)) + '</span></div>' +
              '<div class="kv-item"><span class="kv-key">创建时间</span><span class="kv-value">' + escHtml(formatDateTime(patient.created_at)) + '</span></div>' +
            '</div></div>' +
          '</div>' +
        '</div>' +
        '<div>' +
          '<div class="info-card">' +
            '<div class="info-card-header"><span class="info-card-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/></svg>就诊时间线（' + (encounters || []).length + ' 条）</span></div>' +
            '<div class="info-card-body"><div class="timeline">' + encItems + '</div></div>' +
          '</div>' +
          '<div class="info-card" style="margin-top:12px">' +
            '<div class="info-card-header"><span class="info-card-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>预测历史（' + (predictions || []).length + ' 条）</span></div>' +
            '<div class="et-table-scroll"><table class="et-table"><thead><tr><th>时间</th><th>预测点</th><th>最差SE</th><th>模型</th><th>操作</th></tr></thead><tbody>' + predItems + '</tbody></table></div>' +
          '</div>' +
        '</div>' +
      '</div>';

    $('new-encounter-from-detail').addEventListener('click', function() {
      _preSelectedPatientId = id;
      navigate('/encounters');
    });
    $('run-predict-from-detail').addEventListener('click', function() {
      openPredictByEncountersModal(id, encounters, function() {
        renderPatientDetail({ id: String(id) });
      });
    });
    document.querySelectorAll('.btn-view-pred').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var predId = String(btn.dataset.predId || '');
        var run = (predictions || []).find(function(item) { return String(item.id) === predId; });
        if (run) showPredictionRunDetailModal(run);
      });
    });

  } catch (err) {
    $('patient-detail-content').innerHTML = '<div class="et-empty text-muted">加载失败：' + escHtml(err.message) + '</div>';
  }
}

// ===== Page: Encounters =====
async function renderEncounters() {
  const content = $('content-area');
  content.innerHTML =
    '<div class="page-wrap">' +
      '<div class="page-header"><h1 class="page-title"><svg class="page-title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/></svg>就诊记录</h1></div>' +
      '<div class="form-card">' +
        '<div class="form-card-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>录入新就诊</div>' +
        '<div class="form-row">' +
          '<div class="form-field"><label class="form-label">患者 <span style="color:var(--red-500)">*</span></label><select id="enc-patient-id" class="form-input"><option value="">加载患者列表…</option></select></div>' +
          '<div class="form-field"><label class="form-label">就诊日期 <span style="color:var(--red-500)">*</span></label><input id="enc-date" class="form-input" type="date" value="' + new Date().toISOString().slice(0,10) + '" /></div>' +
        '</div>' +
        '<div class="form-row">' +
          '<div class="form-field"><label class="form-label">球镜当量 SE（D） <span style="color:var(--red-500)">*</span></label><input id="enc-se" class="form-input" type="number" step="0.01" placeholder="-2.50" /><span class="form-hint">近视为负值，如 −3.25</span></div>' +
          '<div class="form-field">' +
            '<label class="form-label">添加眼底图像 <span class="optional">可选</span></label>' +
            '<div class="enc-asset-tools">' +
              '<button class="btn btn-outline btn-sm" type="button" id="enc-upload-trigger">上传图像并自动关联</button>' +
              '<button class="btn btn-outline btn-sm" type="button" id="enc-clear-image" disabled>移除图像</button>' +
              '<input type="file" id="enc-upload-input" accept="image/*" hidden />' +
            '</div>' +
            '<div id="enc-upload-status" class="enc-asset-status text-muted text-sm">建议在录入就诊时同步上传并绑定图像。</div>' +
            '<div id="enc-selected-image" class="text-muted text-sm">当前未添加图像</div>' +
          '</div>' +
        '</div>' +
        '<div class="form-row single"><div class="form-field"><label class="form-label">备注 <span class="optional">可选</span></label><textarea id="enc-notes" class="form-input" placeholder="就诊备注…"></textarea></div></div>' +
        '<div id="enc-error" class="error-msg hidden"></div>' +
        '<div class="form-actions"><button class="btn btn-primary" id="enc-submit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="20 6 9 17 4 12"/></svg>提交就诊</button></div>' +
      '</div>' +
      '<div id="enc-recent-wrap"></div>' +
    '</div>';
  var currentImageAssetId = null;
  var currentImageName = '';

  function loadEncounterDraft() {
    try {
      var raw = localStorage.getItem(ENCOUNTER_DRAFT_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function saveEncounterDraft() {
    if (!doctorPrefs.autosave_encounter_draft) return;
    var draft = {
      patient_id: $('enc-patient-id') ? String($('enc-patient-id').value || '') : '',
      encounter_date: $('enc-date') ? String($('enc-date').value || '') : '',
      se: $('enc-se') ? String($('enc-se').value || '') : '',
      notes_text: $('enc-notes') ? String($('enc-notes').value || '') : '',
      image_asset_id: currentImageAssetId,
      image_name: currentImageName,
    };
    localStorage.setItem(ENCOUNTER_DRAFT_KEY, JSON.stringify(draft));
  }

  function clearEncounterDraft() {
    localStorage.removeItem(ENCOUNTER_DRAFT_KEY);
  }

  function renderSelectedImageInfo() {
    var infoEl = $('enc-selected-image');
    var clearBtn = $('enc-clear-image');
    if (infoEl) {
      if (currentImageAssetId != null) {
        infoEl.innerHTML = '当前图像：<code>ID ' + escHtml(String(currentImageAssetId)) + '</code>' +
          (currentImageName ? ' · ' + escHtml(currentImageName) : '') +
          ' <button class="btn btn-outline btn-sm" type="button" id="enc-preview-image-btn">查看图像</button>';
        var previewBtn = $('enc-preview-image-btn');
        if (previewBtn) {
          previewBtn.addEventListener('click', function() {
            previewImageAsset(currentImageAssetId, '查看已上传图像');
          });
        }
      } else {
        infoEl.textContent = '当前未添加图像';
      }
    }
    if (clearBtn) {
      clearBtn.disabled = currentImageAssetId == null;
    }
  }

  try {
    var patients = await apiFetch('/v1/clinical/patients', { query: { limit: 50, offset: 0 } });
    var select = $('enc-patient-id');
    select.innerHTML = '<option value="">-- 选择患者 --</option>' +
      patients.map(function(p) {
        return '<option value="' + escHtml(String(p.id)) + '">' + escHtml(p.patient_code) + (p.full_name ? ' — ' + p.full_name : '') + '</option>';
      }).join('');

    if (_preSelectedPatientId) {
      select.value = String(_preSelectedPatientId);
      _preSelectedPatientId = null;
      loadEncountersForPatient(select.value);
    }
    if (!select.value && doctorPrefs.autosave_encounter_draft) {
      var draftOnLoad = loadEncounterDraft();
      if (draftOnLoad && draftOnLoad.patient_id) {
        select.value = String(draftOnLoad.patient_id);
        if (select.value) loadEncountersForPatient(select.value);
      }
    }

    select.addEventListener('change', function() {
      if (select.value) {
        loadEncountersForPatient(select.value);
      } else {
        $('enc-recent-wrap').innerHTML = '';
      }
      saveEncounterDraft();
    });
  } catch (err) {
    showToast('患者列表加载失败：' + err.message, 'error');
  }

  var uploadBtn = $('enc-upload-trigger');
  var clearImageBtn = $('enc-clear-image');
  var uploadInput = $('enc-upload-input');
  var uploadStatus = $('enc-upload-status');
  if (uploadBtn && uploadInput) {
    uploadBtn.addEventListener('click', function() {
      uploadInput.click();
    });
    uploadInput.addEventListener('change', async function() {
      var file = uploadInput.files && uploadInput.files[0];
      if (!file) return;
      uploadBtn.disabled = true;
      uploadBtn.textContent = '上传中…';
      try {
        var asset = await uploadInlineAsset(file, uploadStatus);
        sessionAssets.push(asset);
        currentImageAssetId = Number(asset.file_asset_id);
        currentImageName = String(asset.original_filename || '');
        renderSelectedImageInfo();
        saveEncounterDraft();
      } finally {
        uploadBtn.disabled = false;
        uploadBtn.textContent = '上传图像并自动关联';
        uploadInput.value = '';
      }
    });
  }
  if (clearImageBtn) {
    clearImageBtn.addEventListener('click', function() {
      currentImageAssetId = null;
      currentImageName = '';
      renderSelectedImageInfo();
      var uploadStatusEl = $('enc-upload-status');
      if (uploadStatusEl) uploadStatusEl.textContent = '已移除当前图像关联';
      saveEncounterDraft();
    });
  }

  if (doctorPrefs.autosave_encounter_draft) {
    var draft = loadEncounterDraft();
    if (draft) {
      if ($('enc-date') && draft.encounter_date) $('enc-date').value = String(draft.encounter_date);
      if ($('enc-se') && draft.se !== undefined && draft.se !== null) $('enc-se').value = String(draft.se);
      if ($('enc-notes') && draft.notes_text) $('enc-notes').value = String(draft.notes_text);
      if (draft.image_asset_id != null) {
        currentImageAssetId = Number(draft.image_asset_id);
        currentImageName = String(draft.image_name || '');
      }
    }
  } else {
    clearEncounterDraft();
  }
  renderSelectedImageInfo();
  ['enc-date', 'enc-se', 'enc-notes'].forEach(function(id) {
    var el = $(id);
    if (!el) return;
    el.addEventListener('input', saveEncounterDraft);
    el.addEventListener('change', saveEncounterDraft);
  });

  $('enc-submit').addEventListener('click', async function() {
    var patientId = $('enc-patient-id').value;
    var date = $('enc-date').value;
    var se = $('enc-se').value;

    if (!patientId) { showEncError('请选择患者'); return; }
    if (!date) { showEncError('请填写就诊日期'); return; }
    if (se === '') { showEncError('请填写球镜当量 SE'); return; }
    if (!confirmSubmitIfNeeded('确认提交这条就诊记录？')) return;

    var payload = { patient_id: parseInt(patientId, 10), encounter_date: date, se: parseFloat(se) };
    if (currentImageAssetId != null) payload.image_asset_id = Number(currentImageAssetId);
    var notes = $('enc-notes').value.trim();
    if (notes) payload.notes = { text: notes };

    var btn = $('enc-submit');
    btn.disabled = true;
    btn.textContent = '提交中…';

    try {
      await apiFetch('/v1/clinical/encounters', { method: 'POST', body: payload });
      showToast('就诊记录已保存', 'success');
      $('enc-se').value = '';
      $('enc-notes').value = '';
      $('enc-date').value = new Date().toISOString().slice(0, 10);
      currentImageAssetId = null;
      currentImageName = '';
      renderSelectedImageInfo();
      $('enc-error').classList.add('hidden');
      clearEncounterDraft();
      if (patientId) loadEncountersForPatient(patientId);
    } catch (err) {
      showEncError(err.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="20 6 9 17 4 12"/></svg> 提交就诊';
    }
  });
}

function showEncError(msg) {
  var el = $('enc-error');
  if (el) { el.textContent = msg; el.classList.remove('hidden'); }
}

function encounterNotesToText(notes) {
  if (notes == null) return '—';
  if (typeof notes === 'string') return notes || '—';
  if (typeof notes === 'object') {
    if (typeof notes.text === 'string' && notes.text.trim()) return notes.text.trim();
    try { return JSON.stringify(notes); } catch (_) { return '—'; }
  }
  return String(notes);
}

function encounterNotesToFormText(notes) {
  if (notes == null) return '';
  if (typeof notes === 'string') return notes;
  if (typeof notes === 'object' && typeof notes.text === 'string') return notes.text;
  return '';
}

function openEditEncounterModal(encounter, onSaved) {
  var originalDate = encounter.encounter_date ? String(encounter.encounter_date) : '';
  var originalSe = encounter.se != null ? String(encounter.se) : '';
  var originalNotes = encounterNotesToFormText(encounter.notes || null);
  var editedImageAssetId = encounter.image_asset_id != null ? Number(encounter.image_asset_id) : null;
  var imageTouched = false;

  var bodyHTML =
    '<div class="form-row">' +
      '<div class="form-field"><label class="form-label">就诊日期</label><input id="edit-enc-date" class="form-input" type="date" value="' + escHtml(originalDate) + '" /></div>' +
      '<div class="form-field"><label class="form-label">球镜当量 SE（D）</label><input id="edit-enc-se" class="form-input" type="number" step="0.01" value="' + escHtml(originalSe) + '" /></div>' +
    '</div>' +
    '<div class="form-field">' +
      '<label class="form-label">添加眼底图像 <span class="optional">可选</span></label>' +
      '<div class="enc-asset-tools">' +
        '<button class="btn btn-outline btn-sm" type="button" id="edit-enc-upload-btn">上传并替换</button>' +
        '<button class="btn btn-outline btn-sm" type="button" id="edit-enc-remove-image-btn">移除图像</button>' +
        '<input type="file" id="edit-enc-upload-input" accept="image/*" hidden />' +
      '</div>' +
      '<div id="edit-enc-image-status" class="enc-asset-status text-muted text-sm"></div>' +
      '<div id="edit-enc-upload-status" class="enc-asset-status text-muted text-sm"></div>' +
    '</div>' +
    '<div class="form-field"><label class="form-label">备注 <span class="optional">可选</span></label><textarea id="edit-enc-notes" class="form-input" placeholder="就诊备注…">' + escHtml(originalNotes) + '</textarea></div>' +
    '<div id="edit-enc-error" class="error-msg hidden"></div>';
  var footerHTML =
    '<button class="btn btn-outline" onclick="closeModal()">取消</button>' +
    '<button class="btn btn-primary" id="edit-enc-save-btn">保存修改</button>';
  showModal('更改已有就诊', bodyHTML, footerHTML);

  function renderEditImageStatus() {
    var statusEl = $('edit-enc-image-status');
    if (!statusEl) return;
    if (editedImageAssetId != null) {
      statusEl.innerHTML = '当前图像：<code>ID ' + escHtml(String(editedImageAssetId)) + '</code>' +
        ' <button class="btn btn-outline btn-sm" type="button" id="edit-enc-preview-image-btn">查看图像</button>';
      var previewBtn = $('edit-enc-preview-image-btn');
      if (previewBtn) {
        previewBtn.addEventListener('click', function() {
          previewImageAsset(editedImageAssetId, '查看就诊图像');
        });
      }
    } else {
      statusEl.textContent = '当前未关联图像';
    }
  }
  renderEditImageStatus();

  var uploadBtn = $('edit-enc-upload-btn');
  var uploadInput = $('edit-enc-upload-input');
  var uploadStatus = $('edit-enc-upload-status');
  if (uploadBtn && uploadInput) {
    uploadBtn.addEventListener('click', function() { uploadInput.click(); });
    uploadInput.addEventListener('change', async function() {
      var file = uploadInput.files && uploadInput.files[0];
      if (!file) return;
      uploadBtn.disabled = true;
      uploadBtn.textContent = '上传中…';
      try {
        var asset = await uploadInlineAsset(file, uploadStatus);
        sessionAssets.push(asset);
        editedImageAssetId = Number(asset.file_asset_id);
        imageTouched = true;
        renderEditImageStatus();
      } finally {
        uploadBtn.disabled = false;
        uploadBtn.textContent = '上传并替换';
        uploadInput.value = '';
      }
    });
  }
  var removeImageBtn = $('edit-enc-remove-image-btn');
  if (removeImageBtn) {
    removeImageBtn.addEventListener('click', function() {
      editedImageAssetId = null;
      imageTouched = true;
      if (uploadStatus) uploadStatus.textContent = '已移除图像关联';
      renderEditImageStatus();
    });
  }

  var saveBtn = $('edit-enc-save-btn');
  if (!saveBtn) return;
  saveBtn.addEventListener('click', async function() {
    var errEl = $('edit-enc-error');
    var dateVal = String(($('edit-enc-date') ? $('edit-enc-date').value : '') || '');
    var seRaw = String(($('edit-enc-se') ? $('edit-enc-se').value : '') || '');
    var notesVal = String(($('edit-enc-notes') ? $('edit-enc-notes').value : '') || '').trim();

    var payload = {};
    if (dateVal !== originalDate) payload.encounter_date = dateVal || null;
    if (seRaw !== originalSe) payload.se = seRaw === '' ? null : parseFloat(seRaw);
    if (notesVal !== originalNotes) payload.notes = notesVal ? { text: notesVal } : null;
    if (imageTouched) payload.image_asset_id = editedImageAssetId;

    if (!Object.keys(payload).length) {
      closeModal();
      showToast('未检测到变更', 'info');
      return;
    }
    if (!confirmSubmitIfNeeded('确认保存这条就诊修改？')) return;

    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    if (errEl) errEl.classList.add('hidden');
    try {
      await apiFetch('/v1/clinical/encounters/' + Number(encounter.id), {
        method: 'PATCH',
        body: payload,
      });
      closeModal();
      showToast('就诊记录已更新', 'success');
      if (typeof onSaved === 'function') onSaved();
    } catch (err) {
      if (errEl) {
        errEl.textContent = String(err.message || err);
        errEl.classList.remove('hidden');
      }
      saveBtn.disabled = false;
      saveBtn.textContent = '保存修改';
    }
  });
}

async function loadEncountersForPatient(patientId) {
  var wrap = $('enc-recent-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<div class="et-loading"><div class="spinner-lg"></div> 加载就诊记录…</div>';

  try {
    var encounters = await apiFetch('/v1/clinical/patients/' + patientId + '/encounters', { query: { limit: 20, offset: 0 } });
    if (!encounters || encounters.length === 0) {
      wrap.innerHTML = '<div class="info-card"><div class="info-card-header"><span class="info-card-title">更改已有就诊</span></div><div class="info-card-body"><div class="et-empty">该患者暂无就诊记录</div></div></div>';
      return;
    }
    var rows = encounters.map(function(enc) {
      var imageCell = enc.image_asset_id
        ? ('<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
            '<span class="badge badge-teal">有图像</span>' +
            '<button class="btn btn-sm btn-outline enc-preview-btn" data-asset-id="' + escHtml(String(enc.image_asset_id)) + '">查看</button>' +
          '</div>')
        : '<span class="text-muted text-sm">—</span>';
      return '<tr>' +
        '<td>' + escHtml(formatDate(enc.encounter_date)) + '</td>' +
        '<td><strong>' + (enc.se != null ? Number(enc.se).toFixed(2) : '—') + ' D</strong></td>' +
        '<td>' + imageCell + '</td>' +
        '<td><span class="text-muted text-sm">' + escHtml(encounterNotesToText(enc.notes)) + '</span></td>' +
        '<td><button class="btn btn-sm btn-outline enc-edit-btn" data-enc-id="' + escHtml(String(enc.id)) + '">更改</button></td>' +
        '</tr>';
    }).join('');
    wrap.innerHTML =
      '<div class="info-card">' +
        '<div class="info-card-header"><span class="info-card-title">更改已有就诊（' + encounters.length + ' 条）</span></div>' +
        '<div class="et-table-scroll"><table class="et-table"><thead><tr><th>日期</th><th>SE</th><th>图像</th><th>备注</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '</div>';
    document.querySelectorAll('.enc-edit-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id = String(btn.dataset.encId || '');
        var encounter = encounters.find(function(x) { return String(x.id) === id; });
        if (!encounter) return;
        openEditEncounterModal(encounter, function() {
          loadEncountersForPatient(patientId);
        });
      });
    });
    document.querySelectorAll('.enc-preview-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var assetId = Number(btn.dataset.assetId || 0);
        if (assetId > 0) previewImageAsset(assetId, '查看就诊图像');
      });
    });
  } catch (err) {
    wrap.innerHTML = '<div class="et-empty text-muted">加载失败：' + escHtml(err.message) + '</div>';
  }
}

// ===== Page: Quick Predict =====
function renderQuickPredict() {
  const content = $('content-area');
  content.innerHTML =
    '<div class="page-wrap">' +
      '<div class="page-header">' +
        '<div>' +
          '<h1 class="page-title"><svg class="page-title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>预测工作台</h1>' +
          '<p class="page-subtitle">预测流程已重构为患者内闭环：请从患者详情发起预测</p>' +
        '</div>' +
      '</div>' +
      '<div class="info-card" style="margin-bottom:12px">' +
        '<div class="info-card-header"><span class="info-card-title">标准流程</span></div>' +
        '<div class="info-card-body">' +
          '<ol style="padding-left:18px;color:var(--slate-700)">' +
            '<li>进入患者详情</li>' +
            '<li>勾选已有就诊记录（SE + 图像）</li>' +
            '<li>选择预测时间点并执行预测</li>' +
            '<li>在患者时间线中回看预测历史</li>' +
          '</ol>' +
          '<div style="margin-top:10px"><button class="btn btn-primary" id="predict-go-patients">进入患者列表</button></div>' +
        '</div>' +
      '</div>' +
      '<div class="info-card">' +
        '<div class="info-card-header"><span class="info-card-title">可直接发起预测的患者</span></div>' +
        '<div class="info-card-body"><div id="predict-patient-shortlist"><div class="et-loading"><div class="spinner-lg"></div> 加载中…</div></div></div>' +
      '</div>' +
    '</div>';
  var goBtn = $('predict-go-patients');
  if (goBtn) {
    goBtn.addEventListener('click', function() {
      navigate('/patients');
    });
  }

  apiFetch('/v1/clinical/patients', { query: { limit: 20, offset: 0 } })
    .then(function(patients) {
      var wrap = $('predict-patient-shortlist');
      if (!wrap) return;
      if (!patients || !patients.length) {
        wrap.innerHTML = '<div class="et-empty">暂无患者，请先在患者管理中建档</div>';
        return;
      }
      var rows = patients.map(function(p) {
        return '<tr>' +
          '<td><code class="font-mono text-sm">' + escHtml(p.patient_code || '—') + '</code></td>' +
          '<td>' + escHtml(p.full_name || '—') + '</td>' +
          '<td>' + escHtml(formatDateTime(p.created_at)) + '</td>' +
          '<td><button class="btn btn-sm btn-outline btn-open-patient-from-predict" data-patient-id="' + escHtml(String(p.id)) + '">进入患者</button></td>' +
        '</tr>';
      }).join('');
      wrap.innerHTML = '<div class="et-table-scroll"><table class="et-table"><thead><tr><th>患者编号</th><th>姓名</th><th>创建时间</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
      document.querySelectorAll('.btn-open-patient-from-predict').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var pid = String(btn.dataset.patientId || '');
          if (pid) navigate('/patients/' + pid);
        });
      });
    })
    .catch(function(err) {
      var wrap = $('predict-patient-shortlist');
      if (wrap) wrap.innerHTML = '<div class="et-empty text-muted">加载失败：' + escHtml(err.message) + '</div>';
    });
}

async function uploadInlineAsset(file, statusEl) {
  if (statusEl) {
    statusEl.innerHTML = '<div class="et-loading"><div class="spinner-lg"></div><span>上传中：' + escHtml(file.name) + '…</span></div>';
  }
  try {
    var dataUrl = await new Promise(function(resolve, reject) {
      var reader = new FileReader();
      reader.onload = function() { resolve(reader.result); };
      reader.onerror = function() { reject(new Error('文件读取失败')); };
      reader.readAsDataURL(file);
    });

    var nameParts = file.name.split('.');
    var ext = nameParts.length > 1 ? '.' + nameParts[nameParts.length - 1].toLowerCase() : '.jpg';

    var result = await apiFetch('/v1/clinical/files/upload-inline', {
      method: 'POST',
      body: { image_b64: dataUrl, image_ext: ext, original_filename: file.name, content_type: file.type || 'image/jpeg' },
    });

    if (statusEl) {
      statusEl.innerHTML = '<span class="badge badge-green">上传成功：' + escHtml(file.name) + '（ID: ' + escHtml(String(result.file_asset_id)) + '）</span>';
    }
    showToast('图像 "' + file.name + '" 上传成功', 'success');
    return {
      file_asset_id: result.file_asset_id,
      original_filename: file.name,
      size_bytes: result.size_bytes,
      sha256: result.sha256,
    };
  } catch (err) {
    if (statusEl) {
      statusEl.innerHTML = '<span class="error-msg">上传失败：' + escHtml(err.message) + '</span>';
    }
    showToast('上传失败：' + err.message, 'error');
    throw err;
  }
}

// ===== Page: System =====
async function renderSystem() {
  const content = $('content-area');
  content.innerHTML =
    '<div class="page-wrap">' +
      '<div class="page-header"><h1 class="page-title"><svg class="page-title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>系统设置</h1></div>' +
      '<div class="form-card">' +
        '<div class="form-card-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>医生设置（可修改）</div>' +
        '<div class="form-field mb-12">' +
          '<label class="form-label">默认预测时间点</label>' +
          '<div id="sys-pref-horizon-chips" class="chip-group"></div>' +
          '<span class="form-hint">用于“发起预测”弹窗的默认勾选项</span>' +
        '</div>' +
        '<div class="form-row">' +
          '<div class="form-field"><label class="form-label">表格密度</label><select id="sys-pref-density" class="form-input"><option value="standard">标准</option><option value="compact">紧凑</option></select></div>' +
          '<div class="form-field"><label class="form-label">字体大小</label><select id="sys-pref-font-size" class="form-input"><option value="normal">标准</option><option value="large">大字</option></select></div>' +
        '</div>' +
        '<div class="form-row">' +
          '<div class="form-field"><label class="form-label"><input id="sys-pref-autosave-draft" type="checkbox" /> 就诊录入草稿自动保存</label><span class="form-hint">在“就诊记录”页面自动保存未提交内容</span></div>' +
          '<div class="form-field"><label class="form-label"><input id="sys-pref-confirm-submit" type="checkbox" /> 提交前确认弹窗</label><span class="form-hint">开启后，提交就诊/预测前会弹出确认框</span></div>' +
        '</div>' +
        '<div class="form-actions">' +
          '<button class="btn btn-outline" id="sys-pref-reset">恢复默认</button>' +
          '<button class="btn btn-primary" id="sys-pref-save"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="20 6 9 17 4 12"/></svg>保存设置</button>' +
        '</div>' +
      '</div>' +
      '<div class="form-card">' +
        '<div class="form-card-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>账号安全</div>' +
        '<div class="form-row">' +
          '<div class="form-field"><label class="form-label">当前密码</label><input id="sys-pass-current" class="form-input" type="password" autocomplete="current-password" /></div>' +
          '<div class="form-field"><label class="form-label">新密码</label><input id="sys-pass-next" class="form-input" type="password" autocomplete="new-password" /></div>' +
        '</div>' +
        '<div class="form-row">' +
          '<div class="form-field"><label class="form-label">确认新密码</label><input id="sys-pass-confirm" class="form-input" type="password" autocomplete="new-password" /></div>' +
          '<div class="form-field"></div>' +
        '</div>' +
        '<div id="sys-pass-error" class="error-msg hidden"></div>' +
        '<div class="form-actions"><button class="btn btn-primary" id="sys-pass-submit">修改密码</button></div>' +
      '</div>' +
      '<div class="info-card"><div class="info-card-header"><span class="info-card-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>系统信息（只读）</span><button class="btn btn-sm btn-outline" id="sys-recheck"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>重新检测</button></div><div class="info-card-body"><div class="kv-list"><div class="kv-item"><span class="kv-key">服务端地址（登录页配置）</span><span class="kv-value font-mono" id="sys-api-base-readonly"></span></div></div><div id="sys-healthz-content"><div class="et-loading"><div class="spinner-lg"></div> 检测中…</div></div></div></div>' +
      '<div class="info-card"><div class="info-card-header"><span class="info-card-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 2h8l2 4-6 8-6-8z"/><line x1="4" y1="6" x2="12" y2="6"/></svg>模型版本摘要</span></div><div class="info-card-body"><div id="sys-model-info-content"><div class="et-loading"><div class="spinner-lg"></div> 加载中…</div></div></div></div>' +
      '<div class="info-card"><div class="info-card-header"><span class="info-card-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>路由规则说明</span></div><div class="info-card-body"><div id="sys-routing-content"><div class="et-loading"><div class="spinner-lg"></div> 加载中…</div></div></div></div>' +
    '</div>';

  var readonlyApiBaseEl = $('sys-api-base-readonly');
  if (readonlyApiBaseEl) readonlyApiBaseEl.textContent = settings.api_base || DEFAULT_SETTINGS.api_base;

  var horizonSet = new Set(_normalizeHorizonList(doctorPrefs.default_horizons));
  function renderPrefHorizonChips() {
    var chips = $('sys-pref-horizon-chips');
    if (!chips) return;
    chips.innerHTML = '';
    for (var h = 1; h <= 5; h++) {
      (function(hVal) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chip ' + (horizonSet.has(hVal) ? 'chip-active' : '');
        btn.textContent = 't+' + hVal;
        btn.addEventListener('click', function() {
          if (horizonSet.has(hVal)) horizonSet.delete(hVal);
          else horizonSet.add(hVal);
          if (!horizonSet.size) horizonSet.add(hVal);
          renderPrefHorizonChips();
        });
        chips.appendChild(btn);
      })(h);
    }
  }
  renderPrefHorizonChips();
  if ($('sys-pref-density')) $('sys-pref-density').value = doctorPrefs.table_density;
  if ($('sys-pref-font-size')) $('sys-pref-font-size').value = doctorPrefs.font_size;
  if ($('sys-pref-autosave-draft')) $('sys-pref-autosave-draft').checked = !!doctorPrefs.autosave_encounter_draft;
  if ($('sys-pref-confirm-submit')) $('sys-pref-confirm-submit').checked = !!doctorPrefs.confirm_before_submit;

  var savePrefBtn = $('sys-pref-save');
  if (savePrefBtn) {
    savePrefBtn.addEventListener('click', function() {
      saveDoctorPrefs({
        default_horizons: Array.from(horizonSet).sort(function(a, b) { return a - b; }),
        table_density: $('sys-pref-density') ? $('sys-pref-density').value : doctorPrefs.table_density,
        font_size: $('sys-pref-font-size') ? $('sys-pref-font-size').value : doctorPrefs.font_size,
        autosave_encounter_draft: $('sys-pref-autosave-draft') ? $('sys-pref-autosave-draft').checked : true,
        confirm_before_submit: $('sys-pref-confirm-submit') ? $('sys-pref-confirm-submit').checked : true,
      });
      if (!doctorPrefs.autosave_encounter_draft) {
        localStorage.removeItem(ENCOUNTER_DRAFT_KEY);
      }
      showToast('医生设置已保存', 'success');
    });
  }
  var resetPrefBtn = $('sys-pref-reset');
  if (resetPrefBtn) {
    resetPrefBtn.addEventListener('click', function() {
      horizonSet = new Set(DEFAULT_DOCTOR_PREFS.default_horizons);
      if ($('sys-pref-density')) $('sys-pref-density').value = DEFAULT_DOCTOR_PREFS.table_density;
      if ($('sys-pref-font-size')) $('sys-pref-font-size').value = DEFAULT_DOCTOR_PREFS.font_size;
      if ($('sys-pref-autosave-draft')) $('sys-pref-autosave-draft').checked = !!DEFAULT_DOCTOR_PREFS.autosave_encounter_draft;
      if ($('sys-pref-confirm-submit')) $('sys-pref-confirm-submit').checked = !!DEFAULT_DOCTOR_PREFS.confirm_before_submit;
      renderPrefHorizonChips();
    });
  }

  var passBtn = $('sys-pass-submit');
  if (passBtn) {
    passBtn.addEventListener('click', async function() {
      var errEl = $('sys-pass-error');
      var oldPass = String(($('sys-pass-current') ? $('sys-pass-current').value : '') || '');
      var newPass = String(($('sys-pass-next') ? $('sys-pass-next').value : '') || '');
      var confirmPass = String(($('sys-pass-confirm') ? $('sys-pass-confirm').value : '') || '');
      if (errEl) errEl.classList.add('hidden');
      if (!oldPass || !newPass || !confirmPass) {
        if (errEl) {
          errEl.textContent = '请完整填写当前密码、新密码、确认新密码';
          errEl.classList.remove('hidden');
        }
        return;
      }
      if (newPass !== confirmPass) {
        if (errEl) {
          errEl.textContent = '两次输入的新密码不一致';
          errEl.classList.remove('hidden');
        }
        return;
      }
      passBtn.disabled = true;
      passBtn.textContent = '提交中…';
      try {
        await apiFetch('/v1/auth/change-password', {
          method: 'POST',
          body: { old_password: oldPass, new_password: newPass },
        });
        if ($('sys-pass-current')) $('sys-pass-current').value = '';
        if ($('sys-pass-next')) $('sys-pass-next').value = '';
        if ($('sys-pass-confirm')) $('sys-pass-confirm').value = '';
        showToast('密码修改成功，请使用新密码登录', 'success');
      } catch (err) {
        if (errEl) {
          errEl.textContent = String(err.message || err);
          errEl.classList.remove('hidden');
        }
      } finally {
        passBtn.disabled = false;
        passBtn.textContent = '修改密码';
      }
    });
  }

  $('sys-recheck').addEventListener('click', async function() {
    await checkHealth();
    await loadSystemInfo();
  });

  await loadSystemInfo();
}

async function loadSystemInfo() {
  var healthzEl = $('sys-healthz-content');
  if (healthzEl) {
    try {
      var data = await apiFetch('/healthz', { cache: 'no-store' });
      var statusBadge = data && data.status === 'ok'
        ? '<span class="badge badge-green">在线</span>'
        : '<span class="badge badge-red">异常</span>';
      var modelCount = data && data.model_count != null ? String(data.model_count) : '—';
      var defaultDevice = data && data.default_device ? String(data.default_device) : '—';
      var maxVisits = data && data.limits && data.limits.max_visits != null ? String(data.limits.max_visits) : '—';
      healthzEl.innerHTML =
        '<div class="kv-list">' +
          '<div class="kv-item"><span class="kv-key">连接状态</span><span class="kv-value">' + statusBadge + '</span></div>' +
          '<div class="kv-item"><span class="kv-key">模型数量</span><span class="kv-value">' + escHtml(modelCount) + '</span></div>' +
          '<div class="kv-item"><span class="kv-key">默认推理设备</span><span class="kv-value">' + escHtml(defaultDevice) + '</span></div>' +
          '<div class="kv-item"><span class="kv-key">最大随访次数</span><span class="kv-value">' + escHtml(maxVisits) + '</span></div>' +
        '</div>';
    } catch (err) {
      healthzEl.innerHTML = '<div class="error-msg">连接失败：' + escHtml(err.message) + '</div>';
    }
  }

  var modelEl = $('sys-model-info-content');
  if (modelEl) {
    try {
      var mdata = await apiFetch('/model-info');
      var groups = mdata.groups || {};
      var familyGroups = mdata.family_groups || {};
      var html = '<div class="text-muted text-sm">仅展示模型名称与版本，不展示服务器目录路径。</div>';
      var familyRows = '';
      var familyKeys = Object.keys(familyGroups || {});
      if (familyKeys.length > 0) {
        setAvailablePredictionFamilies(familyKeys);
      } else if (Object.keys(groups).length > 0) {
        setAvailablePredictionFamilies(['xu']);
      }
      var familyOrder = { xu: 0, fen: 1, feng: 2 };
      familyKeys.sort(function(a, b) {
        var va = familyOrder[a] != null ? familyOrder[a] : 99;
        var vb = familyOrder[b] != null ? familyOrder[b] : 99;
        return va - vb;
      });
      if (familyKeys.length > 0) {
        for (var fi = 0; fi < familyKeys.length; fi++) {
          var familyKey = familyKeys[fi];
          var seqMap = familyGroups[familyKey] || {};
          var seqLens = Object.keys(seqMap).sort(function(a, b) { return Number(a) - Number(b); });
          for (var si = 0; si < seqLens.length; si++) {
            var sl = seqLens[si];
            var models = seqMap[sl] || [];
            for (var mi = 0; mi < models.length; mi++) {
              var fm = models[mi] || {};
              var familyName = PREDICTION_FAMILY_LABELS[familyKey] || String(familyKey || '—');
              var modelName = String(fm.file || '—')
                .split('/')
                .pop()
                .replace(/\.(pt|pth|onnx|bin)$/i, '');
              familyRows += '<tr><td><strong>' + escHtml(familyName) + '</strong></td><td><strong>' + escHtml(String(sl)) + '</strong></td><td>' + escHtml(String(fm.horizon != null ? fm.horizon : '—')) + '</td><td class="font-mono text-sm">' + escHtml(modelName || '—') + '</td></tr>';
            }
          }
        }
        html += '<table class="rules-table" style="margin-top:12px"><thead><tr><th>家族</th><th>Seq Len</th><th>Horizon</th><th>模型版本</th></tr></thead><tbody>' + familyRows + '</tbody></table>';
      } else {
        var seqLensLegacy = Object.keys(groups).sort(function(a, b) { return Number(a) - Number(b); });
        if (seqLensLegacy.length > 0) {
          var rows = '';
          for (var i = 0; i < seqLensLegacy.length; i++) {
            var slLegacy = seqLensLegacy[i];
            var modelsLegacy = groups[slLegacy] || [];
            for (var j = 0; j < modelsLegacy.length; j++) {
              var m = modelsLegacy[j];
              var modelNameLegacy = String(m.file || '—')
                .split('/')
                .pop()
                .replace(/\.(pt|pth|onnx|bin)$/i, '');
              rows += '<tr><td><strong>' + escHtml(String(slLegacy)) + '</strong></td><td>' + escHtml(String(m.horizon != null ? m.horizon : '—')) + '</td><td class="font-mono text-sm">' + escHtml(modelNameLegacy || '—') + '</td></tr>';
            }
          }
          html += '<table class="rules-table" style="margin-top:12px"><thead><tr><th>Seq Len</th><th>Horizon</th><th>模型版本</th></tr></thead><tbody>' + rows + '</tbody></table>';
        } else {
          html += '<div class="et-empty">暂无模型信息</div>';
        }
      }
      modelEl.innerHTML = html;
    } catch (err) {
      modelEl.innerHTML = '<div class="error-msg">加载失败：' + escHtml(err.message) + '</div>';
    }
  }

  var routingEl = $('sys-routing-content');
  if (routingEl) {
    try {
      var rdata = await apiFetch('/routing-rules');
      var rules = rdata.rules || {};
      var keys = Object.keys(rules).sort(function(a, b) { return Number(a) - Number(b); });
      if (keys.length === 0) {
        routingEl.innerHTML = '<div class="et-empty">暂无路由规则</div>';
      } else {
        var rrows = '';
        for (var ri = 0; ri < keys.length; ri++) {
          var rk = keys[ri];
          var horizons = (rules[rk] || []).map(function(h) { return '<span class="badge badge-blue" style="margin:1px">' + h + '</span>'; }).join(' ');
          rrows += '<tr><td><strong>' + escHtml(rk) + '</strong> 次随访</td><td>' + horizons + '</td></tr>';
        }
        routingEl.innerHTML = '<table class="rules-table"><thead><tr><th>随访次数</th><th>可预测时间点</th></tr></thead><tbody>' + rrows + '</tbody></table>';
      }
    } catch (err) {
      routingEl.innerHTML = '<div class="error-msg">加载失败：' + escHtml(err.message) + '</div>';
    }
  }
}

// ===== Global Search =====
function handleGlobalSearch() {
  var val = ($('global-search') ? $('global-search').value : '').trim();
  if (val) {
    navigate('/patients');
    setTimeout(function() {
      var searchEl = $('patient-search');
      if (searchEl) {
        searchEl.value = val;
        searchEl.dispatchEvent(new Event('input'));
      }
    }, 150);
  }
}

// ===== Init =====
async function initApp() {
  loadSettings();
  loadDoctorPrefs();
  applyDoctorPrefs();
  renderLoginApiBaseHint();
  loadAuthState();
  renderAuthState();

  // Login form events
  var loginForm = $('login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', function(e) {
      e.preventDefault();
      doLoginFromScreen();
    });
  }
  var loginConnBtn = $('login-conn-settings');
  if (loginConnBtn) {
    loginConnBtn.addEventListener('click', function() {
      openLoginConnectionSettingsModal();
    });
  }
  await ensureAuthSession();
  if (getAccessToken()) {
    showAppShell();
    refreshAvailablePredictionFamilies();
    resolveRoute();
    checkHealth();
  } else {
    showLoginScreen();
  }
  setInterval(checkHealth, 30000);

  var logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', function() { logout(); });
  }

  var searchEl = document.getElementById('global-search');
  if (searchEl) {
    searchEl.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') handleGlobalSearch();
    });
    searchEl.addEventListener('input', function() {
      clearTimeout(_searchDebounceTimer);
      _searchDebounceTimer = setTimeout(handleGlobalSearch, 300);
    });
  }

  window.addEventListener('hashchange', resolveRoute);
}

initApp();
