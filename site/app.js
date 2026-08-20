const pageTitle = document.getElementById('pageTitle');
const toast = document.getElementById('toast');
const overviewView = document.getElementById('overviewView');
const roomsView = document.getElementById('roomsView');
const equipmentView = document.getElementById('equipmentView');
const borrowView = document.getElementById('borrowView');
const createBorrowView = document.getElementById('createBorrowView');
const approvalView = document.getElementById('approvalView');
const handoffView = document.getElementById('handoffView');
const returnView = document.getElementById('returnView');
const reportsView = document.getElementById('reportsView');
const appViews = [overviewView, roomsView, equipmentView, borrowView, createBorrowView, approvalView, handoffView, returnView, reportsView].filter(Boolean);
let toastTimer;
const sourceData = window.KTHS_SOURCE_DATA || { staff: {}, permissions: [], rooms: [], assets: [], summary: {} };
const sourceAssetIds = new Set();
const validSourceAssets = (sourceData.assets || []).filter((asset) => {
  const id = String(asset?.id || '').trim();
  const name = String(asset?.name || '').trim();
  const quantity = Number(asset?.qty || 0);
  if (!id || !name || !Number.isFinite(quantity) || quantity <= 0 || sourceAssetIds.has(id)) return false;
  sourceAssetIds.add(id);
  return true;
});
let liveWorkflowState = { version: 0, loans: [], events: [] };
let equipmentData = [];
let roomData = [];
const borrowEquipmentSelection = new Map();
let borrowEquipmentPickerQuery = '';
const workflowServerMode = /^https?:$/.test(window.location.protocol);
let serverInventoryReady = false;
let serverRoomsReady = false;
const ROOM_SERVER_MIGRATION_KEY = 'kthsRoomsMigratedToServerV2';
let hasLocalRoomMigration = false;
const staffEntries = Object.entries(sourceData.staff);
let activeUserKey = 'huan';
const DEFAULT_USER_PASSWORD = '3103';
const USER_PASSWORDS_STORAGE_KEY = 'kthsUserPasswordsV1';
let authenticatedUserKey = null;
let userPasswords = {};
let topProfileMenuMode = 'users';
try {
  const storedPasswords = JSON.parse(localStorage.getItem(USER_PASSWORDS_STORAGE_KEY) || '{}');
  if (storedPasswords && typeof storedPasswords === 'object') userPasswords = storedPasswords;
} catch {
  userPasswords = {};
}

const sharedNavigationViews = ['overviewView', 'roomsView', 'equipmentView', 'borrowView', 'reportsView'];
const sharedBorrowViews = [...sharedNavigationViews, 'createBorrowView', 'returnView'];
const navigationViewsByRole = {
  manager: new Set(sharedNavigationViews),
  approver: new Set(sharedNavigationViews),
  teacher: new Set(sharedNavigationViews)
};

const internalViewsByRole = {
  manager: new Set([...sharedBorrowViews, 'approvalView', 'handoffView']),
  approver: new Set([...sharedBorrowViews, 'approvalView']),
  teacher: new Set(sharedBorrowViews)
};

function activeRole() {
  return sourceData.staff[activeUserKey]?.role || 'teacher';
}

function accessGroupFor(key, user = sourceData.staff[key]) {
  if (key === 'huan' && user?.role === 'manager') return 'manager';
  if (['thuong', 'cong'].includes(key) && user?.role === 'approver') return 'approver';
  return 'teacher';
}

function activeAccessGroup() {
  return accessGroupFor(activeUserKey);
}

function staffTitleFor(key, user = sourceData.staff[key]) {
  const configuredTitle = String(user?.title || '').trim();
  if (configuredTitle) return configuredTitle;
  if (key === 'huan') return 'Cán bộ quản lý';
  if (['cong', 'thuong', 'tot', 'thanh'].includes(key)) return 'PTK';
  return 'GV';
}

function isViewAllowed(targetView, { navigation = false } = {}) {
  if (!targetView?.id) return false;
  const matrix = navigation ? navigationViewsByRole : internalViewsByRole;
  return (matrix[activeAccessGroup()] || matrix.teacher).has(targetView.id);
}

function moveToBorrowView() {
  appViews.forEach((view) => view.classList.toggle('view-hidden', view !== borrowView));
  if (pageTitle) pageTitle.textContent = 'Quản lý Mượn - Trả';
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.view === 'borrowView');
  });
  window.scrollTo(0, 0);
}

function applyRoleAccess() {
  const accessGroup = activeAccessGroup();
  document.body.dataset.userRole = accessGroup;
  document.querySelectorAll('.nav-item').forEach((item) => {
    const targetView = document.getElementById(item.dataset.view || '');
    const allowed = isViewAllowed(targetView, { navigation: true });
    item.hidden = !allowed;
    item.disabled = !allowed;
    item.classList.toggle('role-hidden', !allowed);
    item.setAttribute('aria-hidden', String(!allowed));
  });

  const currentView = appViews.find((view) => !view.classList.contains('view-hidden'));
  if (!isViewAllowed(currentView)) moveToBorrowView();
}

function canManageInventory() {
  const user = sourceData.staff[activeUserKey];
  return activeUserKey === 'huan' && user?.role === 'manager' && isUserAuthenticated();
}

function inventoryMutationReady() {
  return !workflowServerMode || serverInventoryReady;
}

function currentEquipmentCatalog() {
  if (serverInventoryReady || equipmentData.length) return equipmentData;
  return validSourceAssets;
}

function applyInventoryAccess() {
  const canManage = canManageInventory();
  const canMutate = canManage && inventoryMutationReady();
  ['addRoom', 'addEquipment'].forEach((id) => {
    const button = document.getElementById(id);
    if (!button) return;
    button.hidden = !canManage;
    button.disabled = !canMutate;
    button.style.display = canManage ? '' : 'none';
    button.setAttribute('aria-hidden', String(!canManage));
    if (canManage && !canMutate) button.title = 'Đang đồng bộ dữ liệu quản lý';
    else if (button.title === 'Đang đồng bộ dữ liệu quản lý') button.removeAttribute('title');
  });
  if (!canManage) {
    const dialog = document.getElementById('equipmentDialog');
    if (dialog?.open) dialog.close();
  }
}
window.KTHSActiveUserKey = activeUserKey;

function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  return words.length ? words.slice(-2).map((word) => word[0]).join('').toUpperCase() : 'NV';
}

function passwordForUser(key) {
  const configured = String(userPasswords?.[key] ?? '').trim();
  return configured || DEFAULT_USER_PASSWORD;
}

function isUserAuthenticated(key = activeUserKey) {
  if (window.KTHSAuth) return window.KTHSAuth.isAuthenticated(key);
  return authenticatedUserKey === key;
}

function emitAuthChange() {
  window.dispatchEvent(new CustomEvent('kths:authchange', {
    detail: { key: activeUserKey, authenticated: isUserAuthenticated() }
  }));
}

function updateDataGate() {
  // Business data is readable without a password. Authentication is still
  // enforced by workflow/inventory actions through isUserAuthenticated().
  document.body.classList.remove('auth-data-locked');
  document.body.dataset.authenticated = 'true';
  const gate = document.getElementById('authDataGate');
  if (gate) gate.hidden = true;
}

function focusPasswordInput(key = activeUserKey) {
  const input = document.querySelector(`.profile-password-input[data-password-for="${CSS.escape(key)}"]`);
  input?.focus();
  input?.select();
}

function requireAuthentication() {
  if (isUserAuthenticated()) return true;
  setTopProfileMenuMode('password');
  const menu = document.getElementById('topProfileMenu');
  const buttons = document.querySelectorAll('#topProfileButton, #passwordTopButton');
  if (menu && buttons.length) {
    menu.hidden = false;
    buttons.forEach((button) => button.setAttribute('aria-expanded', 'true'));
  }
  focusPasswordInput();
  showToast('Vui lòng nhập mật khẩu để thực hiện thao tác');
  return false;
}

function updatePasswordUi() {
  renderProfileOptions('topProfileOptions', { passwordOnly: topProfileMenuMode === 'password' });
  renderProfileOptions('sidebarProfileOptions');
  applyInventoryAccess();
  updateDataGate();
  emitAuthChange();
}

function closeTopProfileMenu() {
  const menu = document.getElementById('topProfileMenu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  document.querySelectorAll('#topProfileButton, #passwordTopButton').forEach((button) => {
    button.setAttribute('aria-expanded', 'false');
  });
}

async function authenticateUser(key, value) {
  if (key !== activeUserKey) return false;
  const input = document.querySelector(`.profile-password-input[data-password-for="${CSS.escape(key)}"]`);
  if (window.KTHSAuth) {
    try {
      const profile = await window.KTHSAuth.signIn(key, String(value || ''));
      authenticatedUserKey = profile.staffKey;
      input?.setCustomValidity('');
      if (input) input.value = '';
      updatePasswordUi();
      closeTopProfileMenu();
      showToast(`Đã xác thực ${sourceData.staff[key]?.name || ''}`.trim());
      return true;
    } catch (error) {
      if (input) {
        input.value = '';
        input.setCustomValidity('Mật khẩu không đúng hoặc tài khoản chưa được cấu hình.');
        input.reportValidity();
      }
      authenticatedUserKey = null;
      updatePasswordUi();
      showToast(error.message || 'Không thể đăng nhập');
      return false;
    }
  }
  if (String(value || '') !== passwordForUser(key)) {
    if (input) {
      input.value = '';
      input.setCustomValidity('Mật khẩu không đúng.');
      input.reportValidity();
    }
    authenticatedUserKey = null;
    updatePasswordUi();
    showToast('Mật khẩu không đúng');
    return false;
  }
  input?.setCustomValidity('');
  authenticatedUserKey = key;
  updatePasswordUi();
  closeTopProfileMenu();
  showToast(`Đã xác thực ${sourceData.staff[key]?.name || ''}`.trim());
  return true;
}

async function changeUserPassword(key) {
  if (key !== activeUserKey) {
    showToast('Hãy chọn người dùng trước khi đổi mật khẩu');
    return;
  }
  if (!isUserAuthenticated(key)) {
    requireAuthentication();
    return;
  }
  const nextPassword = window.prompt('Nhập mật khẩu mới');
  if (nextPassword === null) return;
  const trimmed = String(nextPassword).trim();
  if (!trimmed) {
    showToast('Mật khẩu mới không được để trống');
    return;
  }
  if (window.KTHSAuth) {
    try {
      await window.KTHSAuth.updatePassword(trimmed);
      await window.KTHSAuth.signOut();
      authenticatedUserKey = null;
      updatePasswordUi();
      requireAuthentication();
      showToast('Đã đổi mật khẩu. Vui lòng nhập lại mật khẩu mới');
    } catch (error) {
      showToast(error.message || 'Không thể đổi mật khẩu');
    }
    return;
  }
  userPasswords[key] = trimmed;
  localStorage.setItem(USER_PASSWORDS_STORAGE_KEY, JSON.stringify(userPasswords));
  authenticatedUserKey = null;
  updatePasswordUi();
  requireAuthentication();
  showToast('Đã đổi mật khẩu. Vui lòng nhập lại mật khẩu mới');
}

window.KTHSIsAuthenticated = () => isUserAuthenticated();
window.KTHSRequireAuthentication = requireAuthentication;

function renderProfileOptions(containerId, { passwordOnly = false } = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const entries = passwordOnly && containerId === 'topProfileOptions'
    ? [[activeUserKey, sourceData.staff[activeUserKey]]]
    : staffEntries;
  container.innerHTML = entries.filter(([, user]) => user).map(([key, user]) => `
    <div class="profile-user-option${key === activeUserKey ? ' selected' : ''}">
      <button class="profile-user-select" type="button" data-user-key="${escapeHtml(key)}">
        <span class="avatar avatar-option">${escapeHtml(initials(user.name))}</span>
        <span><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(staffTitleFor(key, user))}${isUserAuthenticated(key) ? ' · Đã xác thực' : ''}</small></span>
      </button>
      ${passwordOnly ? `<div class="profile-password-row">
        <input class="profile-password-input" type="password" data-password-for="${escapeHtml(key)}" placeholder="Nhập mật khẩu" autocomplete="current-password" aria-label="Mật khẩu ${escapeHtml(user.name)}" />
        <button class="change-password-button" type="button" data-change-password-for="${escapeHtml(key)}"${key !== activeUserKey || !isUserAuthenticated(key) ? ' disabled' : ''}>Đổi MK</button>
      </div>` : ''}
    </div>`).join('');
  container.querySelectorAll('.profile-user-select[data-user-key]').forEach((button) => button.addEventListener('click', () => setActiveUser(button.dataset.userKey)));
  container.querySelectorAll('.profile-password-input[data-password-for]').forEach((input) => {
    input.addEventListener('input', () => input.setCustomValidity(''));
    input.addEventListener('change', () => authenticateUser(input.dataset.passwordFor, input.value));
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      authenticateUser(input.dataset.passwordFor, input.value);
    });
  });
  container.querySelectorAll('.change-password-button[data-change-password-for]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    changeUserPassword(button.dataset.changePasswordFor);
  }));
}

function setActiveUser(key, { notify = true, skipAuthSignOut = false } = {}) {
  const user = sourceData.staff[key];
  if (!user) return;
  const identityChanged = activeUserKey !== key;
  if (identityChanged) {
    resetBorrowEquipmentSelection();
    authenticatedUserKey = null;
    if (window.KTHSAuth?.isAuthenticated() && !skipAuthSignOut) void window.KTHSAuth.signOut();
  }
  activeUserKey = key;
  window.KTHSActiveUserKey = key;
  const role = staffTitleFor(key, user);
  const avatar = initials(user.name);
  document.getElementById('topProfileName')?.replaceChildren(document.createTextNode(user.name));
  document.getElementById('topProfileAvatar')?.replaceChildren(document.createTextNode(avatar));
  document.getElementById('sidebarUserName')?.replaceChildren(document.createTextNode(user.name));
  document.getElementById('sidebarUserRole')?.replaceChildren(document.createTextNode(role));
  document.getElementById('sidebarUserAvatar')?.replaceChildren(document.createTextNode(avatar));
  renderProfileOptions('topProfileOptions');
  renderProfileOptions('sidebarProfileOptions');
  document.querySelectorAll('.top-profile-menu, #profileMenu').forEach((menu) => { menu.hidden = true; });
  document.querySelectorAll('#topProfileButton, #passwordTopButton, #profileButton').forEach((button) => button.setAttribute('aria-expanded', 'false'));
  updateDataGate();
  applyRoleAccess({ identityChanged });
  applyInventoryAccess();
  if (document.getElementById('roomsTableBody')?.children.length) {
    editingRoomId = null;
    renderRoomRows();
  }
  if (document.getElementById('equipmentTableBody')?.children.length) filterEquipment();
  window.dispatchEvent(new CustomEvent('kths:userchange', { detail: { key, user } }));
  if (notify) showToast(`Đã chọn ${user.name} · ${role}`);
}

