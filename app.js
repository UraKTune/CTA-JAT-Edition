
const GAS_URL = ENV.GAS_URL;

// ── localStorage keys ────────────────────────────────────────
const LS = {
  UID:          'osu_uid',
  NAME:         'osu_name',
  AVATAR:       'osu_avatar',
  SESSION:      'osu_session',
  EXPIRES_AT:   'osu_expires_at',
  LB_CACHE:     'lb_cache',
  LB_TIMESTAMP: 'lb_last_changed',
};

// ============================================================
// AUTH
// ============================================================

function saveUser(uid, name, avatar, sessionToken, expiresAt) {
  localStorage.setItem(LS.UID,        String(uid));
  localStorage.setItem(LS.NAME,       name);
  localStorage.setItem(LS.AVATAR,     avatar);
  localStorage.setItem(LS.SESSION,    sessionToken);
  localStorage.setItem(LS.EXPIRES_AT, String(expiresAt));
}

function getUser() {
  const uid = localStorage.getItem(LS.UID);
  if (!uid) return null;
  return {
    uid,
    name:        localStorage.getItem(LS.NAME)       || '',
    avatar:      localStorage.getItem(LS.AVATAR)     || '',
    sessionToken:localStorage.getItem(LS.SESSION)    || '',
    expiresAt:   Number(localStorage.getItem(LS.EXPIRES_AT)) || 0,
  };
}

function logout() {
  Object.values(LS).forEach(k => localStorage.removeItem(k));
  window.location.href = 'index.html';
}

// Kiểm tra session có còn hạn không (true = còn dùng được)
function isSessionValid() {
  const user = getUser();
  if (!user || !user.sessionToken) return false;
  // Cộng thêm buffer 5 phút để tránh race condition
  return Date.now() < user.expiresAt - 5 * 60 * 1000;
}

// Bắt đầu login — redirect đến GAS (không popup)
function loginWithOsu() {
  const page = window.location.pathname.split('/').pop() || 'index.html';
  window.location.href = GAS_URL + '?action=login&from=' + encodeURIComponent(page);
}

// Đọc query params sau khi GAS redirect về
function checkAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const auth   = params.get('auth');
  if (!auth) return;

  if (auth === 'success') {
    const uid       = params.get('uid')    || '';
    const name      = params.get('name')   || '';
    const avatar    = params.get('avatar') || '';
    const token     = params.get('token')  || '';
    const expiresAt = Number(params.get('expires')) || 0;
    if (uid && token) {
      saveUser(uid, name, avatar, token, expiresAt);
      showToast('✓ Xin chào ' + name + '!', 'success');
    }
  } else if (auth === 'error') {
    showToast('Đăng nhập thất bại: ' + (params.get('msg') || ''), 'error');
  }

  // Xoá query params khỏi URL, không reload trang
  history.replaceState({}, '', window.location.pathname);
}

// Guard: nếu action cần auth mà session hết hạn thì redirect login
function requireAuth() {
  if (!isSessionValid()) {
    showToast('Phiên đăng nhập hết hạn, vui lòng đăng nhập lại.', 'error');
    setTimeout(loginWithOsu, 1500);
    return false;
  }
  return true;
}

// ============================================================
// API HELPERS
// ============================================================

async function apiGet(params) {
  const qs  = Object.entries(params)
    .map(([k, v]) => k + '=' + encodeURIComponent(v))
    .join('&');
  try {
    const res = await fetch(GAS_URL + '?' + qs);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    // Session hết hạn server-side → yêu cầu login lại
    if (data && data.code === 'SESSION_EXPIRED') {
      showToast('Phiên đăng nhập hết hạn.', 'error');
      setTimeout(loginWithOsu, 1500);
    }
    return data;
  } catch (e) {
    console.error('apiGet error:', params.action, e);
    return null;
  }
}

// Lấy dữ liệu player (quiz + scores)
async function fetchPlayerData(uid) {
  return apiGet({ action: 'getPlayerData', uid });
}

// Config challenges từ GAS
async function fetchChallengeConfig() {
  return apiGet({ action: 'getChallengeConfig' });
}

// Đánh dấu hoàn thành puzzle
async function markPuzzle(puzzleIndex) {
  if (!requireAuth()) return null;
  const user = getUser();
  return apiGet({
    action:       'markPuzzle',
    uid:          user.uid,
    sessionToken: user.sessionToken,
    puzzleIndex,
  });
}

