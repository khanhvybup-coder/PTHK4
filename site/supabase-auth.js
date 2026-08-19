(() => {
  'use strict';

  const SESSION_KEY = 'kths-supabase-session-v1';
  const callbacks = new Set();
  let config = null;
  let initializationError = null;
  let session = null;
  let profile = null;
  let refreshTimer = null;
  let realtimeSocket = null;
  let realtimeHeartbeat = null;
  let realtimeReconnect = null;
  let realtimeRef = 0;
  let realtimeStopped = false;

  function emitAuth() {
    window.dispatchEvent(new CustomEvent('kths:supabaseauth', {
      detail: { authenticated: Boolean(session?.access_token && profile?.staffKey), profile }
    }));
  }

  function storeSession(value) {
    session = value?.access_token ? value : null;
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  }

  function loadStoredSession() {
    try {
      const value = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      return value?.access_token && value?.refresh_token ? value : null;
    } catch {
      return null;
    }
  }

  async function readJson(response) {
    const value = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(value.msg || value.message || value.error_description || value.error || `Yêu cầu xác thực thất bại (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return value;
  }

  async function loadConfig() {
    const response = await fetch('/api/config', { cache: 'no-store', headers: { Accept: 'application/json' } });
    config = await readJson(response);
    if (!config.supabaseUrl || !config.supabasePublishableKey) throw new Error('Cấu hình Supabase Auth chưa đầy đủ.');
    return config;
  }

  async function authRequest(path, { method = 'GET', body, token } = {}) {
    const response = await fetch(`${config.supabaseUrl}${path}`, {
      method,
      cache: 'no-store',
      headers: {
        apikey: config.supabasePublishableKey,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return readJson(response);
  }

  function normalizeSession(value) {
    if (!value?.access_token) return null;
    const expiresAt = Number(value.expires_at)
      || Math.floor(Date.now() / 1000) + Number(value.expires_in || 3600);
    return { ...value, expires_at: expiresAt };
  }

  async function readProfile() {
    if (!session?.access_token) return null;
    const response = await fetch('/api/session', {
      cache: 'no-store',
      headers: { Accept: 'application/json', Authorization: `Bearer ${session.access_token}` }
    });
    const value = await readJson(response);
    profile = value.profile || null;
    return profile;
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if (!session?.expires_at) return;
    const delay = Math.max(15000, session.expires_at * 1000 - Date.now() - 60000);
    refreshTimer = setTimeout(() => refresh().catch(() => signOut()), delay);
  }

  function sendRealtime(event, topic, payload, { joinRef = null } = {}) {
    if (realtimeSocket?.readyState !== WebSocket.OPEN) return;
    const ref = String(++realtimeRef);
    realtimeSocket.send(JSON.stringify({ topic, event, payload, ref, join_ref: joinRef }));
  }

  function closeRealtime() {
    realtimeStopped = true;
    clearInterval(realtimeHeartbeat);
    clearTimeout(realtimeReconnect);
    realtimeSocket?.close();
    realtimeSocket = null;
  }

  function connectRealtime() {
    closeRealtime();
    if (!session?.access_token || !config?.supabaseUrl) return;
    realtimeStopped = false;
    const socketUrl = config.supabaseUrl.replace(/^http/i, 'ws')
      + `/realtime/v1/websocket?apikey=${encodeURIComponent(config.supabasePublishableKey)}&vsn=1.0.0`;
    const topic = 'realtime:kths-state-signal';
    const socket = new WebSocket(socketUrl);
    realtimeSocket = socket;
    socket.addEventListener('open', () => {
      const joinRef = String(++realtimeRef);
      socket.send(JSON.stringify({
        topic,
        event: 'phx_join',
        ref: joinRef,
        join_ref: joinRef,
        payload: {
          config: {
            broadcast: { ack: false, self: false },
            presence: { enabled: false },
            postgres_changes: [{ event: '*', schema: 'public', table: 'kths_state_signal', filter: 'id=eq.main' }],
            private: false
          },
          access_token: session.access_token
        }
      }));
      clearInterval(realtimeHeartbeat);
      realtimeHeartbeat = setInterval(() => sendRealtime('heartbeat', 'phoenix', {}), 20000);
      window.dispatchEvent(new CustomEvent('kths:realtime-status', { detail: { status: 'connected' } }));
    });
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message?.event !== 'postgres_changes') return;
      callbacks.forEach((callback) => callback(message.payload));
      window.dispatchEvent(new CustomEvent('kths:realtime-state', { detail: message.payload }));
    });
    socket.addEventListener('close', () => {
      if (realtimeSocket !== socket) return;
      realtimeSocket = null;
      clearInterval(realtimeHeartbeat);
      window.dispatchEvent(new CustomEvent('kths:realtime-status', { detail: { status: 'disconnected' } }));
      if (!realtimeStopped && session?.access_token) {
        clearTimeout(realtimeReconnect);
        realtimeReconnect = setTimeout(connectRealtime, 2000);
      }
    });
  }

  async function refresh() {
    if (!session?.refresh_token) throw new Error('Phiên đăng nhập đã hết hạn.');
    const next = normalizeSession(await authRequest('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', body: { refresh_token: session.refresh_token }
    }));
    storeSession(next);
    await readProfile();
    scheduleRefresh();
    connectRealtime();
    emitAuth();
    return session;
  }

  async function ensureToken() {
    await readyPromise;
    if (!session?.access_token) return '';
    if (session.expires_at * 1000 - Date.now() < 60000) await refresh();
    return session?.access_token || '';
  }

  async function requireReady() {
    const initialized = await readyPromise;
    if (!initialized || !config) {
      throw initializationError || new Error('Không tải được cấu hình Supabase từ Netlify Function.');
    }
  }

  async function signIn(staffKey, password) {
    await requireReady();
    const domain = config.authEmailDomain || 'kths.local';
    const next = normalizeSession(await authRequest('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: { email: `${staffKey}@${domain}`, password: String(password || '') }
    }));
    storeSession(next);
    await readProfile();
    if (!profile?.staffKey || profile.staffKey !== staffKey) {
      await signOut();
      throw new Error('Tài khoản đăng nhập không khớp người dùng đã chọn.');
    }
    scheduleRefresh();
    connectRealtime();
    emitAuth();
    return profile;
  }

  async function signOut() {
    const token = session?.access_token;
    if (token && config) authRequest('/auth/v1/logout', { method: 'POST', token }).catch(() => {});
    clearTimeout(refreshTimer);
    closeRealtime();
    storeSession(null);
    profile = null;
    emitAuth();
  }

  async function updatePassword(password) {
    const token = await ensureToken();
    if (!token) throw new Error('Vui lòng đăng nhập trước khi đổi mật khẩu.');
    await authRequest('/auth/v1/user', { method: 'PUT', token, body: { password } });
    return true;
  }

  const readyPromise = (async () => {
    await loadConfig();
    storeSession(loadStoredSession());
    if (session) {
      try {
        if (session.expires_at * 1000 - Date.now() < 60000) await refresh();
        else {
          await readProfile();
          scheduleRefresh();
          connectRealtime();
        }
      } catch {
        storeSession(null);
        profile = null;
      }
    }
    emitAuth();
    return true;
  })().catch((error) => {
    initializationError = error;
    console.error('Không thể khởi tạo Supabase Auth:', error);
    emitAuth();
    return false;
  });

  window.KTHSAuth = {
    ready: () => readyPromise,
    signIn,
    signOut,
    updatePassword,
    isAuthenticated: (staffKey) => Boolean(session?.access_token && profile?.staffKey && (!staffKey || profile.staffKey === staffKey)),
    getProfile: () => profile,
    getAccessToken: ensureToken,
    getAuthHeaders: async () => {
      const token = await ensureToken();
      return token ? { Authorization: `Bearer ${token}` } : {};
    },
    subscribeStateChanges(callback) {
      callbacks.add(callback);
      if (session?.access_token && (!realtimeSocket || realtimeSocket.readyState > WebSocket.OPEN)) connectRealtime();
      return () => callbacks.delete(callback);
    },
    reconnectRealtime: connectRealtime
  };
})();