function renderOverviewSourcePanels() {
  const inventory = currentEquipmentCatalog();
  const rooms = roomData;
  const roomBody = document.getElementById('overviewRoomRows');
  if (roomBody) roomBody.innerHTML = rooms.map((room) => {
    const assets = inventory.filter((asset) => asset.room === room.name);
    const quantity = assets.reduce((sum, asset) => sum + Math.max(0, Number(asset.qty || 0)), 0);
    const status = normalizeRoomOperationalStatus(room.operationalStatus);
    const statusClass = status === 'Tốt' ? 'success' : status === 'Đang bảo trì' ? 'warning' : 'danger';
    return `<tr><td><a href="#">${escapeHtml(room.name)}</a></td><td>${assets.length}</td><td>${quantity}</td><td><span class="status ${statusClass}">${escapeHtml(status)}</span></td></tr>`;
  }).join('');
  const assetBody = document.getElementById('overviewAssetRows');
  if (assetBody) assetBody.innerHTML = inventory.slice(0, 5).map((asset, index) => `<div class="loan-row"><b class="row-number">${index + 1}</b><span class="loan-icon">☷</span><div class="loan-copy"><strong>${escapeHtml(asset.name)}</strong><small>${escapeHtml(asset.room)}</small></div><div class="loan-meta"><span class="status ${equipmentStatusClass(asset.status)}">${escapeHtml(asset.status)}</span><small>${asset.qty} đơn vị</small></div></div>`).join('');
}

function refreshOverviewData() {
  refreshOperationalMetrics();
  renderOverviewSourcePanels();
}

function staffOptionMarkup({ approversOnly = false } = {}) {
  return staffEntries
    .filter(([key, user]) => !approversOnly || accessGroupFor(key, user) === 'approver')
    .map(([key, user]) => `<option value="${escapeHtml(key)}">${escapeHtml(user.name)}</option>`).join('');
}

function roomOptionMarkup() {
  const rooms = roomData.length ? roomData : sourceData.rooms;
  return rooms.map((room) => `<option value="${escapeHtml(room.name)}">${escapeHtml(room.name)}</option>`).join('');
}

function assetOptionMarkup({ includePlaceholder = false } = {}) {
  const placeholder = includePlaceholder ? '<option value="">Chọn thiết bị</option>' : '';
  const inventory = currentEquipmentCatalog();
  const rentable = inventory.filter((asset) => {
    const remaining = Math.max(0, Number(asset.qty || 0) - Number(asset.borrowedQty || 0));
    return asset.status === 'Tốt' && remaining > 0;
  });
  return placeholder + rentable.map((asset) => {
    return `<option value="${escapeHtml(asset.id)}">${escapeHtml(assetChoiceLabel(asset))}</option>`;
  }).join('');
}

function assetChoiceLabel(asset) {
  const details = [asset.room, asset.model].map((value) => String(value || '').trim()).filter(Boolean);
  return details.length ? `${asset.name} — ${details.join(' — ')}` : asset.name;
}

function borrowEquipmentAvailability(asset) {
  const total = Math.max(0, Number(asset?.qty || 0));
  const borrowed = Math.min(total, Math.max(0, Number(asset?.borrowedQty || 0)));
  return { total, borrowed, remaining: Math.max(0, total - borrowed) };
}

function normalizeBorrowEquipmentQuery(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLocaleLowerCase('vi');
}

function borrowEquipmentIsLendable(asset) {
  return asset?.status === 'Tốt' && borrowEquipmentAvailability(asset).remaining > 0;
}

function borrowEquipmentCatalog() {
  const catalog = currentEquipmentCatalog().map((asset) => ({ ...asset }));
  const knownIds = new Set(catalog.map((asset) => asset.id));
  borrowEquipmentSelection.forEach((selection, assetId) => {
    if (knownIds.has(assetId)) return;
    catalog.push({
      id: assetId,
      name: selection.name || 'Phương tiện không còn trong danh mục',
      model: '',
      room: '',
      qty: 0,
      borrowedQty: 0,
      status: 'Không còn trong danh mục',
      missing: true
    });
  });
  return catalog;
}

function borrowEquipmentIssue(asset, selection) {
  const displayName = asset?.name || selection?.name || 'Phương tiện';
  if (!asset || asset.missing) return `Phương tiện ${displayName} không còn trong danh mục.`;
  if (asset.status !== 'Tốt') return `${displayName} hiện ở trạng thái ${asset.status} và không thể mượn.`;
  const { remaining } = borrowEquipmentAvailability(asset);
  if (remaining < 1) return `${displayName} hiện không còn số lượng khả dụng.`;
  const rawQuantity = String(selection?.quantity ?? '').trim();
  if (!/^\d+$/.test(rawQuantity) || Number(rawQuantity) < 1) return `Số lượng ${displayName} phải là số nguyên lớn hơn 0.`;
  if (Number(rawQuantity) > remaining) return `${displayName} chỉ còn ${remaining} thiết bị có thể mượn.`;
  return '';
}

function borrowEquipmentValidation() {
  const catalog = new Map(borrowEquipmentCatalog().map((asset) => [asset.id, asset]));
  const issues = [];
  borrowEquipmentSelection.forEach((selection, assetId) => {
    const message = borrowEquipmentIssue(catalog.get(assetId), selection);
    if (message) issues.push({ assetId, message });
  });
  return {
    valid: borrowEquipmentSelection.size > 0 && issues.length === 0,
    empty: borrowEquipmentSelection.size === 0,
    issues
  };
}

function updateBorrowEquipmentSummary() {
  const catalog = new Map(borrowEquipmentCatalog().map((asset) => [asset.id, asset]));
  const selections = [...borrowEquipmentSelection.entries()];
  const validQuantities = selections.map(([, item]) => Number(item.quantity)).filter((quantity) => Number.isInteger(quantity) && quantity > 0);
  const totalUnits = validQuantities.reduce((sum, quantity) => sum + quantity, 0);
  const validation = borrowEquipmentValidation();
  const summary = document.getElementById('borrowEquipmentSummary');
  const count = document.getElementById('borrowEquipmentCount');
  const pickerSummary = document.getElementById('borrowEquipmentPickerSummary');
  const error = document.getElementById('borrowEquipmentError');
  const trigger = document.getElementById('borrowEquipmentToggle');
  if (count) count.textContent = `${selections.length} đã chọn`;
  if (pickerSummary) {
    pickerSummary.textContent = validation.issues.length
      ? `${validation.issues.length} lựa chọn cần kiểm tra`
      : `Đã chọn ${selections.length} loại · ${totalUnits} thiết bị`;
  }
  if (summary) {
    if (!selections.length) summary.textContent = 'Chọn phương tiện và nhập số lượng';
    else {
      const [firstId, first] = selections[0];
      const firstName = catalog.get(firstId)?.name || 'Phương tiện';
      summary.textContent = selections.length === 1
        ? `${firstName} · SL ${first.quantity}`
        : `${firstName} · SL ${first.quantity} và ${selections.length - 1} loại khác`;
    }
  }
  const validationAttempted = trigger?.dataset.validationAttempted === 'true';
  const showError = validation.issues.length > 0 || (validationAttempted && validation.empty);
  if (error) {
    error.hidden = !showError;
    error.textContent = validation.issues[0]?.message || (validation.empty ? 'Vui lòng chọn ít nhất một phương tiện.' : '');
  }
  trigger?.classList.toggle('has-selection', selections.length > 0);
  trigger?.classList.toggle('is-invalid', showError);
  trigger?.setAttribute('aria-invalid', String(showError));
}

function renderBorrowEquipmentOptions() {
  const container = document.getElementById('borrowEquipmentOptions');
  if (!container) return;
  const query = normalizeBorrowEquipmentQuery(borrowEquipmentPickerQuery);
  const items = borrowEquipmentCatalog().filter((asset) => {
    if (!query) return true;
    return normalizeBorrowEquipmentQuery([asset.name, asset.model, asset.room].join(' ')).includes(query);
  });
  if (!items.length) {
    container.innerHTML = '<div class="borrow-equipment-empty">Không có phương tiện phù hợp.</div>';
    updateBorrowEquipmentSummary();
    return;
  }
  container.innerHTML = items.map((asset) => {
    const { total, borrowed, remaining } = borrowEquipmentAvailability(asset);
    const selection = borrowEquipmentSelection.get(asset.id);
    const checked = Boolean(selection);
    const lendable = borrowEquipmentIsLendable(asset);
    const issue = checked ? borrowEquipmentIssue(asset, selection) : '';
    const quantity = checked ? selection.quantity : '1';
    const statusText = asset.missing
      ? 'Không còn trong danh mục'
      : asset.status !== 'Tốt'
        ? asset.status
        : remaining > 0
          ? `Tổng ${total}, đang mượn ${borrowed}, còn ${remaining}`
          : `Tổng ${total}, hiện đã mượn hết`;
    const details = [asset.room || 'Chưa xếp phòng', statusText].filter(Boolean).join(' · ');
    return `<div class="borrow-equipment-option${checked ? ' is-selected' : ''}${!lendable ? ' is-unavailable' : ''}${issue ? ' is-invalid' : ''}" data-asset-id="${escapeHtml(asset.id)}">
      <label class="borrow-equipment-choice">
        <input class="borrow-equipment-checkbox" type="checkbox" value="${escapeHtml(asset.id)}"${checked ? ' checked' : ''}${!checked && !lendable ? ' disabled' : ''} />
        <span><strong title="${escapeHtml([asset.name, asset.model].filter(Boolean).join(' · '))}">${escapeHtml(asset.name)}</strong><small>${escapeHtml(details)}</small></span>
      </label>
      <label class="borrow-equipment-quantity">
        <span class="sr-only">Số lượng ${escapeHtml(asset.name)}, tối đa ${remaining}</span>
        <span aria-hidden="true">SL</span>
        <input type="text" inputmode="numeric" value="${escapeHtml(quantity)}" data-quantity-for="${escapeHtml(asset.id)}" data-max="${remaining}"${checked ? '' : ' disabled'} aria-invalid="${String(Boolean(issue))}" aria-label="Số lượng ${escapeHtml(asset.name)}, tối đa ${remaining}" />
      </label>
      ${issue ? `<small class="borrow-equipment-option-error">${escapeHtml(issue)}</small>` : ''}
    </div>`;
  }).join('');
  updateBorrowEquipmentSummary();
}

function setBorrowEquipmentPickerOpen(open) {
  const picker = document.getElementById('borrowEquipmentPicker');
  const menu = document.getElementById('borrowEquipmentMenu');
  const toggle = document.getElementById('borrowEquipmentToggle');
  if (!picker || !menu || !toggle) return;
  menu.hidden = !open;
  picker.classList.toggle('is-open', open);
  toggle.setAttribute('aria-expanded', String(open));
  if (open) {
    renderBorrowEquipmentOptions();
    setTimeout(() => document.getElementById('borrowEquipmentSearch')?.focus(), 0);
  }
}

function renderBorrowEquipmentPicker() {
  renderBorrowEquipmentOptions();
  const toggle = document.getElementById('borrowEquipmentToggle');
  if (toggle) {
    const ready = !workflowServerMode || serverInventoryReady;
    toggle.disabled = !ready;
    toggle.title = ready ? '' : 'Đang tải số lượng thiết bị thực tế';
  }
}

function resetBorrowEquipmentSelection() {
  borrowEquipmentSelection.clear();
  borrowEquipmentPickerQuery = '';
  const search = document.getElementById('borrowEquipmentSearch');
  const toggle = document.getElementById('borrowEquipmentToggle');
  if (search) search.value = '';
  if (toggle) delete toggle.dataset.validationAttempted;
  setBorrowEquipmentPickerOpen(false);
  renderBorrowEquipmentPicker();
}

function validateBorrowEquipmentSelection({ focus = false } = {}) {
  const trigger = document.getElementById('borrowEquipmentToggle');
  if (trigger) trigger.dataset.validationAttempted = 'true';
  const validation = borrowEquipmentValidation();
  updateBorrowEquipmentSummary();
  if (!validation.valid && focus) {
    setBorrowEquipmentPickerOpen(true);
    const invalidAssetId = validation.issues[0]?.assetId;
    setTimeout(() => {
      const target = invalidAssetId
        ? document.querySelector(`[data-quantity-for="${CSS.escape(invalidAssetId)}"]`) || document.querySelector(`.borrow-equipment-checkbox[value="${CSS.escape(invalidAssetId)}"]`)
        : trigger;
      target?.focus();
    }, 0);
  }
  return {
    ...validation,
    message: validation.issues[0]?.message || (validation.empty ? 'Vui lòng chọn ít nhất một phương tiện.' : '')
  };
}

window.KTHSGetBorrowEquipmentSelection = () => {
  const catalog = new Map(borrowEquipmentCatalog().map((asset) => [asset.id, asset]));
  return [...borrowEquipmentSelection.entries()].map(([assetId, selection]) => ({
    assetId,
    name: catalog.get(assetId)?.name || selection.name || '',
    quantity: selection.quantity,
    available: borrowEquipmentAvailability(catalog.get(assetId)).remaining,
    note: ''
  }));
};
window.KTHSResetBorrowEquipmentSelection = resetBorrowEquipmentSelection;
window.KTHSValidateBorrowEquipmentSelection = validateBorrowEquipmentSelection;