// Submit score: GAS tự lấy plays → tìm best → ghi
async function submitScore(challengeIndex) {
  if (!requireAuth()) return null;
  const user = getUser();
  return apiGet({
    action:         'submitScore',
    uid:            user.uid,
    sessionToken:   user.sessionToken,
    challengeIndex,
  });
}

// ============================================================
// LEADERBOARD — chỉ fetch khi có thay đổi thật
// ============================================================

let _lbPolling = null;

// Lấy timestamp lần cuối sheet thay đổi (payload rất nhẹ)
async function _getLastChanged() {
  const res = await apiGet({ action: 'getLastChanged' });
  return res ? Number(res.lastChanged || 0) : 0;
}

// Lấy leaderboard đầy đủ và cache vào localStorage
async function _fetchAndCacheLb() {
  const res = await apiGet({ action: 'getLeaderboardFull' });
  if (res && res.ok) {
    localStorage.setItem(LS.LB_CACHE, JSON.stringify(res));
  }
  return res;
}

// Lấy leaderboard từ cache nếu có
function getCachedLeaderboard() {
  try {
    const raw = localStorage.getItem(LS.LB_CACHE);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

// Hàm chính — gọi ở mỗi trang cần leaderboard
// onUpdate(data) được gọi khi có dữ liệu mới
async function startLeaderboardPolling(onUpdate) {
  // Bước 1: render ngay từ cache (nếu có) — trang load mượt
  const cached = getCachedLeaderboard();
  if (cached) onUpdate(cached);

  async function checkAndUpdate() {
    const serverTs = await _getLastChanged();
    const clientTs = Number(localStorage.getItem(LS.LB_TIMESTAMP) || 0);

    if (serverTs > clientTs) {
      // Có thay đổi mới → fetch thật
      const fresh = await _fetchAndCacheLb();
      if (fresh) {
        localStorage.setItem(LS.LB_TIMESTAMP, String(serverTs));
        onUpdate(fresh);
      }
    }
    // Nếu bằng nhau → không gọi gì thêm
  }

  // Chạy ngay 1 lần
  await checkAndUpdate();

  // Poll mỗi 30s
  if (_lbPolling) clearInterval(_lbPolling);
  _lbPolling = setInterval(checkAndUpdate, 30_000);
}

// Dừng polling khi rời trang
function stopLeaderboardPolling() {
  if (_lbPolling) { clearInterval(_lbPolling); _lbPolling = null; }
}

// ============================================================
// UI HELPERS
// ============================================================

function updateNavAuth() {
  const area = document.getElementById('nav-auth');
  if (!area) return;
  const user = getUser();
  if (user && isSessionValid()) {
    area.innerHTML = `
      <img src="${user.avatar}" alt="${user.name}" class="nav-avatar"
           onerror="this.src='https://osu.ppy.sh/assets/images/favicon-32x32.png'">
      <span class="nav-username">${user.name}</span>
      <button onclick="logout()" class="btn-logout">Đăng xuất</button>`;
  } else {
    area.innerHTML = `
      <button onclick="loginWithOsu()" class="btn-login">
        <img src="https://osu.ppy.sh/assets/images/favicon-32x32.png" width="16" height="16" alt="osu!">
        Đăng nhập osu!
      </button>`;
  }
}

function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className   = 'show ' + (type || '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = ''; }, 3500);
}

function fmtScore(n) {
  if (n === null || n === undefined || n === '') return '—';
  return Number(n).toLocaleString('vi-VN');
}

function renderAvatarStack(players) {
  if (!players || !players.length)
    return '<span class="no-completions">Chưa có ai hoàn thành</span>';
  const shown = players.slice(0, 8);
  const extra = players.length - shown.length;
  let html = '<div class="avatar-stack">';
  shown.forEach(p => {
    const av = `https://a.ppy.sh/${p.osu_id}`;
    html += `<img src="${av}" alt="${p.name}" title="${p.name}" class="avatar-sm"
                  onerror="this.src='https://osu.ppy.sh/assets/images/favicon-32x32.png'">`;
  });
  if (extra > 0) html += `<span class="avatar-extra">+${extra}</span>`;
  html += '</div>';
  return html;
}

// ============================================================
// INIT — chạy trên mọi trang
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  checkAuthCallback();
  updateNavAuth();
});

// Dừng polling khi rời trang
window.addEventListener('beforeunload', stopLeaderboardPolling);