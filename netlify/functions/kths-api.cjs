const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

process.env.KTHS_ALLOW_EMPTY_CATALOG = '1';
process.env.KTHS_REMOTE_UPLOADS = '1';

const {
  ApiError,
  executeCommand,
  validateLoadedState
} = require('./_workflow-core.cjs');

const stateId = 'main';
const maxUploadBytes = 5 * 1024 * 1024;
const uploadBucket = 'kths-uploads';
const imageTypes = new Map([
  ['image/jpeg', { extension: '.jpg', matches: (buffer) => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff }],
  ['image/png', { extension: '.png', matches: (buffer) => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) }],
  ['image/webp', { extension: '.webp', matches: (buffer) => buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP' }]
]);

function env() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  const publishableKey = String(process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '');
  const authEmailDomain = String(process.env.KTHS_AUTH_EMAIL_DOMAIN || 'kths.local').trim() || 'kths.local';
  if (!url || !serviceKey || !publishableKey) {
    throw new ApiError(500, 'SUPABASE_CONFIG_MISSING', 'Netlify chưa được cấu hình đầy đủ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY và SUPABASE_PUBLISHABLE_KEY.');
  }
  return { url, serviceKey, publishableKey, authEmailDomain };
}

function json(statusCode, value, headers = {}) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers
    },
    body: value == null ? '' : JSON.stringify(value)
  };
}

async function supabaseFetch(resource, options = {}) {
  const { url, serviceKey } = env();
  const response = await fetch(`${url}${resource}`, {
    ...options,
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new ApiError(502, 'SUPABASE_REQUEST_FAILED', 'Supabase không thể hoàn tất yêu cầu.', {
      status: response.status,
      detail: detail.slice(0, 500)
    });
  }
  return response;
}

function bearerToken(event) {
  const value = String(event.headers?.authorization || event.headers?.Authorization || '').trim();
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

async function resolveAuth(event) {
  const token = bearerToken(event);
  if (!token) throw new ApiError(401, 'AUTH_REQUIRED', 'Vui lòng đăng nhập để tiếp tục.');

  const { url, publishableKey } = env();
  const userResponse = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: publishableKey, authorization: `Bearer ${token}`, accept: 'application/json' }
  });
  if (!userResponse.ok) throw new ApiError(401, 'AUTH_INVALID', 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.');
  const authUser = await userResponse.json();
  const userId = String(authUser?.id || '').trim();
  if (!userId) throw new ApiError(401, 'AUTH_INVALID', 'Không xác định được tài khoản đăng nhập.');

  const profileResponse = await supabaseFetch(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,staff_key,full_name,title,access_role&limit=1`, {
    headers: { accept: 'application/json' }
  });
  const profiles = await profileResponse.json();
  const profile = Array.isArray(profiles) ? profiles[0] : null;
  const staffKey = String(profile?.staff_key || '').trim();
  if (!profile || !staffKey) throw new ApiError(403, 'PROFILE_REQUIRED', 'Tài khoản chưa được gắn với người dùng KTHS.');
  return { authUser, profile, staffKey };
}

function publicProfile(profile) {
  return {
    id: profile.id,
    staffKey: profile.staff_key,
    fullName: profile.full_name,
    title: profile.title,
    accessRole: profile.access_role
  };
}

function readSeedState() {
  const file = path.join(__dirname, 'seed-state.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  return validateLoadedState(state);
}

async function readStateRow() {
  const response = await supabaseFetch(`/rest/v1/kths_app_state?id=eq.${stateId}&select=version,document&limit=1`, {
    headers: { accept: 'application/json' }
  });
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const state = validateLoadedState(rows[0].document);
  state.version = Number(rows[0].version);
  return state;
}

async function readStateVersion() {
  const response = await supabaseFetch(`/rest/v1/kths_app_state?id=eq.${stateId}&select=version&limit=1`, {
    headers: { accept: 'application/json' }
  });
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const version = Number(rows[0].version);
  return Number.isInteger(version) && version >= 0 ? version : null;
}

function clientStateVersion(event) {
  const raw = event.queryStringParameters?.version;
  if (raw == null || raw === '') return null;
  const version = Number(raw);
  return Number.isInteger(version) && version >= 0 ? version : null;
}

async function ensureState() {
  const existing = await readStateRow();
  if (existing) return existing;

  const seed = readSeedState();
  await supabaseFetch('/rest/v1/kths_app_state?on_conflict=id', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      prefer: 'resolution=ignore-duplicates,return=minimal'
    },
    body: JSON.stringify({
      id: stateId,
      version: seed.version,
      document: seed,
      updated_at: seed.updatedAt || new Date().toISOString()
    })
  });
  const inserted = await readStateRow();
  if (!inserted) throw new ApiError(500, 'STATE_BOOTSTRAP_FAILED', 'Không thể khởi tạo dữ liệu KTHS trên Supabase.');
  return inserted;
}

async function persistState(previousVersion, nextState) {
  const response = await supabaseFetch(`/rest/v1/kths_app_state?id=eq.${stateId}&version=eq.${previousVersion}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      prefer: 'return=representation'
    },
    body: JSON.stringify({
      version: nextState.version,
      document: nextState,
      updated_at: nextState.updatedAt || new Date().toISOString()
    })
  });
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new ApiError(409, 'VERSION_CONFLICT', 'Dữ liệu vừa được người khác cập nhật. Hãy thử lại.');
  }
}