function populateWorkflowSourceOptions() {
  ['borrowerName', 'handoffRecipient', 'returnBorrower'].forEach((id) => {
    const select = document.getElementById(id);
    if (!select) return;
    const previousValue = select.value;
    select.innerHTML = staffOptionMarkup();
    const preferredValue = id === 'borrowerName'
      ? activeUserKey
      : previousValue;
    if ([...select.options].some((option) => option.value === preferredValue)) select.value = preferredValue;
  });
  const borrowRoom = document.getElementById('borrowRoom');
  if (borrowRoom) {
    const previousValue = borrowRoom.value;
    borrowRoom.innerHTML = '<option value="">Chọn phòng thực hành</option>' + roomOptionMarkup();
    if ([...borrowRoom.options].some((option) => option.value === previousValue)) borrowRoom.value = previousValue;
  }
  const leader = document.getElementById('approvalLeader');
  if (leader) {
    const previousValue = leader.value;
    leader.innerHTML = staffOptionMarkup({ approversOnly: true });
    if ([...leader.options].some((option) => option.value === previousValue)) leader.value = previousValue;
  }
  ['handoffRoom', 'returnRoom'].forEach((id) => {
    const select = document.getElementById(id);
    if (!select) return;
    const previousValue = select.value;
    select.innerHTML = roomOptionMarkup();
    if ([...select.options].some((option) => option.value === previousValue)) select.value = previousValue;
  });
  const reportRoom = document.getElementById('reportRoom');
  if (reportRoom) {
    const previousValue = reportRoom.value;
    reportRoom.innerHTML = '<option>Tất cả</option>' + roomOptionMarkup();
    if ([...reportRoom.options].some((option) => option.value === previousValue)) reportRoom.value = previousValue;
  }
  const reportEquipment = document.getElementById('reportEquipment');
  if (reportEquipment) {
    const previousValue = reportEquipment.value;
    const inventory = currentEquipmentCatalog();
    const names = [...new Set(inventory.map((asset) => asset.name).filter(Boolean))];
    reportEquipment.innerHTML = '<option>Tất cả</option>' + names.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
    if ([...reportEquipment.options].some((option) => option.value === previousValue)) reportEquipment.value = previousValue;
  }
  renderBorrowEquipmentPicker();
}


function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2400);
}

function switchView(targetView, title) {
  if (!targetView) return;
  if (!isViewAllowed(targetView)) {
    moveToBorrowView();
    showToast('Tài khoản hiện tại chỉ được sử dụng chức năng Mượn - Trả');
    return false;
  }
  appViews.forEach((view) => view.classList.toggle('view-hidden', view !== targetView));
  if (title) pageTitle.textContent = title;
  window.scrollTo(0, 0);
  return true;
}

const mobileNavToggle = document.getElementById('mobileNavToggle');
const mobileNavBackdrop = document.getElementById('mobileNavBackdrop');

function setMobileNavigation(open) {
  const isOpen = Boolean(open) && window.matchMedia('(max-width: 900px)').matches;
  document.body.classList.toggle('mobile-nav-open', isOpen);
  mobileNavToggle?.setAttribute('aria-expanded', String(isOpen));
  mobileNavToggle?.setAttribute('aria-label', isOpen ? 'Đóng menu chức năng' : 'Mở menu chức năng');
  if (mobileNavBackdrop) mobileNavBackdrop.hidden = !isOpen;
}

mobileNavToggle?.addEventListener('click', () => setMobileNavigation(!document.body.classList.contains('mobile-nav-open')));
mobileNavBackdrop?.addEventListener('click', () => setMobileNavigation(false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.body.classList.contains('mobile-nav-open')) setMobileNavigation(false);
});
window.addEventListener('resize', () => {
  if (!window.matchMedia('(max-width: 900px)').matches) setMobileNavigation(false);
});

document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', (event) => {
    const section = item.dataset.section;
    const targetView = document.getElementById(item.dataset.view || '');
    if (!isViewAllowed(targetView, { navigation: true })) {
      event.preventDefault();
      event.stopImmediatePropagation();
      moveToBorrowView();
      showToast('Bạn không có quyền truy cập khu vực này');
      return;
    }
    if (!targetView) {
      showToast(`Đang chuẩn bị khu vực ${section}`);
      return;
    }
    document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.remove('active'));
    item.classList.add('active');
    if (!switchView(targetView, section)) return;
    setMobileNavigation(false);
    clearTimeout(toastTimer);
    toast.classList.remove('show');
  });
});

document.querySelectorAll('[data-toast]').forEach((button) => {
  button.addEventListener('click', () => showToast(button.dataset.toast));
});

function openNativeDatePicker(input) {
  if (!input) return;
  try {
    if (typeof input.showPicker === 'function') input.showPicker();
    else {
      input.focus();
      input.click();
    }
  } catch {
    input.focus();
    input.click();
  }
}

