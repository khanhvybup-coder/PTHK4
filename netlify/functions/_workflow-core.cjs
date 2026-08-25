const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const fsp = fs.promises;
const root = process.env.KTHS_STATIC_ROOT
  ? path.resolve(process.env.KTHS_STATIC_ROOT)
  : path.resolve(__dirname, '../outputs/khoa-ky-thuat-hinh-su-dashboard');
const stateFile = process.env.KTHS_STATE_FILE
  ? path.resolve(process.env.KTHS_STATE_FILE)
  : path.resolve(__dirname, 'workflow-state.json');
const host = process.env.KTHS_HOST || '127.0.0.1';
const port = Number(process.env.KTHS_PORT || process.env.PORT || 4173);
const maxBodyBytes = 1024 * 1024;
const maxUploadBytes = Math.max(1, Number(process.env.KTHS_MAX_UPLOAD_BYTES) || (5 * 1024 * 1024));
const uploadRoot = process.env.KTHS_UPLOAD_DIR
  ? path.resolve(process.env.KTHS_UPLOAD_DIR)
  : path.resolve(path.dirname(stateFile), 'uploads');
const uploadUrlPrefix = '/uploads/';
const uploadTypes = new Map([
  ['image/jpeg', { extension: '.jpg', matches: (buffer) => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff }],
  ['image/png', { extension: '.png', matches: (buffer) => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) }],
  ['image/webp', { extension: '.webp', matches: (buffer) => buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP' }]
]);
const uploadFilenamePattern = /^[a-f0-9]{32}\.(?:jpg|png|webp)$/;
const remoteUploads = process.env.KTHS_REMOTE_UPLOADS === '1';

function loadInventoryCatalog() {
  const sandbox = { window: {} };
  try {
    vm.createContext(sandbox);
    const source = fs.readFileSync(path.join(root, 'source-data.js'), 'utf8');
    vm.runInContext(source, sandbox, { filename: 'source-data.js' });
  } catch (error) {
    if (process.env.KTHS_ALLOW_EMPTY_CATALOG === '1') return [];
    throw error;
  }
  const assets = sandbox.window.KTHS_SOURCE_DATA?.assets || [];
  const seen = new Set();
  return assets.filter((asset) => {
    const id = String(asset?.id || '').trim();
    const name = String(asset?.name || '').trim();
    const quantity = Number(asset?.qty || 0);
    if (!id || !name || !Number.isFinite(quantity) || quantity <= 0 || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).map((asset) => ({
    id: String(asset.id).trim(),
    name: String(asset.name).trim(),
    model: String(asset.model || '').trim(),
    room: String(asset.room || '').trim(),
    qty: Number(asset.qty),
    status: String(asset.status || 'Tốt').trim(),
    note: String(asset.note || '').trim(),
    custom: false
  }));
}

function loadRoomCatalog() {
  const sandbox = { window: {} };
  const fallbackRooms = [
    { id: 'source-0', name: 'Phòng 1 - CS155', function: 'Trung tâm KTPCTP', capacity: 10, operationalStatus: 'Tốt', custom: false, createdAt: null, updatedAt: null },
    { id: 'source-1', name: 'Phòng 2 - CS155', function: 'Phòng máy tính', capacity: 20, operationalStatus: 'Tốt', custom: false, createdAt: null, updatedAt: null },
    { id: 'source-2', name: 'Phòng 3 - CS155', function: 'Thực hành giám định KTHS', capacity: 20, operationalStatus: 'Tốt', custom: false, createdAt: null, updatedAt: null },
    { id: 'source-3', name: 'Phòng 1 - CS200', function: 'Phòng học CLC', capacity: 20, operationalStatus: 'Tốt', custom: false, createdAt: null, updatedAt: null },
    { id: 'source-4', name: 'Phòng 2 - CS200', function: 'Thực hành KNHT', capacity: 10, operationalStatus: 'Tốt', custom: false, createdAt: null, updatedAt: null }
  ];
  try {
    vm.createContext(sandbox);
    const source = fs.readFileSync(path.join(root, 'source-data.js'), 'utf8');
    vm.runInContext(source, sandbox, { filename: 'source-data.js' });
  } catch (error) {
    if (process.env.KTHS_ALLOW_EMPTY_CATALOG === '1') return fallbackRooms;
    throw error;
  }
  const rooms = (sandbox.window.KTHS_SOURCE_DATA?.rooms || []).map((room, index) => ({
    id: `source-${index}`,
    name: String(room.name || '').trim(),
    function: String(room.function || '').trim(),
    capacity: Number.isFinite(Number(room.capacity)) ? Number(room.capacity) : 0,
    operationalStatus: ['Tốt', 'Đang bảo trì', 'Ngừng hoạt động'].includes(room.operationalStatus) ? room.operationalStatus : 'Tốt',
    custom: false,
    createdAt: null,
    updatedAt: null
  })).filter((room) => room.name);
  return rooms.length ? rooms : fallbackRooms;
}

const inventoryCatalog = loadInventoryCatalog();
const roomCatalog = loadRoomCatalog();
const inventoryCommandTypes = new Set(['create_equipment', 'update_equipment', 'delete_equipment']);
const roomCommandTypes = new Set(['create_room', 'update_room', 'delete_room']);
const equipmentStatuses = new Set(['Tốt', 'Hư hỏng', 'Bảo trì', 'Sửa chữa', 'Thanh lý']);
const roomStatuses = new Set(['Tốt', 'Đang bảo trì', 'Ngừng hoạt động']);
const activeLoanStatuses = new Set([
  'pending_manager', 'pending_leader', 'leader_opinion_returned',
  'approved', 'borrowing', 'return_pending'
]);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const staff = {
  teacher: { name: 'Giáo viên đăng ký', role: 'teacher', title: 'GV' },
  thuong: { name: 'Nguyễn Tấn Thương', role: 'approver', title: 'PTK' },
  cong: { name: 'Lê Văn Công', role: 'approver', title: 'PTK' },
  tot: { name: 'Nguyễn Tốt', role: 'teacher', title: 'PTK' },
  thanh: { name: 'Đậu Trung Thành', role: 'teacher', title: 'PTK' },
  huan: { name: 'Trần Xuân Huấn', role: 'manager', title: 'Cán bộ quản lý' },
  be: { name: 'Nguyễn Văn Bé', role: 'teacher', title: 'GV' },
  quan: { name: 'Phạm Minh Quân', role: 'teacher', title: 'GV' },
  external: { name: 'Đơn vị khác', role: 'teacher', title: 'Ngoài Khoa KTHS' }
};

const allowedTransitions = {
  request_leader: ['pending_manager'],
  leader_opinion: ['pending_leader'],
  manager_decide: ['pending_manager', 'leader_opinion_returned'],
  confirm_handoff: ['approved'],
  request_return: ['borrowing'],
  confirm_return: ['return_pending']
};

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let workflowState;
let writeQueue = Promise.resolve();
const eventClients = new Set();

function makeEmptyState() {
  return {
    schemaVersion: 3,
    version: 0,
    nextSequence: 1,
    loanSequences: {},
    updatedAt: new Date().toISOString(),
    staff,
    inventory: clone(inventoryCatalog),
    rooms: clone(roomCatalog),
    loans: [],
    events: []
  };
}

function yearFromLoanId(value) {
  const match = /^PM-(\d{4})-(\d+)$/.exec(String(value || '').trim());
  return match ? { year: match[1], sequence: Number(match[2]) } : null;
}

function nextLoanCode(state, year) {
  if (!state.loanSequences || typeof state.loanSequences !== 'object' || Array.isArray(state.loanSequences)) {
    state.loanSequences = {};
  }
  const existingMax = state.loans.reduce((max, loan) => {
    const parsed = yearFromLoanId(loan?.id);
    return parsed?.year === year && Number.isInteger(parsed.sequence)
      ? Math.max(max, parsed.sequence)
      : max;
  }, 0);
  const stored = Number(state.loanSequences[year]);
  const next = Math.max(Number.isInteger(stored) ? stored : 0, existingMax) + 1;
  state.loanSequences[year] = next;
  return { sequence: next, id: `PM-${year}-${String(next).padStart(2, '0')}` };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(payload);
}

function fail(condition, status, code, message, details) {
  if (condition) throw new ApiError(status, code, message, details);
}

function textValue(value, field, { required = false, max = 500 } = {}) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  fail(required && !normalized, 400, 'VALIDATION_ERROR', `${field} là bắt buộc.`, { field });
  fail(normalized.length > max, 400, 'VALIDATION_ERROR', `${field} không được vượt quá ${max} ký tự.`, { field });
  return normalized;
}

function dateValue(value, field, { required = false } = {}) {
  const normalized = textValue(value, field, { required, max: 10 });
  if (!normalized) return '';
  fail(!/^\d{4}-\d{2}-\d{2}$/.test(normalized), 400, 'VALIDATION_ERROR', `${field} phải có định dạng YYYY-MM-DD.`, { field });
  const [year, month, day] = normalized.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  fail(
    parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day,
    400,
    'VALIDATION_ERROR',
    `${field} không hợp lệ.`,
    { field }
  );
  return normalized;
}

function timeValue(value, field) {
  const normalized = textValue(value, field, { max: 5 });
  fail(normalized && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(normalized), 400, 'VALIDATION_ERROR', `${field} phải có định dạng HH:mm.`, { field });
  return normalized;
}

function decisionValue(value, field = 'decision') {
  const decision = textValue(value, field, { required: true, max: 20 });
  fail(!['approve', 'reject'].includes(decision), 400, 'VALIDATION_ERROR', `${field} chỉ nhận approve hoặc reject.`, { field });
  return decision;
}

function uploadNameFromUrl(value) {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!url.startsWith(uploadUrlPrefix)) return '';
  const filename = url.slice(uploadUrlPrefix.length);
  return uploadFilenamePattern.test(filename) ? filename : '';
}

function imageMetadataValue(item, index) {
  let source = item.image ?? item.upload ?? item.photo ?? null;
  if (!source && (item.imageUrl || item.photoUrl)) {
    source = {
      url: item.imageUrl || item.photoUrl,
      filename: item.imageFilename,
      contentType: item.imageContentType,
      size: item.imageSize,
      originalName: item.imageOriginalName
    };
  }
  if (!source) return null;
  if (typeof source === 'string') source = { url: source };
  fail(!source || typeof source !== 'object' || Array.isArray(source), 400, 'VALIDATION_ERROR', `Anh phuong tien dong ${index + 1} khong hop le.`, { field: `equipment.${index}.image` });

  const url = textValue(source.url || source.imageUrl, `equipment.${index}.image.url`, { required: true, max: remoteUploads ? 1000 : 200 });
  if (remoteUploads) {
    fail(!/^https:\/\/[^\s]+$/i.test(url), 400, 'VALIDATION_ERROR', `Duong dan anh phuong tien dong ${index + 1} khong hop le.`, { field: `equipment.${index}.image.url` });
    const filename = textValue(source.filename, `equipment.${index}.image.filename`, { required: true, max: 100 });
    fail(!uploadFilenamePattern.test(filename), 400, 'VALIDATION_ERROR', `Ten tep anh phuong tien dong ${index + 1} khong hop le.`, { field: `equipment.${index}.image.filename` });
    const expectedType = types[path.extname(filename).toLowerCase()];
    const contentType = textValue(source.contentType || expectedType, `equipment.${index}.image.contentType`, { required: true, max: 50 }).toLowerCase();
    fail(!uploadTypes.has(contentType) || expectedType !== contentType, 400, 'VALIDATION_ERROR', `Loai anh phuong tien dong ${index + 1} khong hop le.`, { field: `equipment.${index}.image.contentType` });
    const size = Number(source.size);
    fail(!Number.isInteger(size) || size < 1 || size > maxUploadBytes, 400, 'VALIDATION_ERROR', `Dung luong anh phuong tien dong ${index + 1} khong hop le.`, { field: `equipment.${index}.image.size` });
    return {
      url,
      filename,
      contentType,
      size,
      originalName: textValue(source.originalName, `equipment.${index}.image.originalName`, { max: 200 })
    };
  }
  const filenameFromUrl = uploadNameFromUrl(url);
  fail(!filenameFromUrl, 400, 'VALIDATION_ERROR', `Duong dan anh phuong tien dong ${index + 1} khong hop le.`, { field: `equipment.${index}.image.url` });
  const filename = textValue(source.filename || filenameFromUrl, `equipment.${index}.image.filename`, { required: true, max: 100 });
  fail(filename !== filenameFromUrl || !uploadFilenamePattern.test(filename), 400, 'VALIDATION_ERROR', `Ten tep anh phuong tien dong ${index + 1} khong hop le.`, { field: `equipment.${index}.image.filename` });

  const expectedType = types[path.extname(filename).toLowerCase()];
  const contentType = textValue(source.contentType || expectedType, `equipment.${index}.image.contentType`, { required: true, max: 50 }).toLowerCase();
  fail(!uploadTypes.has(contentType) || expectedType !== contentType, 400, 'VALIDATION_ERROR', `Loai anh phuong tien dong ${index + 1} khong hop le.`, { field: `equipment.${index}.image.contentType` });
  let stat;
  try {
    stat = fs.statSync(path.join(uploadRoot, filename));
  } catch {
    stat = null;
  }
  fail(!stat?.isFile(), 400, 'VALIDATION_ERROR', `Tep anh phuong tien dong ${index + 1} khong ton tai.`, { field: `equipment.${index}.image.url` });
  const declaredSize = source.size == null || source.size === '' ? stat.size : Number(source.size);
  fail(!Number.isInteger(declaredSize) || declaredSize !== stat.size || stat.size < 1 || stat.size > maxUploadBytes, 400, 'VALIDATION_ERROR', `Dung luong anh phuong tien dong ${index + 1} khong hop le.`, { field: `equipment.${index}.image.size` });

  return {
    url,
    filename,
    contentType,
    size: stat.size,
    originalName: textValue(source.originalName, `equipment.${index}.image.originalName`, { max: 200 })
  };
}

function equipmentValue(value, { required = false } = {}) {
  const items = value == null ? [] : value;
  fail(!Array.isArray(items), 400, 'VALIDATION_ERROR', 'equipment phải là một danh sách.', { field: 'equipment' });
  fail(required && items.length === 0, 400, 'VALIDATION_ERROR', 'Phiếu phải có ít nhất một phương tiện.', { field: 'equipment' });
  fail(items.length > 100, 400, 'VALIDATION_ERROR', 'Danh sách phương tiện không được vượt quá 100 dòng.', { field: 'equipment' });
  const seen = new Set();
  return items.map((item, index) => {
    fail(!item || typeof item !== 'object' || Array.isArray(item), 400, 'VALIDATION_ERROR', `Phương tiện dòng ${index + 1} không hợp lệ.`, { field: `equipment.${index}` });
    const assetId = textValue(item.assetId || item.id || item.code, `equipment.${index}.assetId`, { required: true, max: 100 });
    const quantity = Number(item.quantity ?? item.qty ?? 1);
    fail(!Number.isInteger(quantity) || quantity < 1 || quantity > 10000, 400, 'VALIDATION_ERROR', `Số lượng dòng ${index + 1} không hợp lệ.`, { field: `equipment.${index}.quantity` });
    fail(seen.has(assetId), 400, 'VALIDATION_ERROR', `Phương tiện ${assetId} bị lặp.`, { field: `equipment.${index}.assetId` });
    seen.add(assetId);
    const image = imageMetadataValue(item, index);
    return {
      assetId,
      name: textValue(item.name, `equipment.${index}.name`, { max: 300 }),
      quantity,
      condition: textValue(item.condition, `equipment.${index}.condition`, { max: 100 }),
      note: textValue(item.note, `equipment.${index}.note`, { max: 500 }),
      ...(image ? { image, imageUrl: image.url } : {})
    };
  });
}

function inventoryMap(state) {
  return new Map((state.inventory || []).map((asset) => [asset.id, asset]));
}

function equipmentStatusValue(value, fallback = '') {
  const status = textValue(value == null ? fallback : value, 'status', { required: true, max: 100 });
  fail(!equipmentStatuses.has(status), 400, 'VALIDATION_ERROR', 'Trạng thái phương tiện không hợp lệ.', {
    field: 'status', allowed: [...equipmentStatuses]
  });
  return status;
}

function equipmentQuantityValue(value, { minimum = 0 } = {}) {
  const quantity = Number(value);
  fail(!Number.isInteger(quantity) || quantity < minimum || quantity > 100000, 400, 'VALIDATION_ERROR', 'Số lượng phương tiện không hợp lệ.', {
    field: 'qty', minimum
  });
  return quantity;
}

function inventoryRecordValue(payload, existing = null, { creating = false } = {}) {
  const name = textValue(payload.name == null ? existing?.name : payload.name, 'name', { required: true, max: 300 });
  const model = textValue(payload.model == null ? existing?.model : payload.model, 'model', { required: true, max: 1000 });
  const room = textValue(payload.room == null ? existing?.room : payload.room, 'room', { required: true, max: 200 });
  const qty = equipmentQuantityValue(payload.qty ?? payload.quantity ?? existing?.qty, { minimum: creating ? 1 : 0 });
  const status = equipmentStatusValue(payload.status, existing?.status || 'Tốt');
  const note = textValue(payload.note == null ? existing?.note : payload.note, 'note', { max: 2000 });
  return { name, model, room, qty, status, note };
}

function loanEquipmentLists(loan) {
  return [loan?.equipment, loan?.handoff?.equipment, loan?.returnRequest?.equipment, loan?.returnConfirmation?.equipment]
    .filter(Array.isArray);
}

function loanReferencesAsset(loan, assetId) {
  return loanEquipmentLists(loan).some((items) => items.some((item) => String(item.assetId || '').trim() === assetId));
}

function reservedEquipmentIds(state) {
  const ids = new Set((state.inventory || []).map((asset) => asset.id));
  for (const loan of state.loans || []) {
    for (const items of loanEquipmentLists(loan)) {
      for (const item of items) {
        const id = String(item.assetId || '').trim();
        if (id) ids.add(id);
      }
    }
  }
  for (const event of state.events || []) {
    const id = String(event.entityId || event.details?.assetId || '').trim();
    if (id) ids.add(id);
  }
  return ids;
}

function nextEquipmentId(state) {
  const reserved = reservedEquipmentIds(state);
  let sequence = 1;
  while (reserved.has(`TB-${String(sequence).padStart(4, '0')}`)) sequence += 1;
  return `TB-${String(sequence).padStart(4, '0')}`;
}

function activeBorrowedByAsset(state, excludedLoanId = '') {
  const borrowed = new Map();
  for (const loan of state.loans) {
    if (loan.id === excludedLoanId || !['borrowing', 'return_pending'].includes(loan.status)) continue;
    const equipment = Array.isArray(loan.handoff?.equipment) && loan.handoff.equipment.length
      ? loan.handoff.equipment
      : loan.equipment;
    for (const item of equipment || []) {
      const assetId = String(item.assetId || '').trim();
      const quantity = Math.max(0, Number(item.quantity || 0));
      if (assetId && quantity) borrowed.set(assetId, (borrowed.get(assetId) || 0) + quantity);
    }
  }
  return borrowed;
}

function validateCatalogEquipment(state, equipment, { checkAvailability = false, requireLendable = false, excludedLoanId = '' } = {}) {
  const borrowed = checkAvailability ? activeBorrowedByAsset(state, excludedLoanId) : new Map();
  const byId = inventoryMap(state);
  for (const item of equipment) {
    const asset = byId.get(item.assetId);
    fail(!asset, 400, 'UNKNOWN_ASSET', `Phương tiện ${item.assetId} không có trong danh mục hợp lệ.`, { assetId: item.assetId });
    fail(requireLendable && asset.status !== 'Tốt', 409, 'ASSET_UNAVAILABLE', `Phương tiện ${item.assetId} đang ở trạng thái ${asset.status} và không thể cho mượn.`, {
      assetId: item.assetId, status: asset.status
    });
    fail(item.quantity > asset.qty, 409, 'INSUFFICIENT_STOCK', `Số lượng ${item.assetId} vượt tổng số hiện có.`, {
      assetId: item.assetId, requested: item.quantity, total: asset.qty
    });
    item.name = asset.name;
    if (!checkAvailability) continue;
    const available = Math.max(0, asset.qty - (borrowed.get(item.assetId) || 0));
    fail(item.quantity > available, 409, 'INSUFFICIENT_STOCK', `Phương tiện ${item.assetId} chỉ còn ${available} thiết bị sẵn sàng.`, {
      assetId: item.assetId, requested: item.quantity, available, total: asset.qty
    });
  }
}

function actorFromState(state, command) {
  const actorId = textValue(command.actorId || command.actorKey, 'actorId', { required: true, max: 50 });
  const actor = state.staff[actorId];
  fail(!actor, 403, 'UNKNOWN_ACTOR', 'Người thực hiện không tồn tại.', { actorId });
  return { actorId, actor };
}

function requireRole(actor, role) {
  fail(actor.role !== role, 403, 'FORBIDDEN', `Thao tác này yêu cầu vai trò ${role}.`, { requiredRole: role, actualRole: actor.role });
}

function requireManager(actorId, actor) {
  fail(actorId !== 'huan' || actor.role !== 'manager', 403, 'FORBIDDEN', 'Chỉ Trần Xuân Huấn có quyền quản lý.', {
    requiredActorId: 'huan', actualActorId: actorId, actualRole: actor.role
  });
}

function requireApprover(actorId, actor) {
  fail(!['thuong', 'cong'].includes(actorId) || actor.role !== 'approver', 403, 'FORBIDDEN', 'Chỉ Nguyễn Tấn Thương hoặc Lê Văn Công được cho ý kiến lãnh đạo.', {
    allowedActorIds: ['thuong', 'cong'], actualActorId: actorId, actualRole: actor.role
  });
}

function requireBorrower(actorId, actor) {
  fail(!actorId || !actor, 403, 'FORBIDDEN', 'Chỉ người dùng đã đăng ký mới được thực hiện thao tác mượn - trả.', {
    actualActorId: actorId || null
  });
}

function findLoan(state, loanId) {
  const id = textValue(loanId, 'loanId', { required: true, max: 50 });
  const loan = state.loans.find((item) => item.id === id);
  fail(!loan, 404, 'LOAN_NOT_FOUND', `Không tìm thấy phiếu ${id}.`, { loanId: id });
  return loan;
}

function requireTransition(loan, type) {
  const allowed = allowedTransitions[type] || [];
  fail(!allowed.includes(loan.status), 409, 'INVALID_TRANSITION', `Không thể thực hiện ${type} khi phiếu đang ở trạng thái ${loan.status}.`, {
    loanId: loan.id,
    currentStatus: loan.status,
    allowedStatuses: allowed
  });
}

function localDateAndTime(iso) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function createEvent(state, command, actorId, actor, loan, fromStatus, details, now) {
  const event = {
    id: `EVT-${String(state.version).padStart(6, '0')}`,
    commandId: command.commandId,
    commandHash: command.commandHash,
    loanId: loan.id,
    type: command.type,
    fromStatus,
    toStatus: loan.status,
    actorId,
    actorKey: actorId,
    actorName: actor.name,
    actorRole: actor.role,
    at: now,
    details
  };
  state.events.push(event);
  return event;
}

function createInventoryEvent(state, command, actorId, actor, entityId, details, now, entityType = 'equipment') {
  const event = {
    id: `EVT-${String(state.version).padStart(6, '0')}`,
    commandId: command.commandId,
    commandHash: command.commandHash,
    loanId: null,
    entityType,
    entityId,
    type: command.type,
    fromStatus: null,
    toStatus: null,
    actorId,
    actorKey: actorId,
    actorName: actor.name,
    actorRole: actor.role,
    at: now,
    details
  };
  state.events.push(event);
  return event;
}

function roomMap(state) {
  return new Map((state.rooms || []).map((room) => [room.id, room]));
}

function roomValue(payload, existing = null, { creating = false } = {}) {
  const name = textValue(payload.name == null ? existing?.name : payload.name, 'name', { required: true, max: 200 });
  const roomFunction = textValue(payload.function == null ? existing?.function : payload.function, 'function', { max: 500 });
  const capacity = Number(payload.capacity == null ? (existing?.capacity ?? 0) : payload.capacity);
  fail(!Number.isInteger(capacity) || capacity < 0 || capacity > 100000, 400, 'VALIDATION_ERROR', 'Sức chứa phòng không hợp lệ.', { field: 'capacity' });
  const operationalStatus = textValue(payload.operationalStatus == null ? (existing?.operationalStatus || 'Tốt') : payload.operationalStatus, 'operationalStatus', { required: true, max: 50 });
  fail(!roomStatuses.has(operationalStatus), 400, 'VALIDATION_ERROR', 'Tình trạng phòng không hợp lệ.', { field: 'operationalStatus' });
  return { name, function: roomFunction, capacity, operationalStatus, custom: creating || Boolean(existing?.custom) };
}

function activeLoanUsesRoom(state, roomName) {
  const target = String(roomName || '').trim();
  return state.loans.filter((loan) => activeLoanStatuses.has(loan.status)
    && String(loan.handoff?.room || loan.room || '').trim() === target).map((loan) => loan.id);
}

function applyRoomCommand(state, command, actorId, actor, payload, now) {
  requireManager(actorId, actor);
  const rooms = roomMap(state);
  let roomItem = null;
  let roomId = '';
  let details = {};

  if (command.type === 'create_room') {
    const requestedId = textValue(payload.roomId || payload.id, 'roomId', { max: 80 });
    roomId = requestedId || `custom-${crypto.randomUUID()}`;
    fail(rooms.has(roomId), 409, 'ROOM_ID_CONFLICT', `Mã phòng ${roomId} đã tồn tại.`, { roomId });
    roomItem = { id: roomId, ...roomValue(payload, null, { creating: true }), createdAt: now, updatedAt: now };
    state.rooms.push(roomItem);
    details = { action: 'create', roomId, after: clone(roomItem) };
  }

  if (command.type === 'update_room') {
    roomId = textValue(payload.roomId || payload.id, 'roomId', { required: true, max: 80 });
    const current = rooms.get(roomId);
    fail(!current, 404, 'ROOM_NOT_FOUND', `Không tìm thấy phòng ${roomId}.`, { roomId });
    const nextValues = roomValue(payload, current);
    const activeReferences = activeLoanUsesRoom(state, current.name);
    fail(activeReferences.length && (nextValues.name !== current.name || nextValues.operationalStatus !== current.operationalStatus), 409, 'ROOM_IN_USE', 'Không thể đổi tên hoặc tình trạng phòng khi đang có phiếu mượn.', { roomId, loanIds: activeReferences });
    const before = clone(current);
    Object.assign(current, nextValues, { updatedAt: now });
    roomItem = current;
    details = { action: 'update', roomId, before, after: clone(current) };
  }

  if (command.type === 'delete_room') {
    roomId = textValue(payload.roomId || payload.id, 'roomId', { required: true, max: 80 });
    const current = rooms.get(roomId);
    fail(!current, 404, 'ROOM_NOT_FOUND', `Không tìm thấy phòng ${roomId}.`, { roomId });
    const activeReferences = activeLoanUsesRoom(state, current.name);
    fail(activeReferences.length > 0, 409, 'ROOM_IN_USE', 'Không thể xóa phòng khi vẫn còn phiếu mượn đang hoạt động.', { roomId, loanIds: activeReferences });
    const assignedAssets = state.inventory.filter((asset) => asset.room === current.name).map((asset) => asset.id);
    fail(assignedAssets.length > 0, 409, 'ROOM_HAS_EQUIPMENT', 'Không thể xóa phòng khi còn phương tiện đang được gán.', { roomId, assetIds: assignedAssets });
    state.rooms = state.rooms.filter((room) => room.id !== roomId);
    details = { action: 'delete', roomId, before: clone(current) };
  }

  state.version += 1;
  state.updatedAt = now;
  const event = createInventoryEvent(state, command, actorId, actor, roomId, details, now, 'room');
  return { roomItem, event };
}

function applyInventoryCommand(state, command, actorId, actor, payload, now) {
  requireManager(actorId, actor);
  const byId = inventoryMap(state);
  let inventoryItem = null;
  let assetId = '';
  let details = {};

  if (command.type === 'create_equipment') {
    const requestedId = textValue(payload.assetId || payload.id, 'assetId', { max: 50 }).toUpperCase();
    fail(requestedId && !/^[A-Z0-9][A-Z0-9._-]{0,49}$/.test(requestedId), 400, 'VALIDATION_ERROR', 'Mã phương tiện chỉ được dùng chữ cái, chữ số, dấu chấm, gạch dưới hoặc gạch ngang.', { field: 'assetId' });
    const reserved = new Set([...reservedEquipmentIds(state)].map((id) => id.toUpperCase()));
    assetId = requestedId || nextEquipmentId(state);
    fail(reserved.has(assetId.toUpperCase()), 409, 'EQUIPMENT_ID_CONFLICT', `Mã phương tiện ${assetId} đã tồn tại hoặc đã được sử dụng trong lịch sử.`, { assetId });
    inventoryItem = {
      id: assetId,
      ...inventoryRecordValue(payload, null, { creating: true }),
      custom: true,
      createdAt: now,
      updatedAt: now
    };
    state.inventory.unshift(inventoryItem);
    details = { action: 'create', assetId, after: clone(inventoryItem) };
  }

  if (command.type === 'update_equipment') {
    assetId = textValue(payload.assetId || payload.id, 'assetId', { required: true, max: 50 }).toUpperCase();
    const current = byId.get(assetId);
    fail(!current, 404, 'EQUIPMENT_NOT_FOUND', `Không tìm thấy phương tiện ${assetId}.`, { assetId });
    const nextValues = inventoryRecordValue(payload, current);
    const borrowedQuantity = activeBorrowedByAsset(state).get(assetId) || 0;
    fail(nextValues.qty < borrowedQuantity, 409, 'EQUIPMENT_IN_USE', `Số lượng không được nhỏ hơn ${borrowedQuantity} thiết bị đang mượn.`, {
      assetId, requested: nextValues.qty, borrowed: borrowedQuantity
    });
    const before = clone(current);
    Object.assign(current, nextValues, { updatedAt: now });
    inventoryItem = current;
    details = { action: 'update', assetId, before, after: clone(current) };
  }

  if (command.type === 'delete_equipment') {
    assetId = textValue(payload.assetId || payload.id, 'assetId', { required: true, max: 50 }).toUpperCase();
    const current = byId.get(assetId);
    fail(!current, 404, 'EQUIPMENT_NOT_FOUND', `Không tìm thấy phương tiện ${assetId}.`, { assetId });
    const borrowedQuantity = activeBorrowedByAsset(state).get(assetId) || 0;
    fail(borrowedQuantity > 0, 409, 'EQUIPMENT_IN_USE', `Không thể xóa ${assetId} khi còn ${borrowedQuantity} thiết bị đang mượn.`, {
      assetId, borrowed: borrowedQuantity
    });
    const activeReferences = state.loans
      .filter((loan) => activeLoanStatuses.has(loan.status) && loanReferencesAsset(loan, assetId))
      .map((loan) => loan.id);
    fail(activeReferences.length > 0, 409, 'EQUIPMENT_REFERENCED', `Không thể xóa ${assetId} khi còn phiếu chưa kết thúc.`, {
      assetId, loanIds: activeReferences
    });
    state.inventory = state.inventory.filter((asset) => asset.id !== assetId);
    details = { action: 'delete', assetId, before: clone(current) };
  }

  state.version += 1;
  state.updatedAt = now;
  const event = createInventoryEvent(state, command, actorId, actor, assetId, details, now);
  return { inventoryItem, event };
}

function applyCommand(state, command, actorId, actor, now) {
  const payload = command.payload && typeof command.payload === 'object' && !Array.isArray(command.payload) ? command.payload : {};
  if (inventoryCommandTypes.has(command.type)) return applyInventoryCommand(state, command, actorId, actor, payload, now);
  if (roomCommandTypes.has(command.type)) return applyRoomCommand(state, command, actorId, actor, payload, now);
  let loan;
  let fromStatus = null;
  let details = {};

  if (command.type === 'submit') {
    requireBorrower(actorId, actor);
    const borrowerId = textValue(payload.borrowerId || payload.borrowerKey || actorId, 'borrowerId', { required: true, max: 50 });
    fail(borrowerId !== actorId, 403, 'FORBIDDEN', 'Người sử dụng chỉ được gửi phiếu cho chính mình.', { borrowerId, actorId });
    const borrower = state.staff[borrowerId];
    fail(!borrower, 400, 'VALIDATION_ERROR', 'Người mượn không hợp lệ.', { borrowerId });
    const externalBorrower = borrowerId === 'external';
    const externalOrganization = textValue(payload.externalOrganization, 'externalOrganization', { required: externalBorrower, max: 200 });
    const externalBorrowerName = textValue(payload.externalBorrowerName, 'externalBorrowerName', { required: externalBorrower, max: 200 });
    const borrowDate = dateValue(payload.borrowDate, 'borrowDate', { required: true });
    const expectedReturnDate = dateValue(payload.expectedReturnDate, 'expectedReturnDate', { required: true });
    fail(expectedReturnDate < borrowDate, 400, 'VALIDATION_ERROR', 'Ngày trả dự kiến không được sớm hơn ngày mượn.', { field: 'expectedReturnDate' });
    const equipment = equipmentValue(payload.equipment, { required: true });
    validateCatalogEquipment(state, equipment, { checkAvailability: true, requireLendable: true });
    const localYear = localDateAndTime(now).date.slice(0, 4);
    const generatedCode = nextLoanCode(state, localYear);
    // Keep nextSequence for compatibility with older state files and tools.
    state.nextSequence = Math.max(Number(state.nextSequence) || 1, generatedCode.sequence + 1);
    loan = {
      id: generatedCode.id,
      sequence: generatedCode.sequence,
      borrowerId,
      borrowerKey: borrowerId,
      borrowerName: externalBorrower ? externalBorrowerName : borrower.name,
      ...(externalBorrower ? { externalOrganization, externalBorrowerName } : {}),
      room: textValue(payload.room, 'room', { required: true, max: 200 }),
      purpose: textValue(payload.purpose, 'purpose', { required: true, max: 500 }),
      borrowDate,
      expectedReturnDate,
      note: textValue(payload.note, 'note', { max: 2000 }),
      equipment,
      status: 'pending_manager',
      createdAt: now,
      updatedAt: now
    };
    state.loans.unshift(loan);
    details = {
      borrowerId,
      borrowerName: loan.borrowerName,
      ...(externalBorrower ? { externalOrganization } : {}),
      room: loan.room,
      purpose: loan.purpose
    };
  } else {
    loan = findLoan(state, command.loanId || payload.loanId);
    fromStatus = loan.status;

    // Check coarse capability before the state transition so unauthorized
    // users are consistently rejected by role, regardless of loan status.
    if (command.type === 'request_leader'
      || command.type === 'manager_decide'
      || command.type === 'confirm_handoff'
      || command.type === 'confirm_return') {
      requireManager(actorId, actor);
    } else if (command.type === 'leader_opinion') {
      requireApprover(actorId, actor);
    } else if (command.type === 'request_return') {
      requireBorrower(actorId, actor);
    }

    requireTransition(loan, command.type);

    if (command.type === 'request_leader') {
      const leaderId = textValue(payload.leaderId || payload.leaderKey, 'leaderId', { required: true, max: 50 });
      const leader = state.staff[leaderId];
      fail(!leader || !['thuong', 'cong'].includes(leaderId) || leader.role !== 'approver', 400, 'VALIDATION_ERROR', 'Lãnh đạo được xin ý kiến không hợp lệ.', { leaderId });
      loan.requestedLeaderId = leaderId;
      loan.requestedLeaderKey = leaderId;
      loan.requestedLeaderName = leader.name;
      loan.managerRequestNote = textValue(payload.note, 'note', { max: 2000 });
      loan.leaderDecision = null;
      loan.leaderNote = '';
      loan.leaderRespondedAt = null;
      loan.status = 'pending_leader';
      details = { leaderId, leaderName: leader.name, note: loan.managerRequestNote };
    }

    if (command.type === 'leader_opinion') {
      fail(loan.requestedLeaderId !== actorId && loan.requestedLeaderKey !== actorId, 403, 'FORBIDDEN', 'Chỉ lãnh đạo được chỉ định mới được cho ý kiến phiếu này.', { assignedLeaderId: loan.requestedLeaderId || loan.requestedLeaderKey });
      const decision = decisionValue(payload.decision);
      loan.leaderDecision = decision;
      loan.leaderNote = textValue(payload.note, 'note', { max: 2000 });
      loan.leaderRespondedAt = now;
      loan.status = 'leader_opinion_returned';
      details = { decision, note: loan.leaderNote };
    }

    if (command.type === 'manager_decide') {
      const decision = decisionValue(payload.decision);
      loan.managerDecision = decision;
      loan.managerNote = textValue(payload.note, 'note', { max: 2000 });
      loan.managerDecidedAt = now;
      loan.status = decision === 'approve' ? 'approved' : 'rejected';
      details = { decision, note: loan.managerNote, leaderDecision: loan.leaderDecision || null };
    }

    if (command.type === 'confirm_handoff') {
      const recipientId = textValue(payload.recipientId || payload.recipientKey || loan.borrowerId, 'recipientId', { required: true, max: 50 });
      fail(!state.staff[recipientId], 400, 'VALIDATION_ERROR', 'Người nhận không hợp lệ.', { recipientId });
      fail(recipientId !== loan.borrowerId && recipientId !== loan.borrowerKey, 403, 'FORBIDDEN', 'Chỉ người đứng tên phiếu được nhận phòng và phương tiện.', {
        borrowerId: loan.borrowerId || loan.borrowerKey, recipientId
      });
      const current = localDateAndTime(now);
      const equipment = payload.equipment == null ? clone(loan.equipment) : equipmentValue(payload.equipment, { required: true });
      validateCatalogEquipment(state, equipment, { checkAvailability: true, requireLendable: true, excludedLoanId: loan.id });
      loan.handoff = {
        recipientId,
        recipientName: recipientId === 'external' ? loan.borrowerName : state.staff[recipientId].name,
        room: textValue(payload.room || loan.room, 'room', { required: true, max: 200 }),
        date: dateValue(payload.date || current.date, 'date', { required: true }),
        time: timeValue(payload.time || current.time, 'time'),
        note: textValue(payload.note, 'note', { max: 2000 }),
        equipment,
        confirmedBy: actorId,
        confirmedAt: now
      };
      loan.status = 'borrowing';
      details = { recipientId, room: loan.handoff.room, date: loan.handoff.date, time: loan.handoff.time, note: loan.handoff.note };
    }

    if (command.type === 'request_return') {
      fail(loan.borrowerId !== actorId && loan.borrowerKey !== actorId, 403, 'FORBIDDEN', 'Chỉ người mượn mới được gửi yêu cầu trả phiếu này.', { borrowerId: loan.borrowerId || loan.borrowerKey });
      const current = localDateAndTime(now);
      const equipment = payload.equipment == null ? clone(loan.handoff?.equipment || loan.equipment) : equipmentValue(payload.equipment, { required: true });
      validateCatalogEquipment(state, equipment);
      loan.returnRequest = {
        returnedBy: actorId,
        returnedByName: actorId === 'external' ? loan.borrowerName : actor.name,
        room: textValue(payload.room || loan.handoff?.room || loan.room, 'room', { required: true, max: 200 }),
        date: dateValue(payload.date || current.date, 'date', { required: true }),
        time: timeValue(payload.time || current.time, 'time'),
        note: textValue(payload.note, 'note', { max: 2000 }),
        equipment,
        requestedAt: now
      };
      loan.status = 'return_pending';
      details = { returnedBy: actorId, room: loan.returnRequest.room, date: loan.returnRequest.date, time: loan.returnRequest.time, note: loan.returnRequest.note };
    }

    if (command.type === 'confirm_return') {
      const equipment = payload.equipment == null ? clone(loan.returnRequest?.equipment || loan.equipment) : equipmentValue(payload.equipment, { required: true });
      validateCatalogEquipment(state, equipment);
      const hasExplicitManagerNote = payload.managerNote != null;
      const managerNote = hasExplicitManagerNote ? payload.managerNote : payload.note;
      const normalizedManagerNote = textValue(managerNote, 'managerNote', { max: 2000 });
      loan.returnConfirmation = {
        note: normalizedManagerNote,
        ...(hasExplicitManagerNote ? { managerNote: normalizedManagerNote } : {}),
        generalNote: textValue(payload.generalNote, 'generalNote', { max: 2000 }),
        equipment,
        confirmedBy: actorId,
        confirmedAt: now
      };
      loan.status = 'returned';
      details = { note: loan.returnConfirmation.note, generalNote: loan.returnConfirmation.generalNote };
    }

    loan.updatedAt = now;
  }

  state.version += 1;
  state.updatedAt = now;
  const event = createEvent(state, command, actorId, actor, loan, fromStatus, details, now);
  return { loan, event };
}

async function readRequestJson(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  fail(contentType && !contentType.startsWith('application/json'), 415, 'UNSUPPORTED_MEDIA_TYPE', 'Yêu cầu phải dùng Content-Type application/json.');
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    fail(Buffer.byteLength(body) > maxBodyBytes, 413, 'BODY_TOO_LARGE', 'Nội dung yêu cầu vượt quá 1 MB.');
  }
  fail(!body.trim(), 400, 'INVALID_JSON', 'Nội dung JSON không được để trống.');
  try {
    const parsed = JSON.parse(body);
    fail(!parsed || typeof parsed !== 'object' || Array.isArray(parsed), 400, 'INVALID_JSON', 'Nội dung lệnh phải là một đối tượng JSON.');
    return parsed;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'INVALID_JSON', 'Nội dung JSON không hợp lệ.');
  }
}

function safeOriginalUploadName(value, extension) {
  let decoded = typeof value === 'string' ? value : '';
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    decoded = '';
  }
  decoded = path.win32.basename(path.posix.basename(decoded))
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, '_')
    .trim()
    .slice(0, 200);
  return decoded || `image${extension}`;
}

async function readUploadBody(req) {
  const rawContentType = String(req.headers['content-type'] || '').toLowerCase();
  const contentType = rawContentType.split(';', 1)[0].trim();
  const type = uploadTypes.get(contentType);
  fail(!type, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Chi ho tro anh JPEG, PNG hoac WebP.');
  const declaredLength = Number(req.headers['content-length']);
  fail(Number.isFinite(declaredLength) && declaredLength > maxUploadBytes, 413, 'BODY_TOO_LARGE', `Anh khong duoc vuot qua ${maxUploadBytes} byte.`);

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    fail(size > maxUploadBytes, 413, 'BODY_TOO_LARGE', `Anh khong duoc vuot qua ${maxUploadBytes} byte.`);
    chunks.push(chunk);
  }
  fail(size === 0, 400, 'EMPTY_UPLOAD', 'Tep anh khong duoc de trong.');
  const buffer = Buffer.concat(chunks, size);
  fail(!type.matches(buffer), 400, 'INVALID_IMAGE', 'Noi dung tep khong khop voi dinh dang anh da khai bao.');
  return { buffer, contentType, extension: type.extension, size };
}