function parseJsonBody(event) {
  try {
    const value = JSON.parse(event.body || '');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return value;
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'Nội dung JSON không hợp lệ.');
  }
}

function endpointFromEvent(event) {
  const pathname = new URL(event.rawUrl || event.raw_url || `https://local${event.path || '/'}`).pathname;
  return pathname.split('/').filter(Boolean).pop() || 'state';
}

function safeOriginalName(value, extension) {
  let decoded = String(value || '');
  try { decoded = decodeURIComponent(decoded); } catch { decoded = ''; }
  decoded = path.win32.basename(path.posix.basename(decoded))
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, '_')
    .trim()
    .slice(0, 200);
  return decoded || `image${extension}`;
}

async function uploadImage(event) {
  const rawType = String(event.headers?.['content-type'] || event.headers?.['Content-Type'] || '').toLowerCase();
  const contentType = rawType.split(';', 1)[0].trim();
  const type = imageTypes.get(contentType);
  if (!type) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Chỉ hỗ trợ ảnh JPEG, PNG hoặc WebP.');
  const buffer = Buffer.from(event.body || '', event.isBase64Encoded ? 'base64' : 'binary');
  if (!buffer.length) throw new ApiError(400, 'EMPTY_UPLOAD', 'Tệp ảnh không được để trống.');
  if (buffer.length > maxUploadBytes) throw new ApiError(413, 'BODY_TOO_LARGE', 'Ảnh không được vượt quá 5 MB.');
  if (!type.matches(buffer)) throw new ApiError(400, 'INVALID_IMAGE', 'Nội dung tệp không khớp định dạng ảnh.');

  const filename = `${crypto.randomUUID().replace(/-/g, '')}${type.extension}`;
  await supabaseFetch(`/storage/v1/object/${uploadBucket}/${filename}`, {
    method: 'POST',
    headers: {
      'content-type': contentType,
      'x-upsert': 'false'
    },
    body: buffer
  });
  const { url } = env();
  return {
    url: `${url}/storage/v1/object/public/${uploadBucket}/${filename}`,
    filename,
    contentType,
    size: buffer.length,
    originalName: safeOriginalName(event.headers?.['x-file-name'], type.extension)
  };
}

async function route(event) {
  const method = String(event.httpMethod || event.requestContext?.http?.method || 'GET').toUpperCase();
  const endpoint = endpointFromEvent(event);
  if (method === 'OPTIONS') return { statusCode: 204, headers: { allow: 'GET,HEAD,POST,OPTIONS' }, body: '' };

  if (endpoint === 'config') {
    if (method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Chỉ hỗ trợ GET /api/config.');
    const { url, publishableKey, authEmailDomain } = env();
    return json(200, {
      ok: true,
      supabaseUrl: url,
      supabasePublishableKey: publishableKey,
      authEmailDomain
    });
  }

  const auth = await resolveAuth(event);

  if (endpoint === 'session') {
    if (method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Chỉ hỗ trợ GET /api/session.');
    return json(200, { ok: true, profile: publicProfile(auth.profile) });
  }

  if (endpoint === 'state') {
    if (!['GET', 'HEAD'].includes(method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Chỉ hỗ trợ GET /api/state.');
    const requestedVersion = clientStateVersion(event);
    if (requestedVersion != null) {
      const currentVersion = await readStateVersion();
      if (currentVersion != null && currentVersion === requestedVersion) {
        return {
          statusCode: 204,
          headers: {
            'cache-control': 'no-store',
            'x-kths-version': String(currentVersion)
          },
          body: ''
        };
      }
    }
    const state = await ensureState();
    return method === 'HEAD'
      ? { statusCode: 200, headers: { 'cache-control': 'no-store', 'x-kths-version': String(state.version) }, body: '' }
      : json(200, state, { 'x-kths-version': String(state.version) });
  }

  if (endpoint === 'commands') {
    if (method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Chỉ hỗ trợ POST /api/commands.');
    const current = await ensureState();
    const command = parseJsonBody(event);
    command.actorKey = auth.staffKey;
    delete command.actorId;
    const result = executeCommand(current, command);
    if (!result.duplicate) await persistState(current.version, result.state);
    return json(200, result);
  }

  if (endpoint === 'uploads') {
    if (method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Chỉ hỗ trợ POST /api/uploads.');
    return json(201, { ok: true, upload: await uploadImage(event) });
  }

  if (endpoint === 'events') {
    if (method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Chỉ hỗ trợ GET /api/events.');
    return json(200, { ok: true, polling: true, state: await ensureState() });
  }

  throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy API được yêu cầu.');
}

exports.handler = async (event) => {
  try {
    return await route(event);
  } catch (error) {
    if (error instanceof ApiError) {
      return json(error.status, {
        ok: false,
        error: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {})
      });
    }
    console.error(error);
    return json(500, { ok: false, error: 'INTERNAL_ERROR', message: 'Máy chủ không thể hoàn tất yêu cầu.' });
  }
};