function formatVietnameseDate(value) {
  const [year, month, day] = String(value || '').split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (!year || !month || !day || Number.isNaN(date.getTime())) return '';
  const weekdays = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
  return `${weekdays[date.getDay()]}, ${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
}

const dateButton = document.getElementById('dateButton');
const topbarDatePicker = document.getElementById('topbarDatePicker');
const topbarDateText = document.getElementById('topbarDateText');
dateButton?.addEventListener('click', () => openNativeDatePicker(topbarDatePicker));
topbarDatePicker?.addEventListener('change', () => {
  const label = formatVietnameseDate(topbarDatePicker.value);
  if (label && topbarDateText) topbarDateText.textContent = label;
});
const periodSelect = document.getElementById('periodSelect');
if (periodSelect) periodSelect.addEventListener('change', (event) => showToast(`Đã chọn ${event.target.value.toLowerCase()}`));

function bindProfileToggle(buttonId, menuId) {
  const button = document.getElementById(buttonId);
  const menu = document.getElementById(menuId);
  if (!button || !menu) return;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const triggers = [...document.querySelectorAll(`[aria-controls="${menuId}"]`), button]
      .filter((trigger, index, all) => all.indexOf(trigger) === index);
    const desiredMode = buttonId === 'passwordTopButton' ? 'password' : 'users';
    if (menuId === 'topProfileMenu' && !menu.hidden && topProfileMenuMode !== desiredMode) {
      setTopProfileMenuMode(desiredMode);
      triggers.forEach((trigger) => trigger.setAttribute('aria-expanded', 'true'));
      return;
    }
    const willOpen = menu.hidden;
    if (willOpen && menuId === 'topProfileMenu') {
      setTopProfileMenuMode(desiredMode);
    }
    const isOpen = !menu.hidden;
    triggers.forEach((trigger) => trigger.setAttribute('aria-expanded', String(!isOpen)));
    menu.hidden = isOpen;
  });
}

function setTopProfileMenuMode(mode = 'users') {
  topProfileMenuMode = mode === 'password' ? 'password' : 'users';
  const title = document.querySelector('#topProfileMenu .profile-menu-title');
  if (title) title.textContent = topProfileMenuMode === 'password' ? 'Mật khẩu' : 'Người dùng và phân quyền';
  renderProfileOptions('topProfileOptions', { passwordOnly: topProfileMenuMode === 'password' });
}

bindProfileToggle('profileButton', 'profileMenu');
bindProfileToggle('topProfileButton', 'topProfileMenu');
bindProfileToggle('passwordTopButton', 'topProfileMenu');
document.getElementById('authDataGateButton')?.addEventListener('click', requireAuthentication);
renderProfileOptions('topProfileOptions');
renderProfileOptions('sidebarProfileOptions');
setActiveUser(activeUserKey, { notify: false });
window.addEventListener('kths:supabaseauth', (event) => {
  const profile = event.detail?.profile || window.KTHSAuth?.getProfile?.();
  authenticatedUserKey = profile?.staffKey || null;
  if (profile?.staffKey && profile.staffKey !== activeUserKey && sourceData.staff[profile.staffKey]) {
    setActiveUser(profile.staffKey, { notify: false, skipAuthSignOut: true });
  }
  updatePasswordUi();
});
window.KTHSAuth?.ready().then(() => {
  const profile = window.KTHSAuth.getProfile();
  authenticatedUserKey = profile?.staffKey || null;
  if (profile?.staffKey && sourceData.staff[profile.staffKey]) {
    setActiveUser(profile.staffKey, { notify: false, skipAuthSignOut: true });
  } else {
    updatePasswordUi();
  }
});
populateWorkflowSourceOptions();
document.addEventListener('click', () => {
  const menu = document.getElementById('profileMenu');
  const button = document.getElementById('profileButton');
  if (menu && !menu.hidden) { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); }
  const topMenu = document.getElementById('topProfileMenu');
  const topButtons = document.querySelectorAll('#topProfileButton, #passwordTopButton');
  if (topMenu && !topMenu.hidden) {
    topMenu.hidden = true;
    topButtons.forEach((button) => button.setAttribute('aria-expanded', 'false'));
  }
});

document.querySelectorAll('.profile-menu').forEach((menu) => menu.addEventListener('click', (event) => event.stopPropagation()));

const roomSearch = document.getElementById('roomSearch');
const roomStatus = document.getElementById('roomStatus');
const roomBuilding = document.getElementById('roomBuilding');
const roomPagination = document.getElementById('roomPagination');
const roomPageSize = 5;
let roomPage = 1;
let roomSequence = 0;
let editingRoomId = null;
const storedRoomEdits = JSON.parse(localStorage.getItem('kthsRoomEditsV3') || '{}');
const deletedRoomIds = new Set(JSON.parse(localStorage.getItem('kthsDeletedRoomIdsV3') || '[]'));
const roomOperationalStatuses = ['Tốt', 'Đang bảo trì', 'Ngừng hoạt động'];

function normalizeRoomOperationalStatus(value) {
  return roomOperationalStatuses.includes(value) ? value : 'Tốt';
}

function normalizeRoomRecord(room) {
  return {
    id: String(room?.id || '').trim(),
    name: String(room?.name || '').trim(),
    function: String(room?.function || '').trim(),
    capacity: Math.max(0, Number(room?.capacity ?? 0)),
    operationalStatus: normalizeRoomOperationalStatus(room?.operationalStatus),
    statuses: Array.isArray(room?.statuses) ? room.statuses : [],
    custom: Boolean(room?.custom)
  };
}

function syncRoomData(state) {
  if (!Array.isArray(state?.rooms)) return false;
  serverRoomsReady = true;
  const localMigrationPending = hasLocalRoomMigration
    && localStorage.getItem(ROOM_SERVER_MIGRATION_KEY) !== 'done';
  if (localMigrationPending) return false;
  const nextRooms = state.rooms.map(normalizeRoomRecord).filter((room) => room.id && room.name);
  const changed = JSON.stringify(nextRooms) !== JSON.stringify(roomData.map(normalizeRoomRecord));
  if (changed) roomData = nextRooms;
  return changed;
}

window.KTHSGetRoomCatalog = () => roomData.map((room) => ({ ...room }));

function roomHasActiveLoan(roomName) {
  return (liveWorkflowState.loans || []).some((loan) => (
    ['borrowing', 'return_pending'].includes(loan.status)
    && String(loan.handoff?.room || loan.room || '').trim() === String(roomName || '').trim()
  ));
}

roomData = sourceData.rooms.map((room) => {
  const id = `source-${roomSequence++}`;
  return {
    id,
    name: storedRoomEdits[id]?.name || room.name,
    function: storedRoomEdits[id]?.function || '',
    capacity: storedRoomEdits[id]?.capacity || '',
    operationalStatus: normalizeRoomOperationalStatus(storedRoomEdits[id]?.operationalStatus),
    statuses: room.statuses || []
  };
}).filter((room) => !deletedRoomIds.has(room.id));
roomData.push(...Object.entries(storedRoomEdits)
  .filter(([, room]) => room.custom)
  .map(([id, room]) => ({
    id,
    name: room.name || '',
    function: room.function || '',
    capacity: room.capacity || '',
    operationalStatus: normalizeRoomOperationalStatus(room.operationalStatus),
    statuses: []
  })));
const localRoomMigrationSnapshot = roomData.map((room) => normalizeRoomRecord(room)).filter((room) => room.id && room.name);
hasLocalRoomMigration = Object.keys(storedRoomEdits).length > 0 || deletedRoomIds.size > 0;
let roomMigrationInFlight = false;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

renderOverviewSourcePanels();

function saveRoomEdits() {
  if (serverRoomsReady) return;
  const payload = Object.fromEntries(roomData.map((room) => [room.id, {
    name: room.name,
    function: room.function,
    capacity: room.capacity,
    operationalStatus: normalizeRoomOperationalStatus(room.operationalStatus),
    custom: room.id.startsWith('custom-')
  }]));
  localStorage.setItem('kthsRoomEditsV3', JSON.stringify(payload));
  localStorage.setItem('kthsDeletedRoomIdsV3', JSON.stringify([...deletedRoomIds]));
}

function migratedRoomId(roomName) {
  let hash = 2166136261;
  for (const character of String(roomName || '').normalize('NFC')) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `migrated-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

async function migrateLocalRoomsToServer() {
  if (!workflowServerMode || !serverRoomsReady || !hasLocalRoomMigration || roomMigrationInFlight) return;
  if (!canManageInventory() || localStorage.getItem(ROOM_SERVER_MIGRATION_KEY) === 'done') return;
  roomMigrationInFlight = true;
  try {
    for (const localRoom of localRoomMigrationSnapshot) {
      const serverRooms = window.KTHSWorkflow?.getState()?.rooms || [];
      const serverRoomByName = serverRooms.find((room) => room.name === localRoom.name);
      const serverRoomById = serverRooms.find((room) => room.id === localRoom.id);
      const roomId = serverRoomByName?.id
        || (!serverRoomById ? localRoom.id : migratedRoomId(localRoom.name));
      const serverRoom = serverRoomByName || serverRooms.find((room) => room.id === roomId);
      const payload = {
        roomId,
        name: localRoom.name,
        function: localRoom.function,
        capacity: Number(localRoom.capacity || 0),
        operationalStatus: localRoom.operationalStatus
      };
      const same = serverRoom
        && serverRoom.name === payload.name
        && String(serverRoom.function || '') === payload.function
        && Number(serverRoom.capacity || 0) === payload.capacity
        && serverRoom.operationalStatus === payload.operationalStatus;
      if (same) continue;
      await window.KTHSWorkflow.command(serverRoom ? 'update_room' : 'create_room', { payload });
    }
    localStorage.setItem(ROOM_SERVER_MIGRATION_KEY, 'done');
    syncRoomData(window.KTHSWorkflow?.getState());
    populateRoomFilters();
    renderRoomRows();
    populateWorkflowSourceOptions();
    refreshOverviewData();
    showToast('Đã đồng bộ dữ liệu phòng lên hệ thống chung');
  } catch (error) {
    console.error('Room migration failed', error);
    showToast('Chưa thể đồng bộ dữ liệu phòng cũ. Vui lòng thử lại sau');
  } finally {
    roomMigrationInFlight = false;
  }
}

function updateRoomMetrics() {
  refreshOverviewData();
}

function filteredRoomData() {
  const query = (roomSearch?.value || '').toLowerCase().trim();
  const status = roomStatus?.value?.startsWith('Tình trạng:') ? '' : (roomStatus?.value || '');
  const building = roomBuilding?.value || '';
  return roomData.filter((room) => {
    const roomStatusValue = normalizeRoomOperationalStatus(room.operationalStatus);
    const text = `${room.name} ${room.function} ${room.capacity}`.toLowerCase();
    return (!query || text.includes(query)) && (!status || roomStatusValue === status) && (!building || room.name.includes(building));
  });
}

function renderRoomPagination(pageCount) {
  if (!roomPagination) return;
  roomPagination.hidden = pageCount <= 1;
  if (pageCount <= 1) {
    roomPagination.innerHTML = '';
    return;
  }
  roomPagination.innerHTML = `<button type="button" aria-label="Trang trước" data-room-page="${Math.max(1, roomPage - 1)}">‹</button>${Array.from({ length: pageCount }, (_, index) => `<button type="button" class="${index + 1 === roomPage ? 'current' : ''}" data-room-page="${index + 1}">${index + 1}</button>`).join('')}<button type="button" aria-label="Trang sau" data-room-page="${Math.min(pageCount, roomPage + 1)}">›</button>`;
  roomPagination.querySelectorAll('[data-room-page]').forEach((button) => button.addEventListener('click', () => {
    roomPage = Number(button.dataset.roomPage);
    renderRoomRows();
  }));
}

function renderRoomRows() {
  const body = document.getElementById('roomsTableBody');
  if (!body) return;
  const canManage = canManageInventory();
  const filtered = filteredRoomData();
  const pageCount = Math.max(1, Math.ceil(filtered.length / roomPageSize));
  roomPage = Math.min(roomPage, pageCount);
  const start = (roomPage - 1) * roomPageSize;
  body.innerHTML = filtered.slice(start, start + roomPageSize).map((room, index) => {
    const status = normalizeRoomOperationalStatus(room.operationalStatus);
    const statusClass = status === 'Tốt' ? 'success' : status === 'Đang bảo trì' ? 'warning' : 'danger';
    const campus = (room.name.match(/CS\d+/) || [''])[0];
    const isEditing = editingRoomId === room.id;
    const roomLabel = escapeHtml(room.name || `phòng ${start + index + 1}`);
    const editIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
    const deleteIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m4 4v6m6-6v6"/></svg>';
    const saveIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
    const cancelIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
    return `<tr class="${isEditing ? 'room-row-editing' : ''}" data-room-id="${escapeHtml(room.id)}" data-status="${escapeHtml(status)}" data-building="${escapeHtml(campus)}">
      <td>${start + index + 1}</td>
      <td>${isEditing ? `<input class="room-inline-input room-name-input" type="text" value="${escapeHtml(room.name)}" aria-label="Tên phòng ${start + index + 1}" placeholder="Nhập tên phòng" required />` : `<div class="room-name-cell"><span><a href="#">${escapeHtml(room.name || 'Phòng chưa đặt tên')}</a></span></div>`}</td>
      <td><input class="room-inline-input room-function-input" type="text" value="${escapeHtml(room.function)}" aria-label="Công năng ${roomLabel}" placeholder="Nhập công năng" ${isEditing ? '' : 'readonly tabindex="-1"'} /></td>
      <td><div class="room-capacity-field"><input class="room-inline-input room-capacity-input" type="number" min="0" value="${escapeHtml(room.capacity)}" aria-label="Sức chứa ${roomLabel}" placeholder="0" ${isEditing ? '' : 'readonly tabindex="-1"'} /><span>học viên</span></div></td>
      <td>${isEditing
        ? `<select class="room-inline-input room-status-input" aria-label="Tình trạng ${roomLabel}">${roomOperationalStatuses.map((option) => `<option${option === status ? ' selected' : ''}>${option}</option>`).join('')}</select>`
        : `<span class="status ${statusClass}">${escapeHtml(status)}</span>`}</td>
      <td><div class="room-row-actions">${!canManage
        ? '<span class="inventory-readonly-action" aria-label="Chỉ xem">—</span>'
        : isEditing
        ? `<button class="room-action-button room-save-button" type="button" title="Lưu thay đổi" aria-label="Lưu thay đổi ${roomLabel}">${saveIcon}</button><button class="room-action-button room-cancel-button" type="button" title="Hủy chỉnh sửa" aria-label="Hủy chỉnh sửa ${roomLabel}">${cancelIcon}</button>`
        : `<button class="room-action-button room-edit-button" type="button" title="Chỉnh sửa phòng" aria-label="Chỉnh sửa ${roomLabel}">${editIcon}</button><button class="room-action-button room-delete-button" type="button" title="Xóa phòng" aria-label="Xóa ${roomLabel}">${deleteIcon}</button>`}</div></td>
    </tr>`;
  }).join('');
  renderRoomPagination(pageCount);
  updateRoomMetrics();
}

function populateRoomFilters() {
  if (!roomBuilding) return;
  const selected = roomBuilding.value;
  roomBuilding.innerHTML = '<option value="">Cơ sở: Tất cả</option>' + [...new Set(roomData.map((room) => (room.name.match(/CS\d+/) || [''])[0]).filter(Boolean))]
    .map((campus) => `<option value="${escapeHtml(campus)}">${escapeHtml(campus)}</option>`).join('');
  if ([...roomBuilding.options].some((option) => option.value === selected)) roomBuilding.value = selected;
}

function filterRooms() { roomPage = 1; renderRoomRows(); }

populateRoomFilters();
renderRoomRows();
filterRooms();
roomSearch?.addEventListener('input', filterRooms);
roomStatus?.addEventListener('change', filterRooms);
roomBuilding?.addEventListener('change', filterRooms);
document.getElementById('refreshRooms')?.addEventListener('click', () => {
  if (roomSearch) roomSearch.value = '';
  if (roomStatus) roomStatus.selectedIndex = 0;
  if (roomBuilding) roomBuilding.selectedIndex = 0;
  filterRooms();
  showToast('Đã làm mới danh sách phòng');
});
document.getElementById('addRoom')?.addEventListener('click', () => {
  if (!canManageInventory()) {
    showToast('Bạn không có quyền thêm phòng');
    return;
  }
  const newRoom = { id: `custom-${Date.now()}-${roomSequence++}`, name: '', function: '', capacity: '', operationalStatus: 'Tốt', statuses: [] };
  roomData.push(newRoom);
  editingRoomId = newRoom.id;
  roomPage = Math.ceil(roomData.length / roomPageSize);
  renderRoomRows();
  document.querySelector('#roomsTableBody tr:last-child .room-name-input')?.focus();
});

document.getElementById('roomsTableBody')?.addEventListener('click', async (event) => {
  if (!canManageInventory()) {
    if (event.target.closest('button')) showToast('Bạn chỉ có quyền xem danh sách phòng');
    return;
  }
  const row = event.target.closest('tr[data-room-id]');
  const room = roomData.find((item) => item.id === row?.dataset.roomId);
  if (!room || !row) return;

  if (event.target.closest('.room-edit-button')) {
    editingRoomId = room.id;
    renderRoomRows();
    const editedRow = document.querySelector(`#roomsTableBody tr[data-room-id="${CSS.escape(room.id)}"]`);
    (editedRow?.querySelector('.room-name-input') || editedRow?.querySelector('.room-function-input'))?.focus();
    return;
  }

  if (event.target.closest('.room-save-button')) {
    const nameInput = row.querySelector('.room-name-input');
    const functionInput = row.querySelector('.room-function-input');
    const capacityInput = row.querySelector('.room-capacity-input');
    const statusInput = row.querySelector('.room-status-input');
    const name = nameInput?.value.trim() || '';
    const nextStatus = normalizeRoomOperationalStatus(statusInput?.value);
    if (!name) {
      nameInput?.setCustomValidity('Vui lòng nhập tên phòng.');
      nameInput?.reportValidity();
      return;
    }
    nameInput?.setCustomValidity('');
    if (roomHasActiveLoan(room.name) && (name !== room.name || nextStatus !== 'Tốt')) {
      showToast('Phòng đang được mượn nên chưa thể đổi tên hoặc tình trạng');
      return;
    }
    room.name = name;
    room.function = functionInput?.value.trim() || '';
    room.capacity = capacityInput?.value || '';
    room.operationalStatus = nextStatus;
    editingRoomId = null;
    if (serverRoomsReady) {
      try {
        await window.KTHSWorkflow?.command(room.id.startsWith('custom-') ? 'create_room' : 'update_room', {
          payload: {
            roomId: room.id,
            name: room.name,
            function: room.function,
            capacity: Number(room.capacity || 0),
            operationalStatus: room.operationalStatus
          },
          success: `Đã cập nhật ${room.name}`
        });
      } catch {
        editingRoomId = room.id;
        renderRoomRows();
      }
      return;
    }
    saveRoomEdits();
    populateRoomFilters();
    renderRoomRows();
    showToast(`Đã cập nhật ${room.name}`);
    return;
  }

  if (event.target.closest('.room-cancel-button')) {
    if (room.id.startsWith('custom-') && !room.name) roomData = roomData.filter((item) => item.id !== room.id);
    editingRoomId = null;
    renderRoomRows();
    return;
  }

  const button = event.target.closest('.room-delete-button');
  if (!button) return;
  if (roomHasActiveLoan(room.name)) {
    showToast('Không thể xóa phòng khi vẫn còn phiếu mượn đang hoạt động');
    return;
  }
  if (!room || !window.confirm(`Xóa ${room.name || 'phòng chưa đặt tên'} khỏi danh sách?`)) return;
  if (!room.id.startsWith('custom-')) deletedRoomIds.add(room.id);
  roomData = roomData.filter((item) => item.id !== room.id);
  if (serverRoomsReady) {
    try {
      await window.KTHSWorkflow?.command('delete_room', {
        payload: { roomId: room.id },
        success: `Đã xóa ${room.name || 'phòng'} khỏi danh sách`
      });
    } catch {
      renderRoomRows();
    }
    return;
  }
  saveRoomEdits();
  populateRoomFilters();
  renderRoomRows();
  showToast('Đã xóa phòng khỏi danh sách');
});

const equipmentSearch = document.getElementById('equipmentSearch');
const equipmentCategory = document.getElementById('equipmentCategory');
const equipmentRoom = document.getElementById('equipmentRoom');
const equipmentStatus = document.getElementById('equipmentStatus');
const equipmentResultCount = document.getElementById('equipmentResultCount');
const equipmentDialog = document.getElementById('equipmentDialog');
const equipmentEditForm = document.getElementById('equipmentEditForm');
const equipmentDialogTitle = document.getElementById('equipmentDialogTitle');
const equipmentDialogGrid = document.getElementById('equipmentDialogGrid');
const equipmentIdField = document.getElementById('equipmentIdField');
const equipmentNoteField = document.getElementById('equipmentNoteField');
const equipmentSubmitButton = document.getElementById('equipmentSubmitButton');
const equipmentEditName = document.getElementById('equipmentEditName');
const equipmentEditId = document.getElementById('equipmentEditId');
const equipmentEditQuantity = document.getElementById('equipmentEditQuantity');
const equipmentEditModel = document.getElementById('equipmentEditModel');
const equipmentEditRoom = document.getElementById('equipmentEditRoom');
const equipmentEditStatus = document.getElementById('equipmentEditStatus');
const equipmentEditNote = document.getElementById('equipmentEditNote');
const storedEquipmentEdits = JSON.parse(localStorage.getItem('kthsEquipmentEditsV2') || '{}');
const deletedEquipmentIds = new Set(JSON.parse(localStorage.getItem('kthsDeletedEquipmentIdsV2') || '[]'));
equipmentData = validSourceAssets
  .filter((asset) => !deletedEquipmentIds.has(asset.id))
  .map((asset) => normalizeEquipmentRecord({ ...asset, ...(storedEquipmentEdits[asset.id] || {}), custom: false }))
  .concat(Object.entries(storedEquipmentEdits)
    .filter(([id, asset]) => asset?.custom && !sourceAssetIds.has(id) && !deletedEquipmentIds.has(id))
    .map(([id, asset]) => normalizeEquipmentRecord({ ...asset, id, custom: true }))
    .filter((asset) => asset.id && asset.name && asset.qty >= 0));
let activeEquipmentId = null;
let equipmentDialogMode = 'edit';

function normalizeEquipmentRecord(asset) {
  return {
    id: String(asset?.id || '').trim(),
    name: String(asset?.name || '').trim(),
    model: String(asset?.model || '').trim(),
    room: String(asset?.room || '').trim(),
    qty: Math.max(0, Number(asset?.qty ?? asset?.quantity ?? 0)),
    status: String(asset?.status || 'Tốt').trim() || 'Tốt',
    note: String(asset?.note || '').trim(),
    custom: Boolean(asset?.custom),
    borrowedQty: Math.max(0, Number(asset?.borrowedQty || 0))
  };
}

function hasServerInventory() {
  return serverInventoryReady;
}

function syncEquipmentInventory(state) {
  if (!Array.isArray(state?.inventory)) return false;
  serverInventoryReady = true;
  const nextInventory = state.inventory.map(normalizeEquipmentRecord).filter((asset) => asset.id && asset.name && asset.qty >= 0);
  const catalogSignature = (items) => JSON.stringify(items.map((asset) => ({
    id: asset.id,
    name: asset.name,
    model: asset.model,
    room: asset.room,
    qty: asset.qty,
    status: asset.status,
    note: asset.note,
    custom: Boolean(asset.custom)
  })));
  const changed = catalogSignature(nextInventory) !== catalogSignature(equipmentData);
  if (changed) equipmentData = nextInventory;
  return changed;
}

window.KTHSGetEquipmentCatalog = () => equipmentData.map((asset) => ({ ...asset }));

function setMetricValue(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = String(value);
}

function workflowEquipment(loan) {
  const handedOver = loan?.handoff?.equipment;
  return Array.isArray(handedOver) && handedOver.length ? handedOver : (Array.isArray(loan?.equipment) ? loan.equipment : []);
}

function businessDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function refreshOperationalMetrics() {
  const loans = Array.isArray(liveWorkflowState.loans) ? liveWorkflowState.loans : [];
  const today = businessDate();
  const borrowedRawByAsset = new Map();
  const overdueRawByAsset = new Map();
  const activeRooms = new Set();
  let activeLoanCount = 0;

  loans.forEach((loan) => {
    const isActive = loan.status === 'borrowing' || loan.status === 'return_pending';
    if (!isActive) return;
    activeLoanCount += 1;
    const room = String(loan.handoff?.room || loan.room || '').trim();
    if (room) activeRooms.add(room);
    workflowEquipment(loan).forEach((item) => {
      const assetId = String(item.assetId || item.id || '').trim();
      const quantity = Math.max(0, Number(item.quantity || item.qty || 0));
      if (!assetId || !quantity) return;
      borrowedRawByAsset.set(assetId, (borrowedRawByAsset.get(assetId) || 0) + quantity);
      if (loan.status === 'borrowing' && loan.expectedReturnDate && loan.expectedReturnDate < today) {
        overdueRawByAsset.set(assetId, (overdueRawByAsset.get(assetId) || 0) + quantity);
      }
    });
  });

  let total = 0;
  let borrowed = 0;
  let overdue = 0;
  let available = 0;
  let maintenance = 0;
  let broken = 0;
  const borrowedByAsset = {};

  equipmentData.forEach((asset) => {
    const quantity = Math.max(0, Number(asset.qty || 0));
    const borrowedQuantity = Math.min(quantity, Math.max(0, borrowedRawByAsset.get(asset.id) || 0));
    const overdueQuantity = Math.min(borrowedQuantity, Math.max(0, overdueRawByAsset.get(asset.id) || 0));
    const remaining = Math.max(0, quantity - borrowedQuantity);
    const status = String(asset.status || '').trim().toLocaleLowerCase('vi');
    const isMaintenance = status.includes('bảo trì') || status.includes('sửa chữa');
    const isBroken = status.includes('hư hỏng') || status === 'hỏng' || status.includes('thanh lý');

    asset.borrowedQty = borrowedQuantity;
    borrowedByAsset[asset.id] = borrowedQuantity;
    total += quantity;
    borrowed += borrowedQuantity;
    overdue += overdueQuantity;
    if (isMaintenance) maintenance += remaining;
    else if (isBroken) broken += remaining;
    else available += remaining;
  });

  const roomNames = new Set(roomData.map((room) => room.name));
  const roomsInUse = [...activeRooms].filter((room) => roomNames.has(room)).length;
  const roomsMaintenance = roomData.filter((room) => String(room.operationalStatus || '').toLocaleLowerCase('vi').includes('bảo trì')).length;
  const roomsInactive = roomData.filter((room) => {
    const status = String(room.operationalStatus || '').toLocaleLowerCase('vi');
    return status.includes('ngừng') || status.includes('hỏng');
  }).length;
  const capacity = roomData.reduce((sum, room) => sum + Math.max(0, Number(room.capacity || 0)), 0);
  const returnedForms = loans.filter((loan) => loan.status === 'returned').length;
  const processingForms = loans.filter((loan) => !['returned', 'rejected'].includes(loan.status)).length;
  const operational = Math.max(0, total - broken - maintenance);

  const metrics = {
    version: Number(liveWorkflowState.version || 0),
    total, borrowed, overdue, available, maintenance, broken, operational,
    borrowedByAsset,
    totalForms: loans.length,
    returnedForms,
    processingForms,
    activeLoanCount,
    roomTotal: roomData.length,
    roomsInUse,
    roomsMaintenance,
    roomsInactive,
    capacity
  };

  setMetricValue('overviewRoomTotal', metrics.roomTotal);
  setMetricValue('overviewEquipmentTotal', total);
  setMetricValue('overviewBorrowed', borrowed);
  setMetricValue('overviewOverdue', overdue);
  setMetricValue('overviewAvailable', available);
  setMetricValue('roomMetricTotal', metrics.roomTotal);
  setMetricValue('roomMetricInUse', roomsInUse);
  setMetricValue('roomMetricMaintenance', roomsMaintenance);
  setMetricValue('roomMetricInactive', roomsInactive);
  setMetricValue('roomMetricCapacity', capacity);
  setMetricValue('equipmentMetricTotal', total);
  setMetricValue('equipmentMetricBorrowed', borrowed);
  setMetricValue('equipmentMetricAvailable', available);
  setMetricValue('equipmentMetricMaintenance', maintenance);
  setMetricValue('equipmentMetricBroken', broken);
  setMetricValue('reportMetricBorrowForms', metrics.totalForms);
  setMetricValue('reportMetricReturnedForms', returnedForms);
  setMetricValue('reportMetricBroken', broken);
  setMetricValue('reportMetricBorrowed', borrowed);
  setMetricValue('reportMetricTotal', total);
  setMetricValue('reportMetricOperational', operational);
  setMetricValue('reportMetricAvailable', available);
  const borrowContext = document.getElementById('reportMetricBorrowContext');
  if (borrowContext) borrowContext.textContent = `${processingForms} phiếu đang xử lý`;
  const returnContext = document.getElementById('reportMetricReturnContext');
  if (returnContext) returnContext.textContent = `${returnedForms} phiếu đã hoàn tất`;
  const maintenanceContext = document.getElementById('reportMetricMaintenanceContext');
  if (maintenanceContext) maintenanceContext.textContent = `Bảo trì: ${maintenance} thiết bị`;
  const overdueContext = document.getElementById('reportMetricOverdueContext');
  if (overdueContext) overdueContext.textContent = `Quá hạn: ${overdue} thiết bị`;

  window.KTHSMetrics = metrics;
  window.dispatchEvent(new CustomEvent('kths:metricschange', { detail: { metrics } }));
  return metrics;
}

window.addEventListener('kths:workflowstate', (event) => {
  liveWorkflowState = event.detail?.state || liveWorkflowState;
  const roomsChanged = syncRoomData(liveWorkflowState);
  const inventoryChanged = syncEquipmentInventory(liveWorkflowState);
  const borrowedBefore = equipmentData.map((asset) => `${asset.id}:${asset.borrowedQty || 0}`).join('|');
  applyInventoryAccess();
  refreshOperationalMetrics();
  const borrowedAfter = equipmentData.map((asset) => `${asset.id}:${asset.borrowedQty || 0}`).join('|');
  const borrowedChanged = borrowedBefore !== borrowedAfter;
  if (roomsChanged) {
    populateRoomFilters();
    renderRoomRows();
    populateWorkflowSourceOptions();
    void migrateLocalRoomsToServer();
  }
  if (inventoryChanged) {
    populateEquipmentFilters();
    populateWorkflowSourceOptions();
  }
  if (roomsChanged || inventoryChanged || borrowedChanged) renderOverviewSourcePanels();
  if (inventoryChanged || borrowedChanged) filterEquipment();
  renderReportRows();
});

function saveEquipmentData() {
  const payload = {};
  equipmentData.forEach((asset) => {
    payload[asset.id] = {
      name: asset.name,
      model: asset.model,
      room: asset.room,
      status: asset.status,
      qty: asset.qty,
      note: asset.note || '',
      custom: Boolean(asset.custom)
    };
  });
  localStorage.setItem('kthsEquipmentEditsV2', JSON.stringify(payload));
  localStorage.setItem('kthsDeletedEquipmentIdsV2', JSON.stringify([...deletedEquipmentIds]));
}

function populateEquipmentFilters() {
  if (equipmentCategory) {
    const selectedType = equipmentCategory.value;
    const types = [...new Set(equipmentData.map((asset) => asset.name))];
    equipmentCategory.innerHTML = '<option value="">Loại: Tất cả</option>' + types.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join('');
    equipmentCategory.value = types.includes(selectedType) ? selectedType : '';
  }
  if (equipmentRoom) {
    const selectedRoom = equipmentRoom.value;
    const rooms = [...new Set(equipmentData.map((asset) => asset.room).filter(Boolean))];
    equipmentRoom.innerHTML = '<option value="">Phòng: Tất cả</option>' + rooms.map((room) => `<option value="${escapeHtml(room)}">${escapeHtml(room)}</option>`).join('');
    equipmentRoom.value = rooms.includes(selectedRoom) ? selectedRoom : '';
  }
  if (equipmentStatus) {
    const selectedStatus = equipmentStatus.value.startsWith('Tình trạng:') ? '' : equipmentStatus.value;
    const statuses = [...new Set(equipmentData.map((asset) => asset.status).filter(Boolean))];
    equipmentStatus.innerHTML = '<option value="">Tình trạng: Tất cả</option>' + statuses.map((status) => `<option value="${escapeHtml(status)}">${escapeHtml(status)}</option>`).join('');
    equipmentStatus.value = statuses.includes(selectedStatus) ? selectedStatus : '';
  }
}

function equipmentStatusClass(status) {
  if (status === 'Tốt') return 'success';
  if (status === 'Bảo trì' || status === 'Sửa chữa') return 'warning';
  if (status === 'Hư hỏng' || status === 'Thanh lý') return 'danger';
  return 'neutral';
}

function renderEquipmentRows(items) {
  const body = document.getElementById('equipmentTableBody');
  if (!body) return;
  const canManageEquipment = canManageInventory() && inventoryMutationReady();
  const editIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  const deleteIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m4 4v6m6-6v6"/></svg>';
  body.innerHTML = items.map((asset) => {
    const total = Math.max(0, Number(asset.qty || 0));
    const borrowed = Math.min(total, Math.max(0, Number(asset.borrowedQty || 0)));
    const remaining = Math.max(0, total - borrowed);
    const actions = canManageEquipment
      ? `<div class="row-actions"><button class="equipment-edit" type="button" data-equipment-id="${escapeHtml(asset.id)}" title="Chỉnh sửa ${escapeHtml(asset.name)}" aria-label="Chỉnh sửa ${escapeHtml(asset.name)}">${editIcon}</button><button class="equipment-delete" type="button" data-equipment-id="${escapeHtml(asset.id)}" title="Xóa ${escapeHtml(asset.name)}" aria-label="Xóa ${escapeHtml(asset.name)}">${deleteIcon}</button></div>`
      : '<span class="inventory-readonly-action" aria-label="Chỉ xem">—</span>';
    return `<tr data-equipment-id="${escapeHtml(asset.id)}" data-category="${escapeHtml(asset.name)}" data-room="${escapeHtml(asset.room)}" data-status="${escapeHtml(asset.status)}">
      <td><div class="equipment-name"><span>${escapeHtml(asset.name)}</span></div></td>
      <td class="equipment-model">${escapeHtml(asset.model)}</td>
      <td>${escapeHtml(asset.room)}</td>
      <td class="equipment-number">${total}</td>
      <td class="equipment-number">${borrowed}</td>
      <td class="equipment-number equipment-remaining">${remaining}</td>
      <td><span class="status ${equipmentStatusClass(asset.status)}">${escapeHtml(asset.status)}</span></td>
      <td>${actions}</td>
    </tr>`;
  }).join('');
}

function filterEquipment() {
  const query = (equipmentSearch?.value || '').toLowerCase().trim();
  const category = equipmentCategory?.value || '';
  const room = equipmentRoom?.value || '';
  const status = equipmentStatus?.value?.startsWith('Tình trạng:') ? '' : (equipmentStatus?.value || '');
  const filtered = equipmentData.map((asset, _index) => ({ ...asset, _index })).filter((asset) =>
    (!query || `${asset.name} ${asset.model} ${asset.id} ${asset.room} ${asset.note}`.toLowerCase().includes(query))
      && (!category || asset.name === category)
      && (!room || asset.room === room)
      && (!status || asset.status === status));
  renderEquipmentRows(filtered);
  if (equipmentResultCount) {
    equipmentResultCount.textContent = `Hiển thị ${filtered.length} trong tổng số ${equipmentData.length} phương tiện`;
  }
}

populateEquipmentFilters();
refreshOperationalMetrics();
populateWorkflowSourceOptions();
renderOverviewSourcePanels();
filterEquipment();
equipmentSearch?.addEventListener('input', filterEquipment);
equipmentCategory?.addEventListener('change', filterEquipment);
equipmentRoom?.addEventListener('change', filterEquipment);
equipmentStatus?.addEventListener('change', filterEquipment);

window.addEventListener('kths:authchange', () => {
  // Authentication changes the action column as well as the toolbar buttons.
  // Re-render after the full inventory/room setup has initialized.
  if (document.getElementById('roomsTableBody')) renderRoomRows();
  if (document.getElementById('equipmentTableBody')) filterEquipment();
  void migrateLocalRoomsToServer();
});

document.getElementById('refreshEquipment')?.addEventListener('click', () => {
  if (equipmentSearch) equipmentSearch.value = '';
  if (equipmentCategory) equipmentCategory.selectedIndex = 0;
  if (equipmentRoom) equipmentRoom.selectedIndex = 0;
  if (equipmentStatus) equipmentStatus.selectedIndex = 0;
  filterEquipment();
  showToast('Đã làm mới danh sách phương tiện');
});

document.getElementById('addEquipment')?.addEventListener('click', () => {
  if (!canManageInventory()) {
    showToast('Bạn không có quyền thêm phương tiện');
    return;
  }
  if (!inventoryMutationReady()) {
    showToast('Đang đồng bộ danh mục phương tiện, vui lòng thử lại sau');
    return;
  }
  openCreateEquipmentDialog();
});

function closeEquipmentDialog() {
  equipmentDialog?.close();
  equipmentEditForm?.reset();
  equipmentEditQuantity?.setCustomValidity('');
  activeEquipmentId = null;
  equipmentDialogMode = 'edit';
}

function setEquipmentDialogMode(mode) {
  equipmentDialogMode = mode;
  const isCreate = mode === 'create';
  if (equipmentDialogTitle) equipmentDialogTitle.textContent = isCreate ? 'Thêm phương tiện' : 'Cập nhật phương tiện';
  equipmentDialogGrid?.classList.toggle('create-mode', isCreate);
  if (equipmentIdField) equipmentIdField.hidden = isCreate;
  if (equipmentNoteField) equipmentNoteField.hidden = isCreate;
  if (equipmentSubmitButton) equipmentSubmitButton.textContent = isCreate ? 'Thêm phương tiện' : 'Lưu thay đổi';
  if (equipmentEditName) equipmentEditName.readOnly = false;
}

function populateEquipmentDialogRooms(selectedRoom = '') {
  if (!equipmentEditRoom) return;
  const rooms = [...new Set(roomData.map((room) => room.name).filter(Boolean))];
  if (selectedRoom && !rooms.includes(selectedRoom)) rooms.push(selectedRoom);
  equipmentEditRoom.innerHTML = '<option value="">Chọn phòng</option>'
    + rooms.map((room) => `<option value="${escapeHtml(room)}">${escapeHtml(room)}</option>`).join('');
  equipmentEditRoom.value = rooms.includes(selectedRoom) ? selectedRoom : '';
}

function generateLocalEquipmentId() {
  const prefix = `PT-${businessDate().replaceAll('-', '')}`;
  const reserved = new Set([
    ...sourceAssetIds,
    ...deletedEquipmentIds,
    ...equipmentData.map((asset) => asset.id),
    ...liveWorkflowState.loans.flatMap((loan) => workflowEquipment(loan).map((item) => String(item.assetId || item.id || '').trim()))
  ]);
  let sequence = 1;
  while (reserved.has(`${prefix}-${String(sequence).padStart(3, '0')}`)) sequence += 1;
  return `${prefix}-${String(sequence).padStart(3, '0')}`;
}

function openCreateEquipmentDialog() {
  if (!canManageInventory() || !equipmentDialog) return;
  activeEquipmentId = null;
  setEquipmentDialogMode('create');
  equipmentEditForm?.reset();
  equipmentEditId.value = '';
  equipmentEditQuantity.value = '1';
  equipmentEditStatus.value = 'Tốt';
  equipmentEditNote.value = '';
  populateEquipmentDialogRooms();
  equipmentDialog.showModal();
  equipmentEditName.focus();
}

function openEquipmentDialog(assetId) {
  if (!canManageInventory()) {
    showToast('Bạn chỉ có quyền xem danh sách phương tiện');
    return;
  }
  const asset = equipmentData.find((item) => item.id === assetId);
  if (!asset || !equipmentDialog) return;
  activeEquipmentId = assetId;
  setEquipmentDialogMode('edit');
  equipmentEditName.value = asset.name;
  equipmentEditId.value = asset.id;
  equipmentEditQuantity.value = asset.qty;
  equipmentEditModel.value = asset.model || '';
  populateEquipmentDialogRooms(asset.room);
  equipmentEditStatus.value = asset.status;
  equipmentEditNote.value = asset.note || '';
  equipmentDialog.showModal();
  equipmentEditStatus.focus();
}

document.getElementById('equipmentTableBody')?.addEventListener('click', async (event) => {
  if (!canManageInventory()) {
    if (event.target.closest('button')) showToast('Bạn chỉ có quyền xem danh sách phương tiện');
    return;
  }
  const editButton = event.target.closest('.equipment-edit');
  if (editButton) {
    openEquipmentDialog(editButton.dataset.equipmentId);
    return;
  }
  const deleteButton = event.target.closest('.equipment-delete');
  if (!deleteButton) return;
  if (!inventoryMutationReady()) {
    showToast('Đang đồng bộ danh mục phương tiện, vui lòng thử lại sau');
    return;
  }
  const asset = equipmentData.find((item) => item.id === deleteButton.dataset.equipmentId);
  if (Number(asset?.borrowedQty || 0) > 0) {
    showToast(`Không thể xóa ${asset.id} khi còn ${asset.borrowedQty} thiết bị đang mượn`);
    return;
  }
  if (!asset || !window.confirm(`Xóa ${asset.id} - ${asset.name} khỏi danh sách phương tiện?`)) return;
  if (hasServerInventory()) {
    try {
      await window.KTHSWorkflow.command('delete_equipment', {
        payload: { assetId: asset.id },
        success: `Đã xóa ${asset.name}`
      });
    } catch {
      // workflow.js đã hiển thị lỗi từ máy chủ.
    }
    return;
  }
  deletedEquipmentIds.add(asset.id);
  equipmentData = equipmentData.filter((item) => item.id !== asset.id);
  saveEquipmentData();
  populateEquipmentFilters();
  refreshOperationalMetrics();
  filterEquipment();
  renderReportRows();
  populateWorkflowSourceOptions();
  renderOverviewSourcePanels();
  showToast('Đã xóa phương tiện khỏi danh sách');
});

equipmentEditForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!canManageInventory()) {
    closeEquipmentDialog();
    showToast('Bạn không có quyền cập nhật phương tiện');
    return;
  }
  if (!inventoryMutationReady()) {
    showToast('Đang đồng bộ danh mục phương tiện, vui lòng thử lại sau');
    return;
  }
  const isCreate = equipmentDialogMode === 'create';
  const asset = isCreate ? null : equipmentData.find((item) => item.id === activeEquipmentId);
  if (!isCreate && !asset) return;
  const name = equipmentEditName.value.trim();
  const model = equipmentEditModel.value.trim();
  const room = equipmentEditRoom.value;
  const status = equipmentEditStatus.value;
  const nextQuantity = Number(equipmentEditQuantity.value);
  equipmentEditName.setCustomValidity(name ? '' : 'Vui lòng nhập tên phương tiện.');
  equipmentEditModel.setCustomValidity(model ? '' : 'Vui lòng nhập model, hãng sản xuất hoặc xuất xứ.');
  if (!name || !model || !room || !status || !Number.isInteger(nextQuantity) || nextQuantity < 1) {
    equipmentEditForm.reportValidity();
    if (!Number.isInteger(nextQuantity) || nextQuantity < 1) {
      equipmentEditQuantity.setCustomValidity('Tổng số lượng phải là số nguyên lớn hơn 0.');
      equipmentEditQuantity.reportValidity();
    }
    return;
  }
  const borrowedQuantity = Math.max(0, Number(asset?.borrowedQty || 0));
  if (!isCreate && nextQuantity < borrowedQuantity) {
    equipmentEditQuantity.setCustomValidity(`Số lượng không được nhỏ hơn ${borrowedQuantity} thiết bị đang mượn.`);
    equipmentEditQuantity.reportValidity();
    return;
  }
  equipmentEditQuantity.setCustomValidity('');
  const payload = {
    name,
    model,
    room,
    qty: nextQuantity,
    status,
    note: isCreate ? '' : equipmentEditNote.value.trim()
  };

  if (hasServerInventory()) {
    if (equipmentSubmitButton) equipmentSubmitButton.disabled = true;
    try {
      await window.KTHSWorkflow.command(isCreate ? 'create_equipment' : 'update_equipment', {
        payload: isCreate ? payload : { ...payload, assetId: asset.id },
        success: isCreate ? `Đã thêm ${name}` : `Đã cập nhật ${asset.id}`
      });
      closeEquipmentDialog();
    } catch {
      // workflow.js đã hiển thị lỗi từ máy chủ.
    } finally {
      if (equipmentSubmitButton) equipmentSubmitButton.disabled = false;
    }
    return;
  }

  if (isCreate) {
    equipmentData.unshift(normalizeEquipmentRecord({
      ...payload,
      id: generateLocalEquipmentId(),
      custom: true
    }));
  } else {
    asset.name = name;
    asset.model = model;
    asset.room = room;
    asset.status = status;
    asset.qty = nextQuantity;
    asset.note = payload.note;
  }
  saveEquipmentData();
  populateEquipmentFilters();
  refreshOperationalMetrics();
  filterEquipment();
  renderReportRows();
  populateWorkflowSourceOptions();
  renderOverviewSourcePanels();
  closeEquipmentDialog();
  showToast(isCreate ? `Đã thêm ${name}` : `Đã cập nhật ${asset.id}`);
});