async function saveUpload(req) {
  const upload = await readUploadBody(req);
  await fsp.mkdir(uploadRoot, { recursive: true });
  const filename = `${crypto.randomUUID().replace(/-/g, '')}${upload.extension}`;
  const file = path.join(uploadRoot, filename);
  await fsp.writeFile(file, upload.buffer, { flag: 'wx', mode: 0o600 });
  return {
    url: `${uploadUrlPrefix}${filename}`,
    filename,
    contentType: upload.contentType,
    size: upload.size,
    originalName: safeOriginalUploadName(req.headers['x-file-name'], upload.extension)
  };
}

async function serveUpload(req, res, pathname) {
  fail(!['GET', 'HEAD'].includes(req.method), 405, 'METHOD_NOT_ALLOWED', 'Chi ho tro GET/HEAD tep anh.');
  const filename = pathname.slice(uploadUrlPrefix.length);
  fail(!uploadFilenamePattern.test(filename), 404, 'NOT_FOUND', 'Khong tim thay anh.');
  const file = path.resolve(uploadRoot, filename);
  fail(!file.startsWith(`${uploadRoot}${path.sep}`), 403, 'FORBIDDEN_PATH', 'Duong dan anh khong hop le.');
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new ApiError(404, 'NOT_FOUND', 'Khong tim thay anh.');
    throw error;
  }
  fail(!stat.isFile(), 404, 'NOT_FOUND', 'Khong tim thay anh.');
  res.writeHead(200, {
    'Content-Type': types[path.extname(filename).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Disposition': `inline; filename="${filename}"`,
    'X-Content-Type-Options': 'nosniff'
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

async function persistState(nextState) {
  const tempFile = `${stateFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const data = `${JSON.stringify(nextState, null, 2)}\n`;
  let handle;
  try {
    handle = await fsp.open(tempFile, 'wx');
    await handle.writeFile(data, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(tempFile, stateFile);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fsp.unlink(tempFile).catch(() => {});
    throw error;
  }
}

function validateLoadedState(value) {
  fail(!value || typeof value !== 'object' || Array.isArray(value), 500, 'INVALID_STATE', 'Kho dữ liệu workflow không hợp lệ.');
  fail(!Number.isInteger(value.version) || value.version < 0, 500, 'INVALID_STATE', 'Phiên bản kho dữ liệu không hợp lệ.');
  fail(!Number.isInteger(value.nextSequence) || value.nextSequence < 1, 500, 'INVALID_STATE', 'Bộ đếm mã phiếu không hợp lệ.');
  fail(!Array.isArray(value.loans) || !Array.isArray(value.events), 500, 'INVALID_STATE', 'Danh sách phiếu hoặc nhật ký không hợp lệ.');
  const ids = new Set();
  for (const loan of value.loans) {
    fail(!loan || typeof loan.id !== 'string' || ids.has(loan.id), 500, 'INVALID_STATE', 'Mã phiếu trong kho dữ liệu bị thiếu hoặc trùng.');
    ids.add(loan.id);
  }
  if (!value.loanSequences || typeof value.loanSequences !== 'object' || Array.isArray(value.loanSequences)) {
    value.loanSequences = {};
  }
  for (const loan of value.loans) {
    const parsed = yearFromLoanId(loan.id);
    if (!parsed) continue;
    const current = Number(value.loanSequences[parsed.year]);
    value.loanSequences[parsed.year] = Math.max(Number.isInteger(current) ? current : 0, parsed.sequence);
  }
  if (!Array.isArray(value.inventory)) value.inventory = clone(inventoryCatalog);
  const inventoryIds = new Set();
  value.inventory = value.inventory.map((asset) => {
    fail(!asset || typeof asset !== 'object' || Array.isArray(asset), 500, 'INVALID_STATE', 'Bản ghi phương tiện trong kho dữ liệu không hợp lệ.');
    const id = String(asset.id || '').trim().toUpperCase();
    const name = String(asset.name || '').trim();
    const model = String(asset.model || '').trim();
    const qty = Number(asset.qty ?? asset.quantity);
    const status = String(asset.status || '').trim();
    fail(!id || !name || !model || inventoryIds.has(id), 500, 'INVALID_STATE', 'Thông tin phương tiện trong kho dữ liệu bị thiếu hoặc trùng.', { assetId: id });
    fail(!Number.isInteger(qty) || qty < 0 || qty > 100000, 500, 'INVALID_STATE', 'Số lượng phương tiện trong kho dữ liệu không hợp lệ.', { assetId: id });
    fail(!equipmentStatuses.has(status), 500, 'INVALID_STATE', 'Trạng thái phương tiện trong kho dữ liệu không hợp lệ.', { assetId: id, status });
    inventoryIds.add(id);
    return {
      id,
      name,
      model,
      room: String(asset.room || '').trim(),
      qty,
      status,
      note: String(asset.note || '').trim(),
      custom: Boolean(asset.custom),
      ...(asset.createdAt ? { createdAt: asset.createdAt } : {}),
      ...(asset.updatedAt ? { updatedAt: asset.updatedAt } : {})
    };
  });
  if (!Array.isArray(value.rooms)) value.rooms = clone(roomCatalog);
  const roomIds = new Set();
  value.rooms = value.rooms.map((room) => {
    fail(!room || typeof room !== 'object' || Array.isArray(room), 500, 'INVALID_STATE', 'Bản ghi phòng thực hành không hợp lệ.');
    const id = String(room.id || '').trim();
    const name = String(room.name || '').trim();
    const roomFunction = String(room.function || '').trim();
    const capacity = Number(room.capacity ?? 0);
    const operationalStatus = String(room.operationalStatus || 'Tốt').trim();
    fail(!id || !name || roomIds.has(id), 500, 'INVALID_STATE', 'Thông tin phòng thực hành bị thiếu hoặc trùng.', { roomId: id });
    fail(!Number.isInteger(capacity) || capacity < 0 || capacity > 100000, 500, 'INVALID_STATE', 'Sức chứa phòng thực hành không hợp lệ.', { roomId: id });
    fail(!roomStatuses.has(operationalStatus), 500, 'INVALID_STATE', 'Tình trạng phòng thực hành không hợp lệ.', { roomId: id, operationalStatus });
    roomIds.add(id);
    return {
      id,
      name,
      function: roomFunction,
      capacity,
      operationalStatus,
      custom: Boolean(room.custom),
      ...(room.createdAt ? { createdAt: room.createdAt } : {}),
      ...(room.updatedAt ? { updatedAt: room.updatedAt } : {})
    };
  });
  value.schemaVersion = 3;
  value.staff = staff;
  return value;
}

async function loadState() {
  try {
    const parsed = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
    const requiresMigration = parsed.schemaVersion !== 3 || !Array.isArray(parsed.inventory) || !parsed.loanSequences;
    const validated = validateLoadedState(parsed);
    if (requiresMigration) await persistState(validated);
    return validated;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const initial = makeEmptyState();
    await persistState(initial);
    return initial;
  }
}

function executeCommand(currentState, inputCommand) {
  const current = validateLoadedState(clone(currentState));
  const command = clone(inputCommand);
  fail(!command || typeof command !== 'object' || Array.isArray(command), 400, 'INVALID_COMMAND', 'Lệnh không hợp lệ.');
  const type = textValue(command.type, 'type', { required: true, max: 50 });
  fail(!['submit', ...Object.keys(allowedTransitions), ...inventoryCommandTypes, ...roomCommandTypes].includes(type), 400, 'UNKNOWN_COMMAND', `Không hỗ trợ lệnh ${type}.`, { type });
  command.type = type;
  command.commandId = textValue(command.commandId, 'commandId', { max: 100 }) || `CMD-${crypto.randomUUID()}`;
  const { actorId, actor } = actorFromState(current, command);
  command.commandHash = crypto.createHash('sha256').update(canonicalJson({
    type,
    actorId,
    loanId: command.loanId || command.payload?.loanId || null,
    payload: command.payload || {}
  })).digest('hex');

  const duplicate = current.events.find((event) => event.commandId === command.commandId);
  if (duplicate) {
    const targetLoanId = command.loanId || command.payload?.loanId || duplicate.loanId;
    fail(
      duplicate.type !== type
        || duplicate.actorId !== actorId
        || duplicate.loanId !== targetLoanId
        || (duplicate.commandHash && duplicate.commandHash !== command.commandHash),
      409,
      'COMMAND_ID_CONFLICT',
      'commandId đã được dùng cho một lệnh khác.',
      { commandId: command.commandId }
    );
    return {
      ok: true,
      duplicate: true,
      version: current.version,
      loan: duplicate.loanId ? clone(current.loans.find((item) => item.id === duplicate.loanId)) : null,
      inventoryItem: duplicate.entityId
        ? clone(current.inventory.find((item) => item.id === duplicate.entityId) || null)
        : null,
      event: clone(duplicate),
      state: current
    };
  }

  if (command.expectedVersion != null) {
    fail(!Number.isInteger(command.expectedVersion) || command.expectedVersion < 0, 400, 'VALIDATION_ERROR', 'expectedVersion phải là số nguyên không âm.', { field: 'expectedVersion' });
    fail(command.expectedVersion !== current.version, 409, 'VERSION_CONFLICT', 'Dữ liệu đã thay đổi. Hãy tải trạng thái mới trước khi xác nhận lại.', {
      expectedVersion: command.expectedVersion,
      currentVersion: current.version
    });
  }

  const nextState = clone(current);
  const result = applyCommand(nextState, command, actorId, actor, new Date().toISOString());
  const response = {
    ok: true,
    version: nextState.version,
    event: clone(result.event),
    state: nextState
  };
  if (result.loan) response.loan = clone(result.loan);
  if (Object.prototype.hasOwnProperty.call(result, 'inventoryItem')) response.inventoryItem = clone(result.inventoryItem);
  if (Object.prototype.hasOwnProperty.call(result, 'roomItem')) response.roomItem = clone(result.roomItem);
  return response;
}

function enqueueCommand(command) {
  const operation = writeQueue.then(async () => {
    const response = executeCommand(workflowState, command);
    if (response.duplicate) return response;
    await persistState(response.state);
    workflowState = response.state;
    broadcastState();
    return response;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

function writeSse(res, state = workflowState) {
  res.write(`id: ${state.version}\n`);
  res.write('event: state\n');
  res.write(`data: ${JSON.stringify(state)}\n\n`);
}

function broadcastState() {
  for (const res of eventClients) {
    try {
      writeSse(res);
    } catch {
      eventClients.delete(res);
      res.destroy();
    }
  }
}

function openEventStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  res.write('retry: 2000\n\n');
  writeSse(res);
  eventClients.add(res);
  const close = () => eventClients.delete(res);
  req.on('close', close);
  res.on('close', close);
  res.on('error', close);
}

async function serveStatic(req, res, pathname) {
  fail(!['GET', 'HEAD'].includes(req.method), 405, 'METHOD_NOT_ALLOWED', 'Phương thức không được hỗ trợ.');
  let relative = pathname === '/' ? 'index.html' : pathname.replace(/^[/\\]+/, '');
  fail(relative.includes('\0'), 400, 'INVALID_PATH', 'Đường dẫn không hợp lệ.');
  const file = path.resolve(root, relative);
  fail(file !== root && !file.startsWith(`${root}${path.sep}`), 403, 'FORBIDDEN_PATH', 'Không được truy cập ngoài thư mục ứng dụng.');
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy tài nguyên.');
    throw error;
  }
  fail(!stat.isFile(), 404, 'NOT_FOUND', 'Không tìm thấy tài nguyên.');
  res.writeHead(200, {
    'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'X-Content-Type-Options': 'nosniff'
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file);
  stream.on('error', () => {
    if (!res.headersSent) json(res, 500, { ok: false, error: 'READ_ERROR', message: 'Không thể đọc tài nguyên.' });
    else res.destroy();
  });
  stream.pipe(res);
}

async function route(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    throw new ApiError(400, 'INVALID_PATH', 'Đường dẫn không hợp lệ.');
  }

  if (pathname === '/api/state') {
    fail(req.method !== 'GET' && req.method !== 'HEAD', 405, 'METHOD_NOT_ALLOWED', 'Chỉ hỗ trợ GET /api/state.');
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    json(res, 200, workflowState);
    return;
  }

  if (pathname === '/api/commands') {
    fail(req.method !== 'POST', 405, 'METHOD_NOT_ALLOWED', 'Chỉ hỗ trợ POST /api/commands.');
    const command = await readRequestJson(req);
    json(res, 200, await enqueueCommand(command));
    return;
  }

  if (pathname === '/api/uploads') {
    fail(req.method !== 'POST', 405, 'METHOD_NOT_ALLOWED', 'Chi ho tro POST /api/uploads.');
    json(res, 201, { ok: true, upload: await saveUpload(req) });
    return;
  }

  if (pathname === '/api/events') {
    fail(req.method !== 'GET', 405, 'METHOD_NOT_ALLOWED', 'Chỉ hỗ trợ GET /api/events.');
    openEventStream(req, res);
    return;
  }

  if (pathname.startsWith(uploadUrlPrefix)) {
    await serveUpload(req, res, pathname);
    return;
  }

  await serveStatic(req, res, pathname);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof ApiError) {
      json(res, error.status, { ok: false, error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) });
      return;
    }
    console.error(error);
    json(res, 500, { ok: false, error: 'INTERNAL_ERROR', message: 'Máy chủ không thể hoàn tất yêu cầu.' });
  });
});

const heartbeat = setInterval(() => {
  for (const res of eventClients) {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      eventClients.delete(res);
      res.destroy();
    }
  }
}, 20000);
heartbeat.unref();

async function start() {
  workflowState = await loadState();
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`KTHS server running at http://${host}:${actualPort}/`);
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Không thể khởi động máy chủ KTHS:', error);
    process.exitCode = 1;
  });
}

module.exports = {
  ApiError,
  clone,
  executeCommand,
  makeEmptyState,
  server,
  start,
  validateLoadedState
};