document.getElementById('closeEquipmentDialog')?.addEventListener('click', closeEquipmentDialog);
document.getElementById('cancelEquipmentEdit')?.addEventListener('click', closeEquipmentDialog);
equipmentEditQuantity?.addEventListener('input', () => equipmentEditQuantity.setCustomValidity(''));
equipmentEditName?.addEventListener('input', () => equipmentEditName.setCustomValidity(''));
equipmentEditModel?.addEventListener('input', () => equipmentEditModel.setCustomValidity(''));
equipmentDialog?.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeEquipmentDialog();
});
equipmentDialog?.addEventListener('close', () => {
  equipmentEditForm?.reset();
  equipmentEditName?.setCustomValidity('');
  equipmentEditModel?.setCustomValidity('');
  equipmentEditQuantity?.setCustomValidity('');
  activeEquipmentId = null;
  equipmentDialogMode = 'edit';
});
equipmentDialog?.addEventListener('click', (event) => {
  if (event.target === equipmentDialog) closeEquipmentDialog();
});

const borrowRows = [...document.querySelectorAll('#borrowTableBody tr')];
const borrowCreate = document.getElementById('createBorrow');
let activeBorrowTab = 'borrow';
let activeBorrowStatus = 'all';

function filterBorrowRows() {
  let visible = 0;
  borrowRows.forEach((row) => {
    const belongsToTab = activeBorrowTab === 'borrow'
      ? row.dataset.tab === 'borrow' || row.dataset.tab === 'return'
      : row.dataset.tab === 'return';
    const belongsToStatus = activeBorrowStatus === 'all'
      || row.dataset.statusKey === activeBorrowStatus
      || (activeBorrowStatus === 'approval' && ['pending', 'approved'].includes(row.dataset.statusKey))
      || (activeBorrowStatus === 'borrowing' && row.dataset.statusKey === 'return_pending');
    const matches = belongsToTab && belongsToStatus;
    row.hidden = !matches;
    if (matches) visible += 1;
  });
}

document.querySelectorAll('.borrow-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    activeBorrowTab = tab.dataset.tab;
    document.querySelectorAll('.borrow-tab').forEach((item) => {
      const isActive = item === tab;
      item.classList.toggle('active', isActive);
      item.setAttribute('aria-selected', String(isActive));
    });
    activeBorrowStatus = 'all';
    document.querySelectorAll('.borrow-status-filter').forEach((item) => item.classList.toggle('active', item.dataset.statusFilter === 'all'));
    if (borrowCreate) borrowCreate.innerHTML = `<span aria-hidden="true">＋</span> ${activeBorrowTab === 'return' ? 'Tạo phiếu trả' : 'Tạo phiếu mượn'}`;
    filterBorrowRows();
  });
});

document.querySelectorAll('.borrow-status-filter').forEach((filter) => {
  filter.addEventListener('click', () => {
    activeBorrowStatus = filter.dataset.statusFilter;
    document.querySelectorAll('.borrow-status-filter').forEach((item) => item.classList.toggle('active', item === filter));
    filterBorrowRows();
  });
});

borrowCreate?.addEventListener('click', () => {
  if (!window.KTHSRequireAuthentication?.()) return;
  resetBorrowEquipmentSelection();
  switchView(createBorrowView, activeBorrowTab === 'return' ? 'Tạo phiếu trả' : 'Tạo phiếu mượn');
  clearTimeout(toastTimer);
  toast.classList.remove('show');
});
filterBorrowRows();

const borrowForm = document.getElementById('borrowForm');
const borrowRoom = document.getElementById('borrowRoom');
const cancelBorrow = document.getElementById('cancelBorrow');

const borrowEquipmentPicker = document.getElementById('borrowEquipmentPicker');
const borrowEquipmentToggle = document.getElementById('borrowEquipmentToggle');
const borrowEquipmentMenu = document.getElementById('borrowEquipmentMenu');
const borrowEquipmentOptions = document.getElementById('borrowEquipmentOptions');
const borrowEquipmentSearch = document.getElementById('borrowEquipmentSearch');
const closeBorrowEquipmentPicker = document.getElementById('closeBorrowEquipmentPicker');

borrowEquipmentToggle?.addEventListener('click', (event) => {
  event.stopPropagation();
  setBorrowEquipmentPickerOpen(borrowEquipmentToggle.getAttribute('aria-expanded') !== 'true');
});

borrowEquipmentMenu?.addEventListener('click', (event) => event.stopPropagation());
closeBorrowEquipmentPicker?.addEventListener('click', () => {
  const validation = borrowEquipmentValidation();
  if (validation.issues.length) {
    validateBorrowEquipmentSelection({ focus: true });
    return;
  }
  setBorrowEquipmentPickerOpen(false);
  borrowEquipmentToggle?.focus();
});
borrowEquipmentSearch?.addEventListener('input', () => {
  borrowEquipmentPickerQuery = borrowEquipmentSearch.value;
  renderBorrowEquipmentOptions();
});

borrowEquipmentOptions?.addEventListener('change', (event) => {
  const checkbox = event.target.closest('.borrow-equipment-checkbox');
  if (checkbox) {
    const asset = currentEquipmentCatalog().find((item) => item.id === checkbox.value);
    if (checkbox.checked) borrowEquipmentSelection.set(checkbox.value, { quantity: '1', name: asset?.name || '' });
    else borrowEquipmentSelection.delete(checkbox.value);
    renderBorrowEquipmentOptions();
    const nextCheckbox = borrowEquipmentOptions.querySelector(`.borrow-equipment-checkbox[value="${CSS.escape(checkbox.value)}"]`);
    nextCheckbox?.focus();
    return;
  }
  const quantityInput = event.target.closest('[data-quantity-for]');
  if (!quantityInput) return;
  const selection = borrowEquipmentSelection.get(quantityInput.dataset.quantityFor);
  if (!selection) return;
  selection.quantity = quantityInput.value.trim();
  renderBorrowEquipmentOptions();
  document.querySelector(`[data-quantity-for="${CSS.escape(quantityInput.dataset.quantityFor)}"]`)?.focus();
});

borrowEquipmentOptions?.addEventListener('input', (event) => {
  const quantityInput = event.target.closest('[data-quantity-for]');
  if (!quantityInput) return;
  const selection = borrowEquipmentSelection.get(quantityInput.dataset.quantityFor);
  if (!selection) return;
  selection.quantity = quantityInput.value;
  const asset = borrowEquipmentCatalog().find((item) => item.id === quantityInput.dataset.quantityFor);
  const issue = borrowEquipmentIssue(asset, selection);
  quantityInput.setAttribute('aria-invalid', String(Boolean(issue)));
  quantityInput.closest('.borrow-equipment-option')?.classList.toggle('is-invalid', Boolean(issue));
  updateBorrowEquipmentSummary();
});

document.addEventListener('click', (event) => {
  if (!borrowEquipmentPicker?.contains(event.target)) setBorrowEquipmentPickerOpen(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || borrowEquipmentToggle?.getAttribute('aria-expanded') !== 'true') return;
  setBorrowEquipmentPickerOpen(false);
  borrowEquipmentToggle.focus();
});

cancelBorrow?.addEventListener('click', () => {
  resetBorrowEquipmentSelection();
  switchView(borrowView, 'Quản lý Mượn - Trả');
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === 'borrowView'));
});

borrowForm?.addEventListener('reset', () => setTimeout(resetBorrowEquipmentSelection, 0));

const borrowDate = document.getElementById('borrowDate');
const expectedReturnDate = document.getElementById('expectedReturnDate');

function validateBorrowDateRange({ report = false } = {}) {
  if (!borrowDate?.value || !expectedReturnDate?.value || expectedReturnDate.value >= borrowDate.value) {
    expectedReturnDate?.setCustomValidity('');
    return true;
  }
  expectedReturnDate.setCustomValidity('Ngày trả dự kiến không được sớm hơn ngày mượn.');
  if (report) expectedReturnDate.reportValidity();
  return false;
}

borrowDate?.addEventListener('change', () => validateBorrowDateRange());
expectedReturnDate?.addEventListener('change', () => validateBorrowDateRange());

borrowForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!validateBorrowDateRange({ report: true })) return;
  showToast(`Đã gửi phiếu mượn ${borrowRoom?.value || ''}, đang chờ duyệt`);
});

const reviewBorrow42 = document.getElementById('reviewBorrow42');
const handoffBorrow41 = document.getElementById('handoffBorrow41');
const returnBorrow40 = document.getElementById('returnBorrow40');
const returnBorrow39 = document.getElementById('returnBorrow39');
const approvalForm = document.getElementById('approvalForm');
const approvalLeaderField = document.getElementById('approvalLeaderField');
const approvalLeader = document.getElementById('approvalLeader');
const cancelApproval = document.getElementById('cancelApproval');
let activeTransactionRow = null;

reviewBorrow42?.addEventListener('click', () => {
  activeTransactionRow = reviewBorrow42.closest('tr');
  switchView(approvalView, 'Duyệt cho mượn (Quản lý phòng)');
  clearTimeout(toastTimer);
  toast.classList.remove('show');
});

function updateApprovalFields() {
  const decision = document.querySelector('input[name="approvalDecision"]:checked')?.value;
  const needsLeader = decision === 'leader';
  if (approvalLeaderField) approvalLeaderField.hidden = !needsLeader;
  if (approvalLeader) approvalLeader.required = needsLeader;
}

document.querySelectorAll('input[name="approvalDecision"]').forEach((radio) => radio.addEventListener('change', updateApprovalFields));
updateApprovalFields();

cancelApproval?.addEventListener('click', () => {
  switchView(borrowView, 'Quản lý Mượn - Trả');
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === 'borrowView'));
});

approvalForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  const decision = document.querySelector('input[name="approvalDecision"]:checked')?.value;
  if (decision === 'approve') {
    updateTransactionRow(activeTransactionRow, 'approved');
    filterBorrowRows();
    switchView(borrowView, 'Quản lý Mượn - Trả');
    document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === 'borrowView'));
    showToast('Đã duyệt cho mượn. Phiếu sẵn sàng để xác nhận giao');
    return;
  }
  const messages = {
    approve: 'Đã duyệt phiếu PM-2025-0042',
    reject: 'Đã gửi ý kiến không đồng ý',
    leader: 'Đã gửi xin ý kiến lãnh đạo'
  };
  showToast(messages[decision] || 'Đã gửi ý kiến duyệt');
});

const addHandoffEquipment = document.getElementById('addHandoffEquipment');
const handoffEquipmentBody = document.getElementById('handoffEquipmentBody');
const confirmHandoff = document.getElementById('confirmHandoff');

function selectValue(select, value) {
  if (!select || !value) return;
  const option = [...select.options].find((item) => item.value === value || item.textContent === value);
  if (option) select.value = option.value;
}

function resetHandoffProgress() {
  const steps = [...document.querySelectorAll('#handoffView .handoff-step')];
  steps.forEach((step, index) => step.classList.toggle('active', index === 0));
  document.querySelector('#handoffView .handoff-step-line')?.style.removeProperty('background');
  document.getElementById('handoffConfirmStep')?.querySelector('span')?.style.removeProperty('background');
  document.getElementById('handoffMiniConfirm')?.classList.remove('active');
  if (confirmHandoff) {
    confirmHandoff.textContent = 'Xác nhận giao';
    confirmHandoff.disabled = false;
  }
}

function resetReturnProgress() {
  const steps = [...document.querySelectorAll('#returnView .return-step')];
  steps.forEach((step, index) => step.classList.toggle('active', index === 0));
  document.getElementById('returnConfirmStep')?.querySelector('span')?.style.removeProperty('background');
  document.querySelector('#returnView .return-bottom-panel')?.classList.remove('manager-confirm-mode');
  const managerNotes = document.getElementById('returnManagerNotes');
  if (managerNotes) managerNotes.hidden = true;
  const teacherNoteField = document.getElementById('returnTeacherNoteField');
  if (teacherNoteField) teacherNoteField.hidden = false;
  if (confirmReturn) {
    confirmReturn.textContent = 'Xác nhận trả';
    confirmReturn.disabled = false;
  }
}

function openHandoff(row) {
  if (!row) return;
  activeTransactionRow = row;
  const cells = row.cells;
  const code = document.getElementById('handoffCode');
  if (code) {
    code.textContent = cells[0].textContent.trim();
    code.dataset.loanId = row.dataset.loanId || code.textContent;
  }
  selectValue(document.getElementById('handoffRecipient'), cells[1].textContent.trim());
  selectValue(document.getElementById('handoffRoom'), row.dataset.room);
  resetHandoffProgress();
  switchView(handoffView, 'Xác nhận giao phòng và phương tiện');
  clearTimeout(toastTimer);
  toast.classList.remove('show');
}

function openReturn(row) {
  if (!row) return;
  activeTransactionRow = row;
  const cells = row.cells;
  const code = document.getElementById('returnCode');
  if (code) {
    code.textContent = cells[0].textContent.trim();
    code.dataset.loanId = row.dataset.loanId || code.textContent;
  }
  selectValue(document.getElementById('returnBorrower'), cells[1].textContent.trim());
  selectValue(document.getElementById('returnRoom'), row.dataset.room);
  resetReturnProgress();
  switchView(returnView, 'Xác nhận trả phòng và phương tiện');
  clearTimeout(toastTimer);
  toast.classList.remove('show');
}

function startReturn(row) {
  if (!row) return;
  openReturn(row);
}

function bindToastButton(button) {
  button?.addEventListener('click', () => showToast(button.dataset.toast));
}

function updateTransactionRow(row, statusKey) {
  if (!row) return;
  const statusCell = row.cells[5];
  const actionCell = row.cells[6];
  row.dataset.statusKey = statusKey;

  if (statusKey === 'approved') {
    row.dataset.tab = 'borrow';
    statusCell.innerHTML = '<span class="status success">Đã duyệt</span>';
    actionCell.innerHTML = '<div class="row-actions"><button class="flow-action-button handoff" type="button"><span aria-hidden="true">→</span>Xác nhận giao</button><button class="more-action" type="button" data-toast="Thêm thao tác cho phiếu đã duyệt" title="Thêm thao tác">⋮</button></div>';
    actionCell.querySelector('.flow-action-button')?.addEventListener('click', () => openHandoff(row));
    bindToastButton(actionCell.querySelector('[data-toast]'));
  }

  if (statusKey === 'borrowing') {
    row.dataset.tab = 'borrow';
    statusCell.innerHTML = '<span class="status info">Đang mượn</span>';
    actionCell.innerHTML = '<div class="row-actions"><button class="flow-action-button return-request" type="button" title="Trả phương tiện"><span aria-hidden="true">↩</span>Trả phương tiện</button><button class="more-action" type="button" data-toast="Thêm thao tác cho phiếu đang mượn" title="Thêm thao tác">⋮</button></div>';
    actionCell.querySelector('.flow-action-button')?.addEventListener('click', () => startReturn(row));
    bindToastButton(actionCell.querySelector('[data-toast]'));
  }

  if (statusKey === 'return_pending') {
    row.dataset.tab = 'borrow';
    statusCell.innerHTML = '<span class="status return-pending">Chờ xác nhận trả</span>';
    actionCell.innerHTML = '<div class="row-actions"><button class="flow-action-button return-confirm" type="button" title="Xác nhận đã trả"><span aria-hidden="true">✓</span>Xác nhận đã trả</button><button class="more-action" type="button" data-toast="Thêm thao tác cho phiếu chờ xác nhận trả" title="Thêm thao tác">⋮</button></div>';
    actionCell.querySelector('.flow-action-button')?.addEventListener('click', () => {
      updateTransactionRow(row, 'returned');
      filterBorrowRows();
      showToast('Đã xác nhận phiếu đã trả phòng và phương tiện');
    });
    bindToastButton(actionCell.querySelector('[data-toast]'));
  }

  if (statusKey === 'returned') {
    row.dataset.tab = 'return';
    statusCell.innerHTML = '<span class="status neutral">Đã trả</span>';
    actionCell.innerHTML = '<div class="row-actions"><button class="flow-action-button view" type="button" data-toast="Đang mở chi tiết phiếu"><span aria-hidden="true">◉</span>Xem chi tiết</button><button class="more-action" type="button" data-toast="Thêm thao tác cho phiếu đã trả" title="Thêm thao tác">⋮</button></div>';
    actionCell.querySelectorAll('[data-toast]').forEach(bindToastButton);
  }
}

handoffBorrow41?.addEventListener('click', () => openHandoff(handoffBorrow41.closest('tr')));
returnBorrow40?.addEventListener('click', () => startReturn(returnBorrow40.closest('tr')));
returnBorrow39?.addEventListener('click', () => startReturn(returnBorrow39.closest('tr')));

function additionalFlowAssets(tableBody) {
  const usedIds = new Set([...tableBody.querySelectorAll('tr[data-asset-id]')]
    .map((row) => row.dataset.assetId)
    .filter(Boolean));
  return currentEquipmentCatalog().filter((asset) => {
    const remaining = Math.max(0, Number(asset.qty || 0) - Number(asset.borrowedQty || 0));
    return asset.status === 'Tốt' && remaining > 0 && !usedIds.has(asset.id);
  });
}

function bindAdditionalFlowPicker(row, assets, contextLabel) {
  const picker = row.querySelector('.flow-equipment-picker');
  if (!picker) return;
  picker.addEventListener('change', () => {
    const asset = assets.find((item) => item.id === picker.value);
    if (!asset) return;
    row.dataset.assetId = asset.id;
    row.querySelector('select:not(.flow-equipment-picker)')?.setAttribute('aria-label', `Tình trạng ${asset.name}${contextLabel}`);
    const photo = row.querySelector('.photo-button');
    photo?.setAttribute('aria-label', `Tải ảnh ${asset.name}${contextLabel}`);
    photo?.setAttribute('title', `Tải ảnh ${asset.name}${contextLabel}`);
    if (photo) {
      photo.classList.remove('has-photo', 'is-uploading');
      photo.innerHTML = '<span class="flow-photo-upload-icon" aria-hidden="true">↑</span>';
    }
    ['photoUrl', 'photoFilename', 'photoContentType', 'photoSize', 'photoOriginalName', 'photoUploading']
      .forEach((key) => delete row.dataset[key]);
  });
}

addHandoffEquipment?.addEventListener('click', () => {
  if (!handoffEquipmentBody) return;
  const assets = additionalFlowAssets(handoffEquipmentBody);
  if (!assets.length) {
    showToast('Không còn phương tiện phù hợp để bổ sung');
    return;
  }
  const asset = assets[0];
  const options = assets.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(assetChoiceLabel(item))}</option>`).join('');
  handoffEquipmentBody.insertAdjacentHTML('beforeend', `<tr data-asset-id="${escapeHtml(asset.id)}" data-quantity="1"><td><select class="form-control flow-equipment-picker" aria-label="Chọn phương tiện bổ sung">${options}</select></td><td>1</td><td><select class="condition-select" aria-label="Tình trạng ${escapeHtml(asset.name)}"><option>Tốt</option><option>Khá</option><option>Cần kiểm tra</option></select></td><td><div class="flow-photo-control"><button class="photo-button" type="button" data-workflow-action="photo" title="Tải ảnh ${escapeHtml(asset.name)}" aria-label="Tải ảnh ${escapeHtml(asset.name)}"><span class="flow-photo-upload-icon" aria-hidden="true">↑</span></button><input class="flow-photo-input" type="file" accept="image/jpeg,image/png,image/webp" tabindex="-1" aria-hidden="true" hidden></div></td></tr>`);
  const row = handoffEquipmentBody.lastElementChild;
  bindAdditionalFlowPicker(row, assets, '');
  showToast('Đã thêm dòng chọn phương tiện giao');
});

confirmHandoff?.addEventListener('click', () => {
  const recipient = document.getElementById('handoffRecipient');
  const room = document.getElementById('handoffRoom');
  const date = document.getElementById('handoffDate');
  if (!recipient?.value || !room?.value || !date?.value) {
    showToast('Vui lòng nhập đủ người nhận, phòng và ngày giao');
    return;
  }
  document.querySelector('.handoff-step.active')?.classList.remove('active');
  document.querySelector('.handoff-step-line')?.style.setProperty('background', '#1267f4');
  document.getElementById('handoffConfirmStep')?.classList.add('active');
  document.getElementById('handoffConfirmStep')?.querySelector('span')?.style.setProperty('background', '#1267f4');
  document.getElementById('handoffMiniConfirm')?.classList.add('active');
  confirmHandoff.textContent = 'Đã xác nhận giao';
  confirmHandoff.disabled = true;
  updateTransactionRow(activeTransactionRow, 'borrowing');
  showToast(`Đã xác nhận giao ${room.value} và phương tiện cho ${recipient.value}`);
});

const addReturnEquipment = document.getElementById('addReturnEquipment');
const returnEquipmentBody = document.getElementById('returnEquipmentBody');
const cancelReturn = document.getElementById('cancelReturn');
const confirmReturn = document.getElementById('confirmReturn');

document.querySelectorAll('.return-condition').forEach((select) => {
  select.addEventListener('change', () => {
    select.classList.toggle('condition-good', select.value === 'Tốt');
    select.classList.toggle('condition-check', select.value === 'Xước nhẹ');
    select.classList.toggle('condition-damaged', select.value === 'Hỏng');
  });
});

addReturnEquipment?.addEventListener('click', () => {
  if (!returnEquipmentBody) return;
  if (returnEquipmentBody.dataset.readOnly === 'true') {
    showToast('Danh sách phương tiện trả chỉ được xem ở bước xác nhận');
    return;
  }
  const assets = additionalFlowAssets(returnEquipmentBody);
  if (!assets.length) {
    showToast('Không còn phương tiện phù hợp để bổ sung');
    return;
  }
  const asset = assets[0];
  const options = assets.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(assetChoiceLabel(item))}</option>`).join('');
  returnEquipmentBody.insertAdjacentHTML('beforeend', `<tr data-asset-id="${escapeHtml(asset.id)}" data-quantity="1" data-condition="Tốt"><td><select class="form-control flow-equipment-picker" aria-label="Chọn phương tiện bổ sung">${options}</select></td><td>1</td><td><div class="flow-photo-control"><button class="photo-button" type="button" data-workflow-action="photo" title="Tải ảnh ${escapeHtml(asset.name)} khi trả" aria-label="Tải ảnh ${escapeHtml(asset.name)} khi trả"><span class="flow-photo-upload-icon" aria-hidden="true">↑</span></button><input class="flow-photo-input" type="file" accept="image/jpeg,image/png,image/webp" tabindex="-1" aria-hidden="true" hidden></div></td></tr>`);
  const row = returnEquipmentBody.lastElementChild;
  bindAdditionalFlowPicker(row, assets, ' khi trả');
  showToast('Đã thêm dòng chọn phương tiện trả');
});

cancelReturn?.addEventListener('click', () => {
  switchView(borrowView, 'Quản lý Mượn - Trả');
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === 'borrowView'));
});

confirmReturn?.addEventListener('click', () => {
  const borrower = document.getElementById('returnBorrower');
  const room = document.getElementById('returnRoom');
  const date = document.getElementById('returnDate');
  if (!borrower?.value || !room?.value || !date?.value) {
    showToast('Vui lòng nhập đủ người trả, phòng và ngày trả');
    return;
  }
  document.querySelector('.return-step.active')?.classList.remove('active');
  document.getElementById('returnConfirmStep')?.classList.add('active');
  document.getElementById('returnConfirmStep')?.querySelector('span')?.style.setProperty('background', '#1267f4');
  confirmReturn.textContent = 'Đã xác nhận trả';
  confirmReturn.disabled = true;
  updateTransactionRow(activeTransactionRow, 'return_pending');
  activeBorrowStatus = 'all';
  document.querySelectorAll('.borrow-status-filter').forEach((item) => item.classList.toggle('active', item.dataset.statusFilter === 'all'));
  filterBorrowRows();
  switchView(borrowView, 'Quản lý Mượn - Trả');
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === 'borrowView'));
  showToast(`Đã ghi nhận trả ${room.value} và phương tiện. Phiếu đang chờ xác nhận đã trả`);
});

const reportSearch = document.getElementById('reportSearch');
const reportRoom = document.getElementById('reportRoom');
const reportEquipment = document.getElementById('reportEquipment');
const reportStatus = document.getElementById('reportStatus');
const reportStartDate = document.getElementById('reportStartDate');
const reportEndDate = document.getElementById('reportEndDate');
let reportRows = [...document.querySelectorAll('#reportTableBody tr[data-report-status]')];
const reportResultCount = document.getElementById('reportResultCount');

function reportDate(value) {
  const normalized = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return '';
  const [year, month, day] = normalized.split('-');
  return `${day}/${month}/${year}`;
}

function equipmentCondition(items) {
  const values = [...new Set((Array.isArray(items) ? items : []).map((item) => String(item.condition || '').trim()).filter(Boolean))];
  return values.length ? values.join(', ') : 'Chưa ghi nhận';
}

function reportConditionClass(value) {
  const normalized = String(value || '').toLocaleLowerCase('vi');
  if (normalized.includes('hỏng') || normalized.includes('mất') || normalized.includes('ngừng')) return 'danger';
  if (normalized.includes('xước') || normalized.includes('bảo trì') || normalized.includes('sửa')) return 'warning';
  return normalized === 'tốt' ? 'success' : 'neutral';
}

function returnedEquipment(loan) {
  const managerConfirmed = loan?.returnConfirmation?.equipment;
  if (Array.isArray(managerConfirmed) && managerConfirmed.length) return managerConfirmed;
  const borrowerReturned = loan?.returnRequest?.equipment;
  return Array.isArray(borrowerReturned) && borrowerReturned.length ? borrowerReturned : workflowEquipment(loan);
}

function reportDateTime(dateValue, timeValue) {
  const date = reportDate(dateValue);
  const time = String(timeValue || '').trim().slice(0, 5);
  return [date, time].filter(Boolean).join(' ');
}

function renderReportRows() {
  const body = document.getElementById('reportTableBody');
  if (!body) return;
  const assetNames = new Map(equipmentData.map((asset) => [asset.id, asset.name]));
  const returnedLoans = (Array.isArray(liveWorkflowState.loans) ? liveWorkflowState.loans : [])
    .filter((loan) => loan.status === 'returned' && loan.returnConfirmation)
    .sort((a, b) => String(b.returnConfirmation?.confirmedAt || b.updatedAt || '').localeCompare(String(a.returnConfirmation?.confirmedAt || a.updatedAt || '')));

  body.innerHTML = returnedLoans.length ? returnedLoans.map((loan) => {
    const returned = returnedEquipment(loan);
    const names = returned.map((item) => item.name || assetNames.get(item.assetId) || 'Phương tiện chưa xác định').filter(Boolean);
    const quantity = returned.reduce((sum, item) => sum + Math.max(0, Number(item.quantity || item.qty || 0)), 0);
    const returnDateValue = loan.returnRequest?.date || String(loan.returnConfirmation?.confirmedAt || loan.updatedAt || '').slice(0, 10);
    const teacherCondition = equipmentCondition(loan.returnRequest?.equipment);
    const teacherObservation = String(loan.returnRequest?.note || '').trim();
    const managerCondition = equipmentCondition(returned);
    const borrowerNote = teacherObservation;
    const confirmation = loan.returnConfirmation || {};
    const storedManagerNote = String(confirmation.managerNote ?? confirmation.note ?? '').trim();
    const hasExplicitManagerNote = Object.prototype.hasOwnProperty.call(confirmation, 'managerNote');
    const managerNote = hasExplicitManagerNote || storedManagerNote !== borrowerNote ? storedManagerNote : '';
    const generalNote = String(confirmation.generalNote || '').trim();
    const notes = [];
    if (generalNote) notes.push(generalNote);
    returned.forEach((item, index) => {
      const itemNote = String(item.note || '').trim();
      if (!itemNote || itemNote === borrowerNote || itemNote === managerNote || itemNote === generalNote) return;
      notes.push(`${names[index] || 'Phương tiện'}: ${itemNote}`);
    });
    const note = notes.join(' · ') || '—';
    const borrowDate = loan.handoff?.date || loan.borrowDate;
    const borrowTime = loan.handoff?.time || '';
    const returnTime = loan.returnRequest?.time || '';
    const equipmentMarkup = names.map((name) => `<span class="report-equipment-name">${escapeHtml(name)}</span>`).join('');
    return `<tr data-report-status="Đã trả" data-report-room="${escapeHtml(loan.returnRequest?.room || loan.handoff?.room || loan.room || '')}" data-report-equipment="${escapeHtml(names.join('|||'))}" data-report-date="${escapeHtml(returnDateValue)}">
      <td><button class="borrow-code workflow-code" type="button" data-workflow-action="details" data-loan-id="${escapeHtml(loan.id)}">${escapeHtml(loan.id)}</button></td>
      <td>${escapeHtml(loan.returnRequest?.returnedByName || loan.borrowerName || '')}</td>
      <td><span class="report-equipment-list">${equipmentMarkup || 'Chưa có phương tiện'}</span></td>
      <td>${quantity}</td>
      <td>${escapeHtml(reportDateTime(borrowDate, borrowTime))}</td>
      <td>${escapeHtml(reportDateTime(returnDateValue, returnTime))}</td>
      <td>${teacherObservation
        ? `<span class="report-observation">${escapeHtml(teacherObservation)}</span>`
        : `<span class="status ${reportConditionClass(teacherCondition)}">${escapeHtml(teacherCondition)}</span>`}</td>
      <td>${managerNote
        ? `<span class="report-observation">${escapeHtml(managerNote)}</span>`
        : `<span class="status ${reportConditionClass(managerCondition)}">${escapeHtml(managerCondition)}</span>`}</td>
      <td>${escapeHtml(note)}</td>
    </tr>`;
  }).join('') + '<tr id="reportFilteredEmpty" class="report-filter-empty" hidden><td colspan="9" class="source-empty-state">Không có phiếu phù hợp với bộ lọc.</td></tr>' : '<tr><td colspan="9" class="source-empty-state">Chưa có phiếu nào được xác nhận trả.</td></tr>';

  reportRows = [...body.querySelectorAll('tr[data-report-status]')];
  const rooms = [...new Set(returnedLoans.map((loan) => loan.returnRequest?.room || loan.handoff?.room || loan.room).filter(Boolean))];
  const names = [...new Set(returnedLoans.flatMap((loan) => returnedEquipment(loan).map((item) => item.name || assetNames.get(item.assetId) || 'Phương tiện chưa xác định')).filter(Boolean))];
  const updateOptions = (select, allLabel, values) => {
    if (!select) return;
    const current = select.value;
    select.innerHTML = `<option>${allLabel}</option>${values.map((value) => `<option>${escapeHtml(value)}</option>`).join('')}`;
    if ([...select.options].some((option) => option.value === current)) select.value = current;
  };
  updateOptions(reportRoom, 'Tất cả', rooms);
  updateOptions(reportEquipment, 'Tất cả', names);
  filterReports();
}

function filterReports() {
  const query = (reportSearch?.value || '').toLowerCase().trim();
  const room = reportRoom?.value === 'Tất cả' ? '' : reportRoom?.value;
  const equipment = reportEquipment?.value === 'Tất cả' ? '' : reportEquipment?.value;
  const status = reportStatus?.value === 'Tất cả' ? '' : reportStatus?.value;
  let visible = 0;
  reportRows.forEach((row) => {
    const matches = (!query || row.textContent.toLowerCase().includes(query))
      && (!room || row.dataset.reportRoom === room)
      && (!equipment || String(row.dataset.reportEquipment || '').split('|||').includes(equipment))
      && (!status || row.dataset.reportStatus === status)
      && (!reportStartDate?.value || row.dataset.reportDate >= reportStartDate.value)
      && (!reportEndDate?.value || row.dataset.reportDate <= reportEndDate.value);
    row.hidden = !matches;
    if (matches) visible += 1;
  });
  const filteredEmpty = document.getElementById('reportFilteredEmpty');
  if (filteredEmpty) filteredEmpty.hidden = visible > 0 || reportRows.length === 0;
  if (reportResultCount) {
    const total = reportRows.length;
    reportResultCount.textContent = total
      ? `Hiển thị ${visible} trong tổng số ${total} phiếu đã xác nhận trả`
      : 'Chưa có phiếu nào được xác nhận trả';
  }
}

reportSearch?.addEventListener('input', filterReports);
reportRoom?.addEventListener('change', filterReports);
reportEquipment?.addEventListener('change', filterReports);
reportStatus?.addEventListener('change', filterReports);
function updateReportDateRange() {
  const isValid = !reportStartDate?.value || !reportEndDate?.value || reportEndDate.value >= reportStartDate.value;
  reportEndDate?.setCustomValidity(isValid ? '' : 'Ngày kết thúc không được sớm hơn ngày bắt đầu.');
  if (isValid) filterReports();
}
reportStartDate?.addEventListener('change', updateReportDateRange);
reportEndDate?.addEventListener('change', updateReportDateRange);

const exportReportButton = document.getElementById('exportReport');
const reportExportMenu = document.getElementById('reportExportMenu');
const reportExportWrap = exportReportButton?.closest('.report-export-wrap');

function closeReportExportMenu() {
  if (!reportExportMenu || !exportReportButton) return;
  reportExportMenu.hidden = true;
  exportReportButton.setAttribute('aria-expanded', 'false');
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function downloadCsv(filename, headers, rows) {
  const csv = [headers, ...rows]
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n');
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function reportRowText(row) {
  return [...row.cells].map((cell) => cell.textContent.replace(/\s+/g, ' ').trim());
}

function exportHistoryReport() {
  const headers = ['Mã phiếu', 'Người trả', 'Phương tiện', 'Số lượng', 'Ngày mượn', 'Ngày trả', 'GV ghi nhận tình trạng', 'CBQL kiểm tra, ghi nhận', 'Ghi chú'];
  const rows = reportRows.filter((row) => !row.hidden).map(reportRowText);
  const stamp = businessDate();
  downloadCsv(`lich-su-muon-tra-${stamp}.csv`, headers, rows);
  showToast(`Đã xuất ${rows.length} phiếu lịch sử mượn trả`);
}

function exportEquipmentReport() {
  const headers = ['Phương tiện', 'Model/Hãng sản xuất/Xuất xứ', 'Phòng', 'Tổng', 'Mượn', 'Còn lại', 'Tình trạng', 'Ghi chú'];
  const rows = equipmentData.map((asset) => {
    const total = Math.max(0, Number(asset.qty || 0));
    const borrowed = Math.min(total, Math.max(0, Number(asset.borrowedQty || 0)));
    return [asset.name, asset.model, asset.room, total, borrowed, Math.max(0, total - borrowed), asset.status, asset.note || ''];
  });
  const stamp = businessDate();
  downloadCsv(`thong-ke-phuong-tien-${stamp}.csv`, headers, rows);
  showToast(`Đã xuất ${rows.length} phương tiện`);
}

exportReportButton?.addEventListener('click', (event) => {
  event.stopPropagation();
  if (!reportExportMenu) return;
  const open = reportExportMenu.hidden;
  reportExportMenu.hidden = !open;
  exportReportButton.setAttribute('aria-expanded', String(open));
  if (open) reportExportMenu.querySelector('[role="menuitem"]')?.focus();
});

reportExportMenu?.addEventListener('click', (event) => {
  const item = event.target.closest('[data-export-report]');
  if (!item) return;
  closeReportExportMenu();
  if (item.dataset.exportReport === 'history') exportHistoryReport();
  if (item.dataset.exportReport === 'equipment') exportEquipmentReport();
});

document.addEventListener('click', (event) => {
  if (reportExportWrap && !reportExportWrap.contains(event.target)) closeReportExportMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && reportExportMenu && !reportExportMenu.hidden) {
    closeReportExportMenu();
    exportReportButton?.focus();
  }
});
filterReports();
