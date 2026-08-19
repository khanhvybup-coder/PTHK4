(() => {
  'use strict';

  const API_STATE = '/api/state';
  const API_COMMANDS = '/api/commands';
  const API_EVENTS = '/api/events';
  const API_UPLOADS = '/api/uploads';
  const NETLIFY_POLLING = window.KTHS_DEPLOY_MODE === 'netlify';
  const MAX_FLOW_IMAGE_BYTES = 5 * 1024 * 1024;
  const FLOW_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
  const NOTIFICATION_READ_STORAGE_PREFIX = 'kths-notification-read-v1:';

  const source = window.KTHS_SOURCE_DATA || { staff: {}, rooms: [], assets: [] };
  const sourceStaff = source.staff || {};
  const sourceAssets = source.assets || [];
  const views = [...document.querySelectorAll('.content-wrap')];
  const tableBody = document.getElementById('borrowTableBody');
  const resultCount = document.getElementById('borrowResultCount');
  const createButton = document.getElementById('createBorrow');
  const approvalForm = document.getElementById('approvalForm');
  const borrowForm = document.getElementById('borrowForm');

  let state = { version: 0, loans: [], events: [], staff: sourceStaff };
  let actorKey = findInitialActor();
  let selectedLoanId = null;
  let approvalMode = null;
  let returnMode = null;
  let activeFilter = 'all';
  let eventSource = null;
  let realtimeUnsubscribe = null;
  let reconnectTimer = null;
  let pollTimer = null;
  let loading = false;
  let reloadQueued = false;
  let stateInitialized = false;
  let connectionKind = 'syncing';
  let commandInFlight = false;
  let workflowOrigin = null;

  async function authenticatedHeaders(extra = {}) {
    const authHeaders = await window.KTHSAuth?.getAuthHeaders?.() || {};
    return { ...extra, ...authHeaders };
  }

  const statusMeta = {
    pending_manager: { label: 'Chờ cán bộ quản lý', css: 'warning', filter: 'approval' },
    pending_leader: { label: 'Chờ ý kiến lãnh đạo', css: 'warning', filter: 'approval' },
    leader_opinion_returned: { label: 'Đã có ý kiến lãnh đạo', css: 'info', filter: 'approval' },
    approved: { label: 'Đã duyệt', css: 'success', filter: 'approval' },
    rejected: { label: 'Đã từ chối', css: 'danger', filter: 'rejected' },
    borrowing: { label: 'Đang mượn', css: 'info', filter: 'borrowing' },
    overdue: { label: 'Quá hạn', css: 'danger', filter: 'overdue' },
    return_pending: { label: 'Chờ xác nhận trả', css: 'return-pending', filter: 'borrowing' },
    returned: { label: 'Đã trả', css: 'neutral', filter: 'returned' }
  };

  const eventLabels = {
    submit: 'Đăng ký mượn phòng và phương tiện',
    request_leader: 'Cán bộ quản lý gửi xin ý kiến lãnh đạo',
    leader_opinion: 'Lãnh đạo gửi ý kiến về cán bộ quản lý',
    manager_decide: 'Cán bộ quản lý đưa ra quyết định cuối cùng',
    confirm_handoff: 'Cán bộ quản lý xác nhận giao',
    request_return: 'Người sử dụng gửi trả phòng và phương tiện',
    confirm_return: 'Cán bộ quản lý xác nhận đã trả'
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
  }

  function findInitialActor() {
    if (window.KTHSActiveUserKey && sourceStaff[window.KTHSActiveUserKey]) return window.KTHSActiveUserKey;
    const shownName = document.getElementById('topProfileName')?.textContent.trim();
    return Object.entries(sourceStaff).find(([, user]) => user.name === shownName)?.[0]
      || (sourceStaff.huan ? 'huan' : Object.keys(sourceStaff)[0]);
  }

  function staffMap() {
    if (Array.isArray(state.staff)) {
      return Object.fromEntries(state.staff.map((user) => [user.key || user.id, user]));
    }
    return { ...sourceStaff, ...(state.staff || {}) };
  }

  function user(key) {
    return staffMap()[key] || sourceStaff[key] || { name: key || 'Không xác định', role: 'teacher' };
  }

  function role() {
    const actor = user(actorKey);
    if (actorKey === 'huan' && actor.role === 'manager') return 'manager';
    if (['thuong', 'cong'].includes(actorKey) && actor.role === 'approver') return 'approver';
    return 'teacher';
  }

  function loanId(loan) {
    return String(loan?.id || loan?.loanId || loan?.code || '');
  }

  function loanCode(loan) {
    return loan?.code || loan?.loanCode || loanId(loan);
  }

  function borrowerKey(loan) {
    return loan?.borrowerId || loan?.borrowerKey || loan?.createdBy || loan?.actorKey;
  }

  function borrowerName(loan) {
    return loan?.borrowerName || user(borrowerKey(loan)).name;
  }

  function loanStatus(loan) {
    return loan?.status || 'pending_manager';
  }

  function displayStatus(loan) {
    const status = loanStatus(loan);
    if (status === 'borrowing' && loan?.expectedReturnDate && loan.expectedReturnDate < localIsoDate()) return 'overdue';
    return status;
  }

  function assignedLeader(loan) {
    return loan?.leaderId || loan?.assignedLeaderId || loan?.leaderKey
      || loan?.requestedLeaderId || loan?.requestedLeaderKey
      || loan?.approval?.leaderId || loan?.leaderRequest?.leaderId;
  }

  function loanItems(loan) {
    const items = loan?.equipment || loan?.items || loan?.assets || [];
    return Array.isArray(items) ? items : [];
  }

  function itemId(item) {
    return item?.assetId || item?.equipmentId || item?.id || item?.code || '';
  }

  function itemQuantity(item) {
    return Number(item?.quantity ?? item?.qty ?? item?.amount ?? 1) || 1;
  }

  function assetName(id, item = {}) {
    const liveCatalog = Array.isArray(state.inventory)
      ? state.inventory
      : (window.KTHSGetEquipmentCatalog?.() || sourceAssets);
    return item.name || item.assetName || liveCatalog.find((asset) => asset.id === id)?.name || 'Phương tiện chưa xác định';
  }

  function formatDate(value) {
    if (!value) return '';
    const raw = String(value).slice(0, 10);
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? `${match[3]}/${match[2]}/${match[1]}` : String(value);
  }

  function dateValue(value, fallback = '') {
    const raw = String(value || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : fallback;
  }

  function localIsoDate(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function addDaysIso(days) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return localIsoDate(date);
  }

  function formatTimestamp(value) {
    if (!value) return 'Chưa có thời gian';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('vi-VN', {
      dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Bangkok'
    }).format(date);
  }

  function notify(message) {
    if (typeof window.showToast === 'function') window.showToast(message);
    else {
      const toast = document.getElementById('toast');
      if (toast) {
        toast.textContent = message;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 2600);
      }
    }
  }

  function switchTo(viewId, title) {
    const target = document.getElementById(viewId);
    if (!target) return;
    views.forEach((view) => view.classList.toggle('view-hidden', view !== target));
    const pageTitle = document.getElementById('pageTitle');
    if (pageTitle && title) pageTitle.textContent = title;
    if (viewId === 'borrowView') {
      document.querySelectorAll('.nav-item').forEach((item) => {
        item.classList.toggle('active', item.dataset.view === 'borrowView');
      });
    }
    window.scrollTo(0, 0);
  }

  function rememberWorkflowOrigin(origin = null) {
    if (origin) {
      workflowOrigin = { ...origin };
      return;
    }
    const current = views.find((view) => !view.classList.contains('view-hidden'));
    workflowOrigin = {
      viewId: current?.id || 'borrowView',
      title: document.getElementById('pageTitle')?.textContent || 'Qu\u1EA3n l\u00FD M\u01B0\u1EE3n - Tr\u1EA3',
      filter: activeFilter,
      scrollY: window.scrollY
    };
  }

  function goBackWorkflow() {
    const origin = workflowOrigin || {
      viewId: 'borrowView',
      title: 'Qu\u1EA3n l\u00FD M\u01B0\u1EE3n - Tr\u1EA3',
      filter: activeFilter,
      scrollY: 0
    };
    selectedLoanId = null;
    approvalMode = null;
    returnMode = null;
    workflowOrigin = null;
    activeFilter = origin.filter || 'all';
    document.querySelectorAll('.borrow-status-filter').forEach((item) => {
      item.classList.toggle('active', item.dataset.statusFilter === activeFilter);
    });
    const allowedOrigins = new Set(['overviewView', 'roomsView', 'equipmentView', 'borrowView', 'reportsView']);
    const targetView = allowedOrigins.has(origin.viewId) ? origin.viewId : 'borrowView';
    const targetTitle = targetView === 'borrowView'
      ? 'Qu\u1EA3n l\u00FD M\u01B0\u1EE3n - Tr\u1EA3'
      : (origin.title || 'Khoa K\u1EF9 Thu\u1EADt H\u00ECnh S\u1EF1');
    switchTo(targetView, targetTitle);
    if (targetView === 'borrowView') renderLoanTable();
    requestAnimationFrame(() => window.scrollTo(0, Number(origin.scrollY) || 0));
  }

  function showNextWorkflowStep(filter = 'all') {
    selectedLoanId = null;
    approvalMode = null;
    returnMode = null;
    workflowOrigin = null;
    activeFilter = filter;
    document.querySelectorAll('.borrow-status-filter').forEach((item) => {
      item.classList.toggle('active', item.dataset.statusFilter === filter);
    });
    switchTo('borrowView', 'Quản lý Mượn - Trả');
    renderLoanTable();
  }

  function filterForLoan(loan, fallback = 'all') {
    if (!loan) return fallback;
    return statusMeta[displayStatus(loan)]?.filter || fallback;
  }

  function currentLoan() {
    return state.loans.find((loan) => loanId(loan) === selectedLoanId) || null;
  }

  function visibleLoans() {
    return state.loans;
  }

  function notificationScopeLoans() {
    const currentRole = role();
    if (currentRole === 'manager') return state.loans;
    if (currentRole === 'approver') {
      return state.loans.filter((loan) => borrowerKey(loan) === actorKey
        || (loanStatus(loan) === 'pending_leader' && assignedLeader(loan) === actorKey));
    }
    return state.loans.filter((loan) => borrowerKey(loan) === actorKey);
  }

  function matchesFilter(loan) {
    if (activeFilter === 'all') return true;
    return filterKeyForLoan(loan) === activeFilter;
  }

  function filterKeyForLoan(loan) {
    const shownStatus = displayStatus(loan);
    return statusMeta[shownStatus]?.filter || shownStatus;
  }

  function updateBorrowFilterCounts() {
    const counts = { all: 0, approval: 0, borrowing: 0, overdue: 0, returned: 0, rejected: 0 };
    const filterLabels = {
      all: 'Tất cả',
      approval: 'Duyệt cho mượn',
      borrowing: 'Đang mượn',
      overdue: 'Quá hạn',
      returned: 'Đã trả',
      rejected: 'Đã từ chối'
    };
    state.loans.forEach((loan) => {
      counts.all += 1;
      const filterKey = filterKeyForLoan(loan);
      if (Object.prototype.hasOwnProperty.call(counts, filterKey)) counts[filterKey] += 1;
    });

    const unreadCounts = { all: 0, approval: 0, borrowing: 0, overdue: 0, returned: 0, rejected: 0 };
    unreadNotifications().forEach(({ loan }) => {
      unreadCounts.all += 1;
      const filterKey = filterKeyForLoan(loan);
      if (Object.prototype.hasOwnProperty.call(unreadCounts, filterKey)) unreadCounts[filterKey] += 1;
    });

    document.querySelectorAll('.borrow-status-filter').forEach((filter) => {
      const filterKey = filter.dataset.statusFilter || 'all';
      let countBadge = filter.querySelector('.borrow-filter-count');
      if (!countBadge) {
        countBadge = document.createElement('span');
        countBadge.className = 'borrow-filter-count';
        countBadge.setAttribute('aria-hidden', 'true');
        filter.appendChild(countBadge);
      }
      countBadge.textContent = String(counts[filterKey] ?? 0);

      let unreadBadge = filter.querySelector('.borrow-filter-unread');
      if (!unreadBadge) {
        unreadBadge = document.createElement('span');
        unreadBadge.className = 'borrow-filter-unread';
        unreadBadge.setAttribute('aria-hidden', 'true');
        filter.appendChild(unreadBadge);
      }
      const unread = unreadCounts[filterKey] || 0;
      unreadBadge.textContent = unread > 99 ? '99+' : String(unread);
      unreadBadge.hidden = unread === 0;
      unreadBadge.title = unread ? `${unread} thông báo chưa xem` : '';
      filter.setAttribute('aria-label', `${filterLabels[filterKey] || 'Trạng thái'}: ${counts[filterKey] ?? 0} phiếu${unread ? `, ${unread} chưa xem` : ''}`);
    });
  }

  function actionMarkup(loan) {
    const id = loanId(loan);
    const status = loanStatus(loan);
    const currentRole = role();
    const details = `<button class="more-action workflow-detail" type="button" data-workflow-action="details" data-loan-id="${escapeHtml(id)}" title="Xem thông tin phiếu" aria-label="Xem thông tin phiếu">⋮</button>`;
    let primary = '';

    if (currentRole === 'manager' && status === 'pending_manager') {
      primary = actionButton('approve', id, '✓', 'Duyệt cho mượn');
    } else if (currentRole === 'manager' && status === 'leader_opinion_returned') {
      primary = actionButton('manager-decision', id, '✓', 'Quyết định cuối');
    } else if (currentRole === 'manager' && status === 'approved') {
      primary = actionButton('handoff', id, '→', 'Xác nhận giao');
    } else if (currentRole === 'manager' && status === 'return_pending') {
      primary = actionButton('return-confirm', id, '✓', 'Xác nhận đã trả');
    } else if (currentRole === 'approver' && status === 'pending_leader' && assignedLeader(loan) === actorKey) {
      primary = actionButton('leader-opinion', id, '✓', 'Cho ý kiến');
    } else if (status === 'borrowing' && borrowerKey(loan) === actorKey) {
      primary = actionButton('return-request', id, '↩', 'Trả phương tiện');
    }

    return `<div class="row-actions">${primary}${details}</div>`;
  }

  function actionButton(action, id, icon, label) {
    const css = action === 'return-request' ? 'return-request'
      : action === 'return-confirm' ? 'return-confirm'
        : action === 'handoff' ? 'handoff' : 'approve';
    return `<button class="flow-action-button ${css}" type="button" data-workflow-action="${action}" data-loan-id="${escapeHtml(id)}"><span aria-hidden="true">${icon}</span>${label}</button>`;
  }

  function renderLoanTable() {
    if (!tableBody) return;
    const accessibleLoans = visibleLoans();
    const loans = accessibleLoans.filter(matchesFilter);
    tableBody.innerHTML = loans.length ? loans.map((loan) => {
      const shownStatus = displayStatus(loan);
      const baseMeta = statusMeta[shownStatus] || { label: shownStatus, css: 'neutral' };
      const leaderName = assignedLeader(loan) ? user(assignedLeader(loan)).name : '';
      const meta = shownStatus === 'pending_leader' && leaderName
        ? { ...baseMeta, label: `Chờ ý kiến ${leaderName}` }
        : shownStatus === 'leader_opinion_returned' && leaderName
          ? { ...baseMeta, label: `Đã nhận ý kiến ${leaderName}` }
          : baseMeta;
      const borrowDate = loan.borrowDate || loan.startDate;
      const expectedDate = loan.expectedReturnDate || loan.dueDate;
      const borrowTime = loan.borrowTime || loan.createdTime || '';
      const returnTime = loan.expectedReturnTime || '';
      return `<tr data-tab="borrow" data-status-key="${escapeHtml(loanStatus(loan))}" data-loan-id="${escapeHtml(loanId(loan))}" data-room="${escapeHtml(loan.room || '')}">
        <td><button class="borrow-code workflow-code" type="button" data-workflow-action="details" data-loan-id="${escapeHtml(loanId(loan))}">${escapeHtml(loanCode(loan))}</button></td>
        <td>${escapeHtml(borrowerName(loan))}</td>
        <td class="borrow-purpose">${escapeHtml(loan.purpose || '')}</td>
        <td><span class="date-stack">${escapeHtml(formatDate(borrowDate))}${borrowTime ? `<small>${escapeHtml(borrowTime)}</small>` : ''}</span></td>
        <td><span class="date-stack">${escapeHtml(formatDate(expectedDate))}${returnTime ? `<small>${escapeHtml(returnTime)}</small>` : ''}</span></td>
        <td><span class="status ${meta.css}">${escapeHtml(meta.label)}</span></td>
        <td>${actionMarkup(loan)}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="7" class="source-empty-state">Không có phiếu phù hợp với trạng thái đã chọn.</td></tr>';

    if (resultCount) {
      resultCount.textContent = activeFilter === 'all'
        ? `Hiển thị ${loans.length} phiếu`
        : `Hiển thị ${loans.length} trong tổng số ${accessibleLoans.length} phiếu`;
    }
    updateRoleControls();
    updateBorrowFilterCounts();
  }

  function updateRoleControls() {
    if (!createButton) return;
    const currentRole = role();
    createButton.hidden = false;
    createButton.style.display = '';
    createButton.setAttribute('aria-hidden', 'false');
    // Keep the button clickable before authentication so it can open the
    // password prompt. The click handler performs the actual auth guard.
    createButton.disabled = connectionKind !== 'online';
    createButton.innerHTML = '<span aria-hidden="true">＋</span> Tạo phiếu mượn';
    document.querySelectorAll('.borrow-status-filter').forEach((filter) => {
      filter.hidden = false;
      filter.style.display = '';
      filter.setAttribute('aria-hidden', 'false');
    });
    updateActionAvailability();
  }

  function updateActionAvailability() {
    const online = connectionKind === 'online' && !commandInFlight;
    const authenticated = window.KTHSIsAuthenticated?.() === true;
    document.querySelectorAll('[data-workflow-action]').forEach((button) => {
      const readOnlyAction = ['details', 'close-audit', 'back', 'view-photo', 'close-photo-viewer'].includes(button.dataset.workflowAction);
      const locked = !readOnlyAction && (!online || !authenticated);
      button.disabled = locked;
      if (locked) button.title = !online ? 'Tạm khóa khi chưa kết nối máy chủ' : 'Vui lòng nhập mật khẩu để thao tác';
      else if (button.title === 'Tạm khóa khi chưa kết nối máy chủ' || button.title === 'Vui lòng nhập mật khẩu để thao tác') button.removeAttribute('title');
    });
    document.querySelectorAll('.approval-submit, .handoff-submit, .return-submit, .form-submit').forEach((button) => {
      button.disabled = !online || !authenticated;
      button.title = online ? (authenticated ? '' : 'Vui lòng nhập mật khẩu để thao tác') : 'Tạm khóa khi chưa kết nối máy chủ';
    });
    // Do not disable this trigger for an unauthenticated user: clicking it
    // must be able to open the password prompt. Other workflow actions remain
    // locked until authentication succeeds.
    if (createButton) createButton.disabled = !online;
  }

  function applyState(nextState, { render = true } = {}) {
    if (!nextState || !Array.isArray(nextState.loans)) return;
    const incomingVersion = Number(nextState.version);
    const currentVersion = Number(state.version);
    if (Number.isFinite(incomingVersion) && Number.isFinite(currentVersion) && incomingVersion < currentVersion) return;
    if (stateInitialized && Number.isFinite(incomingVersion) && incomingVersion === currentVersion) return;
    state = { ...state, ...nextState, loans: nextState.loans, events: nextState.events || [] };
    stateInitialized = true;
    window.dispatchEvent(new CustomEvent('kths:workflowstate', { detail: { state } }));
    if (render) renderLoanTable();
    updateNotificationCount();
    const detailDialog = document.getElementById('workflowAuditDialog');
    const detailLoanId = detailDialog?.open ? detailDialog.dataset.loanId : '';
    if (detailLoanId) {
      const detailLoan = state.loans.find((loan) => loanId(loan) === detailLoanId);
      if (detailLoan) openAudit(detailLoan);
      else detailDialog.close();
    }
    if (!commandInFlight) reconcileOpenWorkflowView();
  }

  function reconcileOpenWorkflowView() {
    if (!selectedLoanId) return;
    const currentView = views.find((view) => !view.classList.contains('view-hidden'))?.id;
    if (!['approvalView', 'handoffView', 'returnView'].includes(currentView)) return;
    const loan = currentLoan();
    const status = loan ? loanStatus(loan) : '';
    const currentRole = role();
    const valid = currentView === 'approvalView'
      ? (approvalMode === 'manager-review' && currentRole === 'manager' && status === 'pending_manager')
        || (approvalMode === 'manager-final' && currentRole === 'manager' && status === 'leader_opinion_returned')
        || (approvalMode === 'leader' && currentRole === 'approver' && status === 'pending_leader' && assignedLeader(loan) === actorKey)
      : currentView === 'handoffView'
        ? currentRole === 'manager' && status === 'approved'
        : (returnMode === 'manager-confirm' && currentRole === 'manager' && status === 'return_pending')
          || (returnMode === 'request' && status === 'borrowing' && borrowerKey(loan) === actorKey);
    if (valid) return;
    const nextFilter = statusMeta[displayStatus(loan)]?.filter || 'all';
    showNextWorkflowStep(nextFilter);
    notify('Phiếu đã chuyển sang bước xử lý tiếp theo');
  }

  async function loadState({ quiet = false } = {}) {
    if (loading) {
      reloadQueued = true;
      return;
    }
    loading = true;
    try {
      if (window.KTHSAuth) {
        await window.KTHSAuth.ready();
        if (!window.KTHSAuth.isAuthenticated()) {
          setConnection('offline', 'Cần đăng nhập');
          return;
        }
      }
      const stateUrl = stateInitialized
        ? `${API_STATE}?version=${encodeURIComponent(state.version)}`
        : API_STATE;
      const response = await fetch(stateUrl, {
        cache: 'no-store',
        headers: await authenticatedHeaders({ Accept: 'application/json' })
      });
      if (response.status === 204) {
        setConnection('online', NETLIFY_POLLING ? 'Đồng bộ Supabase' : 'Thời gian thực');
        return;
      }
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok === false) {
        const detail = result.message || result.error || `Không tải được dữ liệu (${response.status})`;
        const error = new Error(detail);
        error.code = result.error || `HTTP_${response.status}`;
        error.status = response.status;
        throw error;
      }
      applyState(result);
      setConnection('online', 'Thời gian thực');
    } catch (error) {
      setConnection('offline', 'Mất kết nối');
      if (!quiet) notify(error.message || 'Không thể kết nối máy chủ');
    } finally {
      loading = false;
      if (reloadQueued) {
        reloadQueued = false;
        queueMicrotask(() => loadState({ quiet: true }));
      }
    }
  }

  async function sendCommand(type, { loan = null, payload = {}, success = '' } = {}) {
    if (window.KTHSIsAuthenticated && window.KTHSIsAuthenticated() !== true) {
      window.KTHSRequireAuthentication?.();
      const error = new Error('AUTH_REQUIRED');
      error.code = 'AUTH_REQUIRED';
      throw error;
    }
    if (connectionKind !== 'online') {
      notify('Chưa kết nối máy chủ. Thao tác chưa được ghi nhận');
      throw new Error('WORKFLOW_OFFLINE');
    }
    if (commandInFlight) {
      notify('Thao tác trước đang được ghi nhận');
      throw new Error('WORKFLOW_BUSY');
    }
    commandInFlight = true;
    let serverResponded = false;
    let commandFailed = false;
    setConnection('syncing', 'Đang đồng bộ');
    try {
      const body = {
        type,
        actorKey,
        expectedVersion: state.version,
        commandId: crypto.randomUUID?.() || `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        payload
      };
      if (loan) body.loanId = loanId(loan);
      const response = await fetch(API_COMMANDS, {
        method: 'POST',
        headers: await authenticatedHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
        body: JSON.stringify(body)
      });
      serverResponded = true;
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok === false) {
        if (response.status === 409) await loadState({ quiet: true });
        throw new Error(result.message || result.error || `Không thể thực hiện thao tác (${response.status})`);
      }
      if (result.state) applyState(result.state);
      else await loadState({ quiet: true });
      setConnection('online', 'Thời gian thực');
      if (success) notify(success);
      return result;
    } catch (error) {
      commandFailed = true;
      setConnection(serverResponded ? 'online' : 'offline', serverResponded ? 'Thời gian thực' : 'Mất kết nối');
      if (error.code !== 'AUTH_REQUIRED') notify(error.message || 'Thao tác chưa được ghi nhận');
      throw error;
    } finally {
      commandInFlight = false;
      updateActionAvailability();
      if (commandFailed) reconcileOpenWorkflowView();
    }
  }

  function connectEvents() {
    clearTimeout(reconnectTimer);
    eventSource?.close();
    realtimeUnsubscribe?.();
    realtimeUnsubscribe = null;
    if (NETLIFY_POLLING && window.KTHSAuth) {
      eventSource = null;
      if (!window.KTHSAuth.isAuthenticated()) {
        setConnection('offline', 'Cần đăng nhập');
        return;
      }
      realtimeUnsubscribe = window.KTHSAuth.subscribeStateChanges(() => loadState({ quiet: true }));
      window.KTHSAuth.reconnectRealtime();
      setConnection('online', 'Supabase Realtime');
      loadState({ quiet: true });
      return;
    }
    setConnection('syncing', 'Đang kết nối');
    eventSource = new EventSource(API_EVENTS);
    const consume = (event) => {
      try {
        const next = JSON.parse(event.data);
        applyState(next.state || next);
        setConnection('online', 'Thời gian thực');
      } catch {
        loadState({ quiet: true });
      }
    };
    eventSource.addEventListener('state', consume);
    eventSource.onmessage = consume;
    eventSource.onopen = () => setConnection('online', 'Thời gian thực');
    eventSource.onerror = () => {
      setConnection('offline', 'Đang kết nối lại');
      eventSource?.close();
      reconnectTimer = setTimeout(connectEvents, 3000);
    };
  }

  function setConnection(kind, label) {
    connectionKind = kind;
    const indicator = document.getElementById('workflowLiveStatus') || document.getElementById('liveStatus');
    if (indicator) {
      indicator.dataset.status = kind;
      const copy = indicator.querySelector('span');
      if (copy) copy.textContent = label;
      indicator.title = kind === 'online'
        ? 'Dữ liệu được cập nhật ngay khi người khác xác nhận'
        : label;
    }
    const bar = document.getElementById('workflowLiveBar');
    const barCopy = document.getElementById('workflowLiveText');
    bar?.classList.toggle('offline', kind !== 'online');
    if (barCopy) barCopy.textContent = kind === 'online' ? 'Dữ liệu đang được cập nhật theo thời gian thực' : label;
    updateActionAvailability();
  }

  function notificationAction(loan) {
    const currentRole = role();
    const status = loanStatus(loan);
    if (currentRole === 'manager' && status === 'pending_manager') return 'approve';
    if (currentRole === 'manager' && status === 'leader_opinion_returned') return 'manager-decision';
    if (currentRole === 'manager' && status === 'approved') return 'handoff';
    if (currentRole === 'manager' && status === 'return_pending') return 'return-confirm';
    if (currentRole === 'approver' && status === 'pending_leader' && assignedLeader(loan) === actorKey) return 'leader-opinion';
    if (status === 'borrowing' && borrowerKey(loan) === actorKey) return 'return-request';
    return '';
  }

  function notificationLabel(action) {
    return {
      approve: 'Duyệt cho mượn',
      'manager-decision': 'Quyết định cuối',
      'leader-opinion': 'Cho ý kiến',
      handoff: 'Xác nhận giao',
      'return-confirm': 'Xác nhận đã trả',
      'return-request': 'Gửi yêu cầu trả'
    }[action] || 'Cần xử lý';
  }

  function notificationKey(loan) {
    const action = notificationAction(loan);
    return action ? `${loanId(loan)}:${action}` : '';
  }

  function readNotificationKeys() {
    try {
      const raw = window.localStorage.getItem(`${NOTIFICATION_READ_STORAGE_PREFIX}${actorKey}`);
      const parsed = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(parsed) ? parsed.filter((key) => typeof key === 'string') : []);
    } catch {
      return new Set();
    }
  }

  function writeNotificationKeys(keys) {
    try {
      window.localStorage.setItem(
        `${NOTIFICATION_READ_STORAGE_PREFIX}${actorKey}`,
        JSON.stringify([...keys].slice(-500))
      );
    } catch {
      // Storage can be unavailable in private/file contexts; the live count still works for this page.
    }
  }

  function unreadNotifications() {
    const read = readNotificationKeys();
    return actionableLoans().map((loan) => ({
      loan,
      key: notificationKey(loan),
      action: notificationAction(loan)
    })).filter((item) => item.key && !read.has(item.key));
  }

  function markNotificationsRead(items = actionableLoans()) {
    const read = readNotificationKeys();
    items.forEach((item) => {
      const key = typeof item === 'string' ? item : notificationKey(item);
      if (key) read.add(key);
    });
    writeNotificationKeys(read);
    updateNotificationCount();
  }

  function updateNotificationCount() {
    const badge = document.getElementById('notificationCount');
    const button = document.getElementById('notificationButton');
    if (!badge || !button) return;
    const count = unreadNotifications().length;
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.hidden = count === 0;
    badge.setAttribute('aria-hidden', String(count === 0));
    button.setAttribute('aria-label', count
      ? `Thông báo: ${count} thông báo chưa xem`
      : 'Thông báo: không có thông báo mới');
    updateBorrowFilterCounts();
  }

  function actionableLoans() {
    const currentRole = role();
    return state.loans.filter((loan) => {
      const status = loanStatus(loan);
      return (currentRole === 'manager' && ['pending_manager', 'leader_opinion_returned', 'approved', 'return_pending'].includes(status))
        || (currentRole === 'approver' && status === 'pending_leader' && assignedLeader(loan) === actorKey)
        || (status === 'borrowing' && borrowerKey(loan) === actorKey);
    });
  }

  function resetBorrowFormDates() {
    const today = localIsoDate();
    const borrowDate = document.getElementById('borrowDate');
    const expectedDate = document.getElementById('expectedReturnDate');
    if (borrowDate) borrowDate.value = today;
    if (expectedDate) expectedDate.value = addDaysIso(2);
    const borrower = document.getElementById('borrowerName');
    const currentName = user(actorKey).name;
    if (borrower) {
      const option = [...borrower.options].find((item) => item.textContent.trim() === currentName);
      if (option) borrower.value = option.value;
      borrower.disabled = true;
    }
  }

  function collectBorrowPayload() {
    const equipment = (window.KTHSGetBorrowEquipmentSelection?.() || []).map((item) => ({
      assetId: String(item.assetId || ''),
      name: assetName(String(item.assetId || ''), item),
      quantity: Number(item.quantity),
      available: Number(item.available),
      note: String(item.note || '').trim()
    })).filter((item) => item.assetId);
    return {
      borrowerId: actorKey,
      room: document.getElementById('borrowRoom')?.value || '',
      purpose: document.getElementById('borrowPurpose')?.value.trim() || '',
      borrowDate: document.getElementById('borrowDate')?.value || '',
      expectedReturnDate: document.getElementById('expectedReturnDate')?.value || '',
      note: document.getElementById('borrowNote')?.value.trim() || '',
      equipment
    };
  }

  async function submitBorrow() {
    if (!window.KTHSRequireAuthentication?.()) return;
    const payload = collectBorrowPayload();
    if (!payload.room || !payload.purpose || !payload.borrowDate || !payload.expectedReturnDate) {
      return notify('Vui lòng nhập đầy đủ phòng, mục đích và thời gian mượn');
    }
    if (payload.expectedReturnDate < payload.borrowDate) {
      return notify('Ngày trả dự kiến không được sớm hơn ngày mượn');
    }
    const pickerValidation = window.KTHSValidateBorrowEquipmentSelection?.({ focus: true });
    if (pickerValidation && !pickerValidation.valid) {
      return notify(pickerValidation.message || 'Vui lòng kiểm tra lại phương tiện đã chọn');
    }
    if (!payload.equipment.length) {
      const trigger = document.getElementById('borrowEquipmentToggle');
      trigger?.classList.add('is-invalid');
      trigger?.focus();
      return notify('Vui lòng chọn ít nhất một phương tiện');
    }
    const invalidEquipment = payload.equipment.find((item) => !Number.isInteger(item.quantity) || item.quantity < 1);
    if (invalidEquipment) return notify(`Số lượng ${invalidEquipment.name || 'phương tiện'} phải là số nguyên lớn hơn 0`);
    const overAvailable = payload.equipment.find((item) => Number.isFinite(item.available) && item.quantity > item.available);
    if (overAvailable) return notify(`${overAvailable.name || 'Phương tiện'} chỉ còn ${overAvailable.available} thiết bị có thể mượn`);
    const result = await sendCommand('submit', { payload, success: 'Đã gửi phiếu đến cán bộ quản lý' });
    borrowForm?.reset();
    window.KTHSResetBorrowEquipmentSelection?.();
    resetBorrowFormDates();
    showNextWorkflowStep(filterForLoan(result.loan, 'approval'));
  }

  function leaderOptions(selected = '') {
    return Object.entries(staffMap())
      .filter(([key, entry]) => ['thuong', 'cong'].includes(key) && entry.role === 'approver')
      .map(([key, entry]) => `<option value="${escapeHtml(key)}"${key === selected ? ' selected' : ''}>${escapeHtml(entry.name)}</option>`)
      .join('');
  }

  function syncLeaderField() {
    const field = document.getElementById('approvalLeaderField');
    const select = document.getElementById('approvalLeader');
    const selectedDecision = document.querySelector('input[name="approvalDecision"]:checked')?.value;
    const visible = approvalMode === 'manager-review' && selectedDecision === 'leader';
    if (field) {
      field.hidden = !visible;
      field.style.display = visible ? '' : 'none';
      field.setAttribute('aria-hidden', String(!visible));
    }
    if (select) select.required = visible;
  }

  function renderApprovalSummary(loan) {
    const details = document.querySelector('.approval-details');
    if (details) {
      details.innerHTML = `
        <div><dt>Mã phiếu</dt><dd><button class="workflow-code" type="button" data-workflow-action="details" data-loan-id="${escapeHtml(loanId(loan))}">${escapeHtml(loanCode(loan))}</button></dd></div>
        <div><dt>Người mượn</dt><dd>${escapeHtml(borrowerName(loan))}</dd></div>
        <div><dt>Mục đích</dt><dd>${escapeHtml(loan.purpose || '')}</dd></div>
        <div><dt>Phòng thực hành</dt><dd>${escapeHtml(loan.room || '')}</dd></div>
        <div><dt>Ngày mượn</dt><dd>${escapeHtml(formatDate(loan.borrowDate))}</dd></div>
        <div><dt>Ngày trả dự kiến</dt><dd>${escapeHtml(formatDate(loan.expectedReturnDate))}</dd></div>`;
    }
    const equipmentBody = document.querySelector('.approval-equipment-table tbody');
    if (equipmentBody) equipmentBody.innerHTML = equipmentRows(loan, false);
  }

  function latestEvent(loan, type) {
    const id = loanId(loan);
    return [...state.events].reverse().find((event) => {
      const eventLoanId = event.loanId || event.entityId || event.payload?.loanId;
      return String(eventLoanId) === id && (event.type || event.action) === type;
    });
  }

  function eventDecision(event) {
    return event?.details?.decision || event?.payload?.decision || event?.decision || '';
  }

  function openApproval(loan, mode) {
    if (!loan) return;
    rememberWorkflowOrigin();
    selectedLoanId = loanId(loan);
    approvalMode = mode;
    renderApprovalSummary(loan);
    const title = document.querySelector('.approval-opinion-panel h2');
    const submit = approvalForm?.querySelector('[type="submit"]');
    const leaderField = document.getElementById('approvalLeaderField');
    const leaderSelect = document.getElementById('approvalLeader');
    const labels = [...document.querySelectorAll('.approval-options label')];
    const radios = [...document.querySelectorAll('input[name="approvalDecision"]')];
    const banner = ensureApprovalBanner();
    labels.forEach((label) => { label.hidden = false; });
    radios.forEach((radio) => { radio.checked = false; });
    if (leaderSelect) leaderSelect.innerHTML = leaderOptions(assignedLeader(loan));

    if (mode === 'leader') {
      if (title) title.textContent = 'Ý kiến lãnh đạo';
      if (submit) submit.textContent = 'Gửi ý kiến';
      labels[0]?.querySelector('span')?.replaceChildren(document.createTextNode('Đồng ý cho mượn'));
      labels[1]?.querySelector('span')?.replaceChildren(document.createTextNode('Không đồng ý'));
      if (labels[2]) labels[2].hidden = true;
      if (radios[0]) radios[0].checked = true;
      syncLeaderField();
      banner.hidden = true;
      switchTo('approvalView', 'Cho ý kiến phiếu mượn (Lãnh đạo)');
      return;
    }

    if (title) title.textContent = mode === 'manager-final' ? 'Quyết định của cán bộ quản lý' : 'Ý kiến duyệt';
    if (submit) submit.textContent = mode === 'manager-final' ? 'Xác nhận quyết định' : 'Xác nhận duyệt';
    labels[0]?.querySelector('span')?.replaceChildren(document.createTextNode('Đồng ý'));
    labels[1]?.querySelector('span')?.replaceChildren(document.createTextNode('Không đồng ý'));
    labels[2]?.querySelector('span')?.replaceChildren(document.createTextNode('Xin ý kiến lãnh đạo'));

    if (mode === 'manager-final') {
      if (labels[2]) labels[2].hidden = true;
      const opinion = latestEvent(loan, 'leader_opinion');
      const decision = eventDecision(opinion);
      const chosen = decision === 'reject' ? radios[1] : radios[0];
      if (chosen) chosen.checked = true;
      syncLeaderField();
      banner.hidden = false;
      const opinionNote = opinion?.details?.note || opinion?.payload?.note || opinion?.note || '';
      banner.innerHTML = `<strong>Ý kiến của ${escapeHtml(user(assignedLeader(loan)).name)}</strong><span>${decision === 'approve' ? 'Đồng ý cho mượn' : 'Không đồng ý'}${opinionNote ? `: ${escapeHtml(opinionNote)}` : ''}</span>`;
    } else {
      syncLeaderField();
      banner.hidden = true;
    }
    switchTo('approvalView', mode === 'manager-final' ? 'Quyết định phiếu mượn (Quản lý phòng)' : 'Duyệt cho mượn (Quản lý phòng)');
  }

  function ensureApprovalBanner() {
    let banner = document.getElementById('workflowLeaderOpinion');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'workflowLeaderOpinion';
      banner.className = 'workflow-opinion-banner';
      approvalForm?.querySelector('h2')?.after(banner);
    }
    return banner;
  }

  async function submitApproval() {
    if (!window.KTHSRequireAuthentication?.()) return;
    const loan = currentLoan();
    const decision = document.querySelector('input[name="approvalDecision"]:checked')?.value;
    const note = document.getElementById('approvalNote')?.value.trim() || '';
    if (!loan || !decision) return notify('Vui lòng chọn ý kiến');

    let nextFilter = 'approval';
    let result;
    if (approvalMode === 'leader') {
      if (!['approve', 'reject'].includes(decision)) return notify('Vui lòng chọn ý kiến lãnh đạo');
      result = await sendCommand('leader_opinion', {
        loan,
        payload: { decision, note },
        success: 'Ý kiến đã được gửi về cán bộ quản lý'
      });
    } else if (decision === 'leader' && approvalMode === 'manager-review') {
      const leaderId = document.getElementById('approvalLeader')?.value;
      if (!leaderId) return notify('Vui lòng chọn lãnh đạo xin ý kiến');
      result = await sendCommand('request_leader', {
        loan,
        payload: { leaderId, note },
        success: `Đã gửi xin ý kiến ${user(leaderId).name}`
      });
    } else {
      if (!['approve', 'reject'].includes(decision)) return notify('Vui lòng chọn quyết định');
      result = await sendCommand('manager_decide', {
        loan,
        payload: { decision, note },
        success: decision === 'approve' ? 'Đã duyệt cho mượn' : 'Đã từ chối phiếu mượn'
      });
      nextFilter = decision === 'reject' ? 'rejected' : 'approval';
    }
    const nextLoan = result?.loan || currentLoan();
    showNextWorkflowStep(filterForLoan(nextLoan, nextFilter));
  }

  function equipmentImage(item = {}) {
    const candidate = item.image || item.photo || (item.imageUrl ? { url: item.imageUrl } : null);
    if (!candidate || typeof candidate !== 'object' || !candidate.url) return null;
    return {
      url: String(candidate.url),
      filename: String(candidate.filename || ''),
      contentType: String(candidate.contentType || ''),
      size: Number(candidate.size || 0),
      originalName: String(candidate.originalName || '')
    };
  }

  function imageRowAttributes(image) {
    if (!image) return '';
    return ` data-photo-url="${escapeHtml(image.url)}" data-photo-filename="${escapeHtml(image.filename)}" data-photo-content-type="${escapeHtml(image.contentType)}" data-photo-size="${image.size}" data-photo-original-name="${escapeHtml(image.originalName)}"`;
  }

  function photoControlMarkup(name, image = null, { readOnly = false } = {}) {
    if (readOnly) {
      if (!image) return '<span class="flow-photo-empty">Chưa có ảnh</span>';
      const label = `Xem ảnh ${name}`;
      return `<div class="flow-photo-control"><button class="photo-button has-photo view-only" type="button" data-workflow-action="view-photo" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"><img class="flow-photo-preview" src="${escapeHtml(image.url)}" alt="Ảnh ${escapeHtml(name)}"></button></div>`;
    }
    const content = image
      ? `<img class="flow-photo-preview" src="${escapeHtml(image.url)}" alt="Ảnh ${escapeHtml(name)}">`
      : '<span class="flow-photo-upload-icon" aria-hidden="true">↑</span>';
    const label = image ? `Thay ảnh ${name}` : `Tải ảnh ${name}`;
    return `<div class="flow-photo-control"><button class="photo-button${image ? ' has-photo' : ''}" type="button" data-workflow-action="photo" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${content}</button><input class="flow-photo-input" type="file" accept="image/jpeg,image/png,image/webp" tabindex="-1" aria-hidden="true" hidden></div>`;
  }

  function equipmentRows(loan, withControls, returnItems = null, hideCondition = false, photoReadOnly = false) {
    const items = returnItems || loanItems(loan);
    if (!items.length) return `<tr><td colspan="${hideCondition ? 3 : 4}">Không có phương tiện trong phiếu.</td></tr>`;
    return items.map((item) => {
      const id = itemId(item);
      const name = assetName(id, item);
      const condition = item.condition || item.status || 'Tốt';
      const image = equipmentImage(item);
      if (!withControls) {
        return `<tr data-asset-id="${escapeHtml(id)}"><td>${escapeHtml(name)}</td><td>${itemQuantity(item)}</td></tr>`;
      }
      const conditions = ['Tốt', 'Khá', 'Cần kiểm tra', 'Xước nhẹ', 'Hỏng'];
      const conditionCell = hideCondition ? '' : `<td><select class="condition-select return-condition" aria-label="Tình trạng ${escapeHtml(name)}">${conditions.map((value) => `<option${value === condition ? ' selected' : ''}>${value}</option>`).join('')}</select></td>`;
      return `<tr data-asset-id="${escapeHtml(id)}" data-quantity="${itemQuantity(item)}" data-condition="${escapeHtml(condition)}"${imageRowAttributes(image)}><td>${escapeHtml(name)}</td><td>${itemQuantity(item)}</td>${conditionCell}<td>${photoControlMarkup(name, image, { readOnly: photoReadOnly })}</td></tr>`;
    }).join('');
  }

  function rowImage(row) {
    const url = row?.dataset.photoUrl || '';
    if (!url) return null;
    return {
      url,
      filename: row.dataset.photoFilename || '',
      contentType: row.dataset.photoContentType || '',
      size: Number(row.dataset.photoSize || 0),
      originalName: row.dataset.photoOriginalName || ''
    };
  }

  function setRowImage(row, image) {
    row.dataset.photoUrl = image.url;
    row.dataset.photoFilename = image.filename || '';
    row.dataset.photoContentType = image.contentType || '';
    row.dataset.photoSize = String(Number(image.size || 0));
    row.dataset.photoOriginalName = image.originalName || '';
    const button = row.querySelector('.photo-button');
    if (!button) return;
    const name = assetName(row.dataset.assetId);
    button.classList.add('has-photo');
    button.innerHTML = `<img class="flow-photo-preview" src="${escapeHtml(image.url)}" alt="Ảnh ${escapeHtml(name)}">`;
    button.title = `Thay ảnh ${name}`;
    button.setAttribute('aria-label', `Thay ảnh ${name}`);
  }

  function photoInputFor(button) {
    const cell = button.closest('td');
    if (!cell) return null;
    let input = cell.querySelector('.flow-photo-input');
    if (!input) {
      input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/jpeg,image/png,image/webp';
      input.className = 'flow-photo-input';
      input.tabIndex = -1;
      input.setAttribute('aria-hidden', 'true');
      input.hidden = true;
      cell.appendChild(input);
    }
    return input;
  }

  function chooseFlowPhoto(button) {
    const input = photoInputFor(button);
    if (!input) return;
    input.value = '';
    input.click();
  }

  function ensureFlowPhotoViewer() {
    let dialog = document.getElementById('flowPhotoViewer');
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = 'flowPhotoViewer';
    dialog.className = 'flow-photo-viewer';
    dialog.setAttribute('aria-labelledby', 'flowPhotoViewerTitle');
    dialog.innerHTML = `<header><h2 id="flowPhotoViewerTitle">Ảnh phương tiện trả</h2><button type="button" data-workflow-action="close-photo-viewer" aria-label="Đóng">×</button></header><div class="flow-photo-viewer-body"><img alt=""><p></p></div>`;
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener('close', () => {
      const image = dialog.querySelector('img');
      if (image) image.removeAttribute('src');
    });
    document.body.appendChild(dialog);
    return dialog;
  }

  function openFlowPhotoViewer(button) {
    const row = button.closest('tr');
    const imageData = rowImage(row);
    if (!imageData?.url) return notify('Phương tiện này chưa có ảnh khi trả');
    const dialog = ensureFlowPhotoViewer();
    const name = assetName(row?.dataset.assetId) || row?.cells?.[0]?.textContent?.trim() || 'Phương tiện';
    const image = dialog.querySelector('img');
    const caption = dialog.querySelector('p');
    if (image) {
      image.src = imageData.url;
      image.alt = `Ảnh ${name}`;
    }
    if (caption) caption.textContent = name;
    if (!dialog.open) dialog.showModal();
  }

  async function uploadFlowPhoto(input) {
    const file = input.files?.[0];
    const row = input.closest('tr');
    const button = row?.querySelector('.photo-button');
    if (!file || !row || !button) return;
    if (!FLOW_IMAGE_TYPES.has(file.type)) {
      notify('Chỉ hỗ trợ ảnh JPG, PNG hoặc WebP');
      input.value = '';
      return;
    }
    if (file.size > MAX_FLOW_IMAGE_BYTES) {
      notify('Ảnh không được vượt quá 5 MB');
      input.value = '';
      return;
    }
    row.dataset.photoUploading = 'true';
    button.disabled = true;
    button.classList.add('is-uploading');
    button.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch(API_UPLOADS, {
        method: 'POST',
        headers: await authenticatedHeaders({
          'Content-Type': file.type,
          'X-File-Name': encodeURIComponent(file.name)
        }),
        body: file
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.upload?.url) {
        throw new Error(result.message || 'Không thể tải ảnh lên máy chủ');
      }
      setRowImage(row, result.upload);
      notify('Đã tải ảnh và gắn vào phương tiện');
    } catch (error) {
      notify(error.message || 'Không thể tải ảnh lên máy chủ');
    } finally {
      delete row.dataset.photoUploading;
      button.classList.remove('is-uploading');
      button.removeAttribute('aria-busy');
      button.disabled = connectionKind !== 'online' || commandInFlight;
      input.value = '';
    }
  }

  function hasPendingPhotoUploads(bodyId) {
    return Boolean(document.querySelector(`#${bodyId} tr[data-photo-uploading="true"]`));
  }

  function populatePersonSelect(select, selectedKey) {
    if (!select) return;
    select.innerHTML = Object.entries(staffMap()).map(([key, entry]) => `<option value="${escapeHtml(key)}"${key === selectedKey ? ' selected' : ''}>${escapeHtml(entry.name)}</option>`).join('');
  }

  function openHandoff(loan, origin = null) {
    selectedLoanId = loanId(loan);
    rememberWorkflowOrigin(origin);
    const code = document.getElementById('handoffCode');
    if (code) {
      code.textContent = loanCode(loan);
      code.dataset.loanId = loanId(loan);
    }
    const recipient = document.getElementById('handoffRecipient');
    populatePersonSelect(recipient, borrowerKey(loan));
    if (recipient) recipient.disabled = true;
    const room = document.getElementById('handoffRoom');
    if (room) room.value = loan.room || room.value;
    const date = document.getElementById('handoffDate');
    if (date) date.value = localIsoDate();
    const body = document.getElementById('handoffEquipmentBody');
    if (body) body.innerHTML = equipmentRows(loan, true);
    switchTo('handoffView', 'Xác nhận giao phòng và phương tiện');
  }

  function collectFlowEquipment(bodyId) {
    return [...document.querySelectorAll(`#${bodyId} tr`)].map((row) => {
      const assetId = row.dataset.assetId || '';
      const image = rowImage(row);
      const item = {
        assetId,
        quantity: Number(row.dataset.quantity || row.cells[1]?.textContent.trim() || 1),
        condition: row.querySelector('select.condition-select, select.return-condition')?.value || row.dataset.condition || 'Tốt'
      };
      if (image) item.image = image;
      return item;
    }).filter((item) => item.assetId);
  }

  async function confirmHandoff() {
    if (!window.KTHSRequireAuthentication?.()) return;
    const loan = currentLoan();
    if (!loan) return;
    if (hasPendingPhotoUploads('handoffEquipmentBody')) return notify('Vui lòng chờ ảnh tải xong trước khi xác nhận giao');
    const recipientId = borrowerKey(loan);
    const recipient = document.getElementById('handoffRecipient');
    if (recipient && recipient.value !== recipientId) populatePersonSelect(recipient, recipientId);
    const room = document.getElementById('handoffRoom')?.value;
    const date = document.getElementById('handoffDate')?.value;
    const time = document.getElementById('handoffTime')?.value;
    if (!recipientId || !room || !date) return notify('Vui lòng nhập đủ người nhận, phòng và ngày giao');
    const result = await sendCommand('confirm_handoff', {
      loan,
      payload: {
        recipientId, room, date, time,
        note: document.getElementById('handoffNote')?.value.trim() || '',
        equipment: collectFlowEquipment('handoffEquipmentBody')
      },
      success: 'Đã xác nhận giao phòng và phương tiện'
    });
    showNextWorkflowStep(filterForLoan(result.loan, 'borrowing'));
  }

  function returnSubmission(loan) {
    return loan.returnRequest || loan.returnInfo || latestEvent(loan, 'request_return')?.payload || {};
  }

  function openReturn(loan, mode) {
    selectedLoanId = loanId(loan);
    returnMode = mode;
    rememberWorkflowOrigin();
    const submitted = returnSubmission(loan);
    const code = document.getElementById('returnCode');
    if (code) {
      code.textContent = loanCode(loan);
      code.dataset.loanId = loanId(loan);
    }
    const returnBorrower = document.getElementById('returnBorrower');
    populatePersonSelect(returnBorrower, borrowerKey(loan));
    if (returnBorrower) returnBorrower.disabled = true;
    const room = document.getElementById('returnRoom');
    if (room) room.value = submitted.room || loan.room || room.value;
    const date = document.getElementById('returnDate');
    if (date) date.value = dateValue(submitted.date, localIsoDate());
    const time = document.getElementById('returnTime');
    if (time) time.value = submitted.time || new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const managerConfirming = mode === 'manager-confirm';
    const bottomPanel = document.querySelector('#returnView .return-bottom-panel');
    const teacherNoteField = document.getElementById('returnTeacherNoteField');
    const managerNotes = document.getElementById('returnManagerNotes');
    if (bottomPanel) bottomPanel.classList.toggle('manager-confirm-mode', managerConfirming);
    if (teacherNoteField) teacherNoteField.hidden = managerConfirming;
    if (managerNotes) managerNotes.hidden = !managerConfirming;
    const noteLabel = document.getElementById('returnNoteLabel');
    if (noteLabel) noteLabel.textContent = 'GV ghi nhận tình trạng (nếu có)';
    const note = document.getElementById('returnNote');
    if (note) {
      note.value = managerConfirming ? '' : (submitted.note || '');
      note.placeholder = 'Nhập tình trạng phương tiện...';
    }
    const managerNote = document.getElementById('returnManagerNote');
    if (managerNote) managerNote.value = managerConfirming
      ? (loan.returnConfirmation?.managerNote ?? loan.returnConfirmation?.note ?? '')
      : '';
    const generalNote = document.getElementById('returnGeneralNote');
    if (generalNote) generalNote.value = managerConfirming ? (loan.returnConfirmation?.generalNote || '') : '';
    const items = submitted.equipment?.length ? submitted.equipment : loanItems(loan);
    const body = document.getElementById('returnEquipmentBody');
    if (body) {
      body.dataset.readOnly = String(managerConfirming);
      body.innerHTML = equipmentRows(loan, true, items, true, managerConfirming);
    }
    const addEquipment = document.getElementById('addReturnEquipment');
    if (addEquipment) {
      addEquipment.hidden = managerConfirming;
      addEquipment.disabled = managerConfirming;
    }
    const submit = document.getElementById('confirmReturn');
    if (submit) submit.textContent = mode === 'manager-confirm' ? 'Xác nhận đã trả' : 'Xác nhận trả';
    switchTo('returnView', mode === 'manager-confirm' ? 'Xác nhận đã trả phòng và phương tiện' : 'Trả phòng và phương tiện');
  }

  async function submitReturn() {
    if (!window.KTHSRequireAuthentication?.()) return;
    const loan = currentLoan();
    if (!loan) return;
    if (hasPendingPhotoUploads('returnEquipmentBody')) return notify('Vui lòng chờ ảnh tải xong trước khi xác nhận trả');
    const managerConfirming = returnMode === 'manager-confirm';
    let result;
    if (managerConfirming) {
      const managerNote = document.getElementById('returnManagerNote')?.value.trim() || '';
      const generalNote = document.getElementById('returnGeneralNote')?.value.trim() || '';
      result = await sendCommand('confirm_return', {
        loan,
        payload: {
          note: managerNote,
          managerNote,
          generalNote,
          equipment: collectFlowEquipment('returnEquipmentBody')
        },
        success: 'Đã xác nhận người sử dụng hoàn trả đầy đủ'
      });
    } else {
      const date = document.getElementById('returnDate')?.value;
      if (!date) return notify('Vui lòng chọn ngày trả');
      result = await sendCommand('request_return', {
        loan,
        payload: {
          date,
          time: document.getElementById('returnTime')?.value || '',
          room: document.getElementById('returnRoom')?.value || loan.room || '',
          note: document.getElementById('returnNote')?.value.trim() || '',
          equipment: collectFlowEquipment('returnEquipmentBody')
        },
        success: 'Đã gửi thông tin trả đến cán bộ quản lý'
      });
    }
    showNextWorkflowStep(filterForLoan(result?.loan, managerConfirming ? 'returned' : 'borrowing'));
  }

  function eventLoanId(event) {
    return String(event.loanId || event.entityId || event.payload?.loanId || '');
  }

  function eventActor(event) {
    return event.actorKey || event.actorId || event.userId || event.payload?.actorKey;
  }

  function detailFact(label, value, { wide = false } = {}) {
    const copy = String(value ?? '').trim();
    if (!copy) return '';
    return `<div${wide ? ' class="wide"' : ''}><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(copy)}</dd></div>`;
  }

  function detailDateTime(date, time = '') {
    return [formatDate(date), String(time || '').trim().slice(0, 5)].filter(Boolean).join(' · ');
  }

  function detailImage(item) {
    const image = equipmentImage(item);
    if (!image || !/^\/uploads\/[a-z0-9._-]+$/i.test(image.url)) return '';
    return `<a class="workflow-ticket-photo" href="${escapeHtml(image.url)}" target="_blank" rel="noopener" title="Mở ảnh phương tiện"><img src="${escapeHtml(image.url)}" alt="Ảnh ${escapeHtml(assetName(itemId(item), item))}"></a>`;
  }

  function detailEquipment(title, items, { showCondition = false } = {}) {
    const rows = Array.isArray(items) ? items : [];
    if (!rows.length) return '';
    const hasPhoto = rows.some((item) => detailImage(item));
    return `<section class="workflow-ticket-section"><h3>${escapeHtml(title)}</h3><div class="workflow-ticket-table-wrap"><table class="workflow-ticket-table"><thead><tr><th>Phương tiện</th><th>SL</th>${showCondition ? '<th>Tình trạng</th>' : ''}${hasPhoto ? '<th>Ảnh</th>' : ''}</tr></thead><tbody>${rows.map((item) => {
      const condition = item.condition || item.status || 'Chưa ghi nhận';
      const note = String(item.note || '').trim();
      return `<tr><td><strong>${escapeHtml(assetName(itemId(item), item))}</strong>${note ? `<small>${escapeHtml(note)}</small>` : ''}</td><td>${itemQuantity(item)}</td>${showCondition ? `<td>${escapeHtml(condition)}</td>` : ''}${hasPhoto ? `<td>${detailImage(item) || '—'}</td>` : ''}</tr>`;
    }).join('')}</tbody></table></div></section>`;
  }

  function ticketDetailMarkup(loan) {
    const shownStatus = displayStatus(loan);
    const meta = statusMeta[shownStatus] || { label: shownStatus, css: 'neutral' };
    const leaderId = assignedLeader(loan);
    const leaderOpinion = latestEvent(loan, 'leader_opinion');
    const leaderDecision = eventDecision(leaderOpinion);
    const managerDecision = loan.managerDecision || eventDecision(latestEvent(loan, 'manager_decide'));
    const handoff = loan.handoff || {};
    const returnRequest = loan.returnRequest || {};
    const returnConfirmation = loan.returnConfirmation || {};
    const approvalSummary = [
      leaderId ? `Xin ý kiến: ${user(leaderId).name}` : '',
      leaderDecision ? `Ý kiến lãnh đạo: ${leaderDecision === 'approve' ? 'Đồng ý' : 'Không đồng ý'}` : '',
      managerDecision ? `Quyết định của cán bộ quản lý: ${managerDecision === 'approve' ? 'Đồng ý cho mượn' : 'Từ chối'}` : ''
    ].filter(Boolean).join(' · ');
    const stageCards = [
      handoff.confirmedAt ? `<article><h3>Thông tin giao</h3><dl>${detailFact('Người nhận', handoff.recipientName || borrowerName(loan))}${detailFact('Phòng', handoff.room || loan.room)}${detailFact('Thời gian', detailDateTime(handoff.date, handoff.time))}${detailFact('Xác nhận lúc', formatTimestamp(handoff.confirmedAt))}${detailFact('Ghi chú', handoff.note, { wide: true })}</dl></article>` : '',
      returnRequest.requestedAt ? `<article><h3>Thông tin trả</h3><dl>${detailFact('Người trả', returnRequest.returnedByName || borrowerName(loan))}${detailFact('Phòng', returnRequest.room || loan.room)}${detailFact('Thời gian', detailDateTime(returnRequest.date, returnRequest.time))}${detailFact('Gửi lúc', formatTimestamp(returnRequest.requestedAt))}${detailFact('GV ghi nhận tình trạng', returnRequest.note, { wide: true })}</dl></article>` : '',
      returnConfirmation.confirmedAt ? `<article><h3>Xác nhận đã trả</h3><dl>${detailFact('Cán bộ xác nhận', user(returnConfirmation.confirmedBy).name)}${detailFact('Xác nhận lúc', formatTimestamp(returnConfirmation.confirmedAt))}${detailFact('CBQL kiểm tra, ghi nhận', returnConfirmation.managerNote ?? returnConfirmation.note, { wide: true })}${detailFact('Ghi chú', returnConfirmation.generalNote, { wide: true })}</dl></article>` : ''
    ].filter(Boolean).join('');
    return `<div class="workflow-ticket-status"><span class="status ${escapeHtml(meta.css)}">${escapeHtml(meta.label)}</span></div>
      <dl class="workflow-ticket-facts">
        ${detailFact('Người mượn', borrowerName(loan))}
        ${detailFact('Phòng thực hành', loan.room)}
        ${detailFact('Ngày mượn', formatDate(loan.borrowDate))}
        ${detailFact('Ngày trả dự kiến', formatDate(loan.expectedReturnDate))}
        ${detailFact('Mục đích mượn', loan.purpose, { wide: true })}
        ${detailFact('Ghi chú đăng ký', loan.note, { wide: true })}
        ${detailFact('Quá trình duyệt', approvalSummary, { wide: true })}
      </dl>
      ${detailEquipment('Phương tiện đăng ký', loanItems(loan))}
      ${stageCards ? `<section class="workflow-ticket-stages">${stageCards}</section>` : ''}
      ${handoff.equipment?.length ? detailEquipment('Phương tiện đã giao', handoff.equipment, { showCondition: true }) : ''}
      ${returnRequest.equipment?.length ? detailEquipment('Phương tiện người dùng gửi trả', returnRequest.equipment, { showCondition: true }) : ''}
      ${returnConfirmation.equipment?.length ? detailEquipment('Phương tiện cán bộ quản lý xác nhận', returnConfirmation.equipment, { showCondition: true }) : ''}`;
  }

  function openAudit(loan = null) {
    const dialog = ensureAuditDialog();
    const body = dialog.querySelector('.workflow-audit-body');
    const previousScroll = dialog.open ? body?.scrollTop || 0 : 0;
    const pendingNotifications = loan ? [] : unreadNotifications();
    if (!loan && pendingNotifications.length) markNotificationsRead(pendingNotifications.map((item) => item.loan));
    const notificationLoanIds = new Set(notificationScopeLoans().map((item) => loanId(item)));
    const knownLoan = loan && state.loans.some((item) => loanId(item) === loanId(loan));
    if (loan && !knownLoan) {
      notify('Không tìm thấy thông tin phiếu');
      return;
    }
    const events = loan
      ? state.events.filter((event) => eventLoanId(event) === loanId(loan))
      : state.events.filter((event) => notificationLoanIds.has(eventLoanId(event))).slice(-20);
    const detail = dialog.querySelector('.workflow-ticket-detail');
    if (detail) {
      detail.hidden = !loan;
      detail.innerHTML = loan ? ticketDetailMarkup(loan) : '';
    }
    const eyebrow = dialog.querySelector('.workflow-audit-eyebrow');
    if (eyebrow) eyebrow.textContent = loan ? 'HỒ SƠ MƯỢN - TRẢ' : 'NHẬT KÝ HỆ THỐNG';
    dialog.querySelector('.workflow-audit-title').textContent = loan
      ? `Thông tin phiếu · ${loanCode(loan)}` : 'Thông báo và lịch sử gần đây';
    const timelineTitle = dialog.querySelector('.workflow-audit-section h3');
    if (timelineTitle) timelineTitle.textContent = loan ? 'Lịch sử xử lý' : 'Hoạt động gần đây';
    const notificationSection = dialog.querySelector('.workflow-notification-section');
    const notificationList = dialog.querySelector('.workflow-notification-list');
    if (notificationSection && notificationList) {
      notificationSection.hidden = loan || pendingNotifications.length === 0;
      notificationList.innerHTML = pendingNotifications.map(({ loan: itemLoan, action }) => `<li><button class="workflow-code" type="button" data-workflow-action="details" data-loan-id="${escapeHtml(loanId(itemLoan))}">${escapeHtml(loanCode(itemLoan))}</button><span>${escapeHtml(notificationLabel(action))}</span><small>${escapeHtml(borrowerName(itemLoan))}</small></li>`).join('');
    }
    const list = dialog.querySelector('.workflow-audit-list');
    list.innerHTML = events.length ? [...events].reverse().map((event) => {
      const type = event.type || event.action || 'event';
      const decision = eventDecision(event);
      const note = event.details?.note || event.payload?.note || event.note || '';
      const generalNote = event.details?.generalNote || event.payload?.generalNote || '';
      return `<li><span class="workflow-audit-dot"></span><div><strong>${escapeHtml(eventLabels[type] || type)}</strong><small>${escapeHtml(user(eventActor(event)).name)} · ${escapeHtml(formatTimestamp(event.timestamp || event.createdAt || event.at))}</small>${decision ? `<p>Ý kiến: <b>${decision === 'approve' ? 'Đồng ý' : 'Không đồng ý'}</b></p>` : ''}${note ? `<p>${escapeHtml(note)}</p>` : ''}${generalNote ? `<p>Ghi chú: ${escapeHtml(generalNote)}</p>` : ''}</div></li>`;
    }).join('') : '<li class="workflow-empty-audit">Chưa có sự kiện được ghi nhận.</li>';
    if (loan) dialog.dataset.loanId = loanId(loan);
    else delete dialog.dataset.loanId;
    if (!dialog.open) dialog.showModal();
    if (body) body.scrollTop = previousScroll;
  }

  function ensureAuditDialog() {
    let dialog = document.getElementById('workflowAuditDialog');
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = 'workflowAuditDialog';
    dialog.className = 'workflow-audit-dialog';
    dialog.setAttribute('aria-labelledby', 'workflowAuditTitle');
    dialog.innerHTML = `<header><div><span class="workflow-audit-eyebrow">NHẬT KÝ HỆ THỐNG</span><h2 class="workflow-audit-title" id="workflowAuditTitle">Lịch sử xác nhận</h2></div><button type="button" data-workflow-action="close-audit" aria-label="Đóng">×</button></header><div class="workflow-audit-body"><section class="workflow-ticket-detail" hidden></section><section class="workflow-notification-section" hidden><h3>Thông báo chưa xem</h3><ul class="workflow-notification-list"></ul></section><section class="workflow-audit-section"><h3>Hoạt động gần đây</h3><ol class="workflow-audit-list"></ol></section></div>`;
    document.body.appendChild(dialog);
    return dialog;
  }

  function handleAction(button) {
    const action = button.dataset.workflowAction;
    if (action === 'back') return goBackWorkflow();
    const loan = state.loans.find((item) => loanId(item) === button.dataset.loanId);
    if (action === 'details') return loan ? openAudit(loan) : notify('Không tìm thấy thông tin phiếu');
    if (action === 'close-audit') {
      const dialog = button.closest('dialog');
      if (dialog) delete dialog.dataset.loanId;
      return dialog?.close();
    }
    if (action === 'view-photo') return openFlowPhotoViewer(button);
    if (action === 'close-photo-viewer') return button.closest('dialog')?.close();
    if (!window.KTHSRequireAuthentication?.()) return;
    if (connectionKind !== 'online') return notify('Chưa kết nối máy chủ. Thao tác đang tạm khóa');
    if (action === 'photo') return chooseFlowPhoto(button);
    if (!loan) return;
    const currentRole = role();
    const status = loanStatus(loan);
    const authorized = (action === 'approve' && currentRole === 'manager' && status === 'pending_manager')
      || (action === 'manager-decision' && currentRole === 'manager' && status === 'leader_opinion_returned')
      || (action === 'leader-opinion' && currentRole === 'approver' && status === 'pending_leader' && assignedLeader(loan) === actorKey)
      || (action === 'handoff' && currentRole === 'manager' && status === 'approved')
      || (action === 'return-request' && status === 'borrowing' && borrowerKey(loan) === actorKey)
      || (action === 'return-confirm' && currentRole === 'manager' && status === 'return_pending');
    if (!authorized) return notify('Bạn không có quyền thực hiện thao tác này hoặc phiếu đã chuyển sang bước khác');
    if (action === 'approve') return openApproval(loan, 'manager-review');
    if (action === 'manager-decision') return openApproval(loan, 'manager-final');
    if (action === 'leader-opinion') return openApproval(loan, 'leader');
    if (action === 'handoff') return openHandoff(loan);
    if (action === 'return-request') return openReturn(loan, 'request');
    if (action === 'return-confirm') return openReturn(loan, 'manager-confirm');
  }

  function updateActor(nextActor) {
    if (!sourceStaff[nextActor] && !staffMap()[nextActor]) return;
    actorKey = nextActor;
    selectedLoanId = null;
    approvalMode = null;
    returnMode = null;
    workflowOrigin = null;
    activeFilter = 'all';
    document.querySelectorAll('.borrow-status-filter').forEach((item) => {
      item.classList.toggle('active', item.dataset.statusFilter === 'all');
    });
    renderLoanTable();
    updateNotificationCount();
    updateRoleHint();
    const current = views.find((view) => !view.classList.contains('view-hidden'));
    if (['approvalView', 'handoffView', 'returnView', 'createBorrowView'].includes(current?.id)) {
      switchTo('borrowView', 'Quản lý Mượn - Trả');
    }
  }

  function installEventGuards() {
    window.addEventListener('kths:userchange', (event) => updateActor(event.detail?.key));
    document.addEventListener('submit', (event) => {
      if (event.target === borrowForm) {
        event.preventDefault();
        event.stopImmediatePropagation();
        submitBorrow().catch(() => {});
      } else if (event.target === approvalForm) {
        event.preventDefault();
        event.stopImmediatePropagation();
        submitApproval().catch(() => {});
      }
    }, true);

    document.addEventListener('click', (event) => {
      const cancelControl = event.target.closest('#cancelBorrow, #cancelApproval, #cancelReturn');
      if (cancelControl) {
        event.preventDefault();
        event.stopImmediatePropagation();
        goBackWorkflow();
        return;
      }

      const workflowButton = event.target.closest('[data-workflow-action]');
      if (workflowButton) {
        event.preventDefault();
        event.stopImmediatePropagation();
        handleAction(workflowButton);
        return;
      }

      const profileOption = event.target.closest('.profile-user-select[data-user-key]');
      if (profileOption) setTimeout(() => updateActor(profileOption.dataset.userKey), 0);

      const filter = event.target.closest('.borrow-status-filter');
      if (filter) {
        event.preventDefault();
        event.stopImmediatePropagation();
        activeFilter = filter.dataset.statusFilter || 'all';
        document.querySelectorAll('.borrow-status-filter').forEach((item) => {
          item.classList.toggle('active', item === filter);
        });
        setTimeout(() => {
          renderLoanTable();
          const tableScroll = document.querySelector('.borrow-table-scroll');
          if (tableScroll) tableScroll.scrollTop = 0;
        }, 0);
        return;
      }

      if (event.target.matches('input[name="approvalDecision"]')) syncLeaderField();

      if (event.target.closest('#createBorrow')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!window.KTHSRequireAuthentication?.()) return;
        rememberWorkflowOrigin();
        window.KTHSResetBorrowEquipmentSelection?.();
        switchTo('createBorrowView', 'Tạo phiếu mượn');
        setTimeout(resetBorrowFormDates, 0);
        return;
      }

      if (event.target.closest('#confirmHandoff')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        confirmHandoff().catch(() => {});
      }

      if (event.target.closest('#confirmReturn')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        submitReturn().catch(() => {});
      }

      if (event.target.closest('#notificationButton')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        openAudit();
      }
    }, true);

    document.addEventListener('change', (event) => {
      if (!event.target.matches('.flow-photo-input')) return;
      uploadFlowPhoto(event.target).catch(() => {});
    }, true);
  }

  function installUi() {
    const filters = document.querySelector('.borrow-status-filters');
    if (filters && !filters.querySelector('[data-status-filter="rejected"]')) {
      filters.insertAdjacentHTML('beforeend', '<button class="borrow-status-filter" type="button" data-status-filter="rejected">Đã từ chối</button>');
    }
    installStyles();
    ensureAuditDialog();
    updateRoleHint();
    window.addEventListener('kths:authchange', updateActionAvailability);
  }

  function updateRoleHint() {
    const hint = document.getElementById('workflowRoleHint');
    if (!hint) return;
    const labels = {
      teacher: 'Xem toàn bộ · chỉ mượn - trả phiếu của mình',
      manager: 'Xem toàn bộ · quản lý duyệt và quản trị',
      approver: 'Xem toàn bộ · cho ý kiến khi Huấn gửi đích danh'
    };
    hint.textContent = labels[role()] || '';
  }

  function updateActualDates() {
    const today = localIsoDate();
    const picker = document.getElementById('topbarDatePicker');
    if (picker) picker.value = today;
    const label = document.getElementById('topbarDateText');
    if (label) {
      const date = new Date(`${today}T12:00:00`);
      label.textContent = new Intl.DateTimeFormat('vi-VN', {
        weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric'
      }).format(date);
    }
    resetBorrowFormDates();
  }

  function installStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .workflow-code{border:0;padding:0;background:transparent;color:#0670ef;font:inherit;font-weight:700;cursor:pointer}
      .workflow-opinion-banner{display:grid;gap:4px;margin:0 0 17px;padding:12px 14px;border-left:3px solid #0c8f67;border-radius:4px;background:#eef9f5;color:#254c41}
      .workflow-opinion-banner strong{font-size:13px}.workflow-opinion-banner span{font-size:12px}
      .workflow-audit-dialog{width:min(920px,calc(100vw - 32px));max-height:min(820px,calc(100vh - 32px));padding:0;overflow:hidden;border:0;border-radius:7px;color:#183047;box-shadow:0 24px 70px rgba(7,37,47,.25)}
      .workflow-audit-dialog::backdrop{background:rgba(8,31,40,.42)}
      .workflow-audit-dialog header{position:sticky;top:0;z-index:1;display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid #e5ecef;background:#fff}
      .workflow-audit-dialog header span{display:block;margin-bottom:3px;color:#78909d;font-size:10px;font-weight:800}.workflow-audit-dialog h2{margin:0;font-size:20px}.workflow-audit-dialog header button{width:34px;height:34px;border:1px solid #dce5e9;border-radius:4px;background:#fff;font-size:23px;line-height:1;cursor:pointer}
      .workflow-audit-body{max-height:calc(100vh - 116px);overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}
      .workflow-ticket-detail{display:grid;gap:18px;padding:20px}.workflow-ticket-detail[hidden]{display:none}.workflow-ticket-status{display:flex;align-items:center;justify-content:flex-end;margin-bottom:-4px}.workflow-ticket-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0;margin:0;border:1px solid #e4ebef;border-radius:6px;overflow:hidden}.workflow-ticket-facts>div{display:grid;grid-template-columns:130px minmax(0,1fr);gap:10px;padding:11px 13px;border-bottom:1px solid #edf1f3}.workflow-ticket-facts>div:nth-child(odd):not(.wide){border-right:1px solid #edf1f3}.workflow-ticket-facts>div.wide{grid-column:1/-1}.workflow-ticket-facts>div:last-child{border-bottom:0}.workflow-ticket-facts dt{color:#718391;font-size:12px}.workflow-ticket-facts dd{margin:0;color:#203a4f;font-size:13px;font-weight:600;overflow-wrap:anywhere}
      .workflow-ticket-section{display:grid;gap:9px}.workflow-ticket-section h3,.workflow-ticket-stages h3,.workflow-audit-section>h3{margin:0;color:#20384b;font-size:14px}.workflow-ticket-table-wrap{overflow-x:auto;border:1px solid #e4ebef;border-radius:6px}.workflow-ticket-table{width:100%;min-width:560px;border-collapse:collapse;table-layout:fixed}.workflow-ticket-table th,.workflow-ticket-table td{padding:10px 12px;border-bottom:1px solid #edf1f3;text-align:left;font-size:12px;vertical-align:middle}.workflow-ticket-table th{background:#f5f8f9;color:#2d4658;font-weight:700}.workflow-ticket-table tr:last-child td{border-bottom:0}.workflow-ticket-table th:nth-child(2),.workflow-ticket-table td:nth-child(2){width:54px;text-align:center}.workflow-ticket-table th:nth-child(3),.workflow-ticket-table td:nth-child(3){width:120px}.workflow-ticket-table th:nth-child(4),.workflow-ticket-table td:nth-child(4){width:70px;text-align:center}.workflow-ticket-table td strong{display:block;color:#203a4f}.workflow-ticket-table td small{display:block;margin-top:3px;color:#758795}.workflow-ticket-photo{display:inline-grid;width:38px;height:38px;overflow:hidden;border:1px solid #cddce3;border-radius:4px;background:#f5f8fa}.workflow-ticket-photo img{width:100%;height:100%;object-fit:cover}
      .workflow-ticket-stages{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}.workflow-ticket-stages article{padding:14px;border:1px solid #e4ebef;border-radius:6px;background:#fbfcfd}.workflow-ticket-stages dl{display:grid;gap:8px;margin:11px 0 0}.workflow-ticket-stages dl>div{display:grid;grid-template-columns:92px minmax(0,1fr);gap:8px}.workflow-ticket-stages dl>div.wide{grid-template-columns:1fr}.workflow-ticket-stages dt{color:#748795;font-size:11px}.workflow-ticket-stages dd{margin:0;color:#294456;font-size:12px;font-weight:600;overflow-wrap:anywhere}
      .workflow-notification-section{padding:16px 20px 0;border-top:1px solid #e5ecef;background:#fff}.workflow-notification-section h3{margin:0;color:#20384b;font-size:14px}.workflow-notification-list{display:grid;gap:0;margin:8px 0 0;padding:0;list-style:none}.workflow-notification-list li{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid #edf1f3}.workflow-notification-list li:last-child{border-bottom:0}.workflow-notification-list li span{color:#27485d;font-size:12px;font-weight:700}.workflow-notification-list li small{color:#728594;font-size:11px;text-align:right}.workflow-audit-section{padding:18px 20px 8px;border-top:1px solid #e5ecef;background:#fbfcfd}.workflow-audit-list{display:grid;gap:0;margin:8px 0 0;padding:0;list-style:none}.workflow-audit-list li{display:grid;grid-template-columns:18px 1fr;gap:10px;padding:14px 0;border-bottom:1px solid #edf1f3}.workflow-audit-list li:last-child{border-bottom:0}.workflow-audit-dot{width:10px;height:10px;margin-top:5px;border-radius:50%;background:#087f67;box-shadow:0 0 0 4px #e3f4ef}.workflow-audit-list div{display:grid;gap:3px}.workflow-audit-list strong{font-size:13px}.workflow-audit-list small{color:#728594;font-size:11px}.workflow-audit-list p{margin:3px 0 0;color:#435d70;font-size:12px}.workflow-empty-audit{display:block!important;color:#718391;text-align:center}
      @media(max-width:650px){.workflow-audit-dialog{width:calc(100vw - 18px);max-height:calc(100vh - 18px)}.workflow-audit-dialog header{padding:14px}.workflow-audit-dialog h2{font-size:17px}.workflow-audit-body{max-height:calc(100vh - 92px)}.workflow-ticket-detail{gap:14px;padding:14px}.workflow-ticket-facts{grid-template-columns:1fr}.workflow-ticket-facts>div,.workflow-ticket-facts>div.wide{grid-column:1;grid-template-columns:116px minmax(0,1fr);border-right:0!important}.workflow-ticket-table{min-width:480px}.workflow-ticket-stages{grid-template-columns:1fr}.workflow-audit-section{padding:16px 14px 6px}}
      .status.return-pending{background:#fff1da;color:#b96800}
    `;
    document.head.appendChild(style);
  }

  function init() {
    installUi();
    installEventGuards();
    updateActualDates();
    updateRoleControls();
    const startOnline = async () => {
      if (window.KTHSAuth) {
        await window.KTHSAuth.ready();
        if (!window.KTHSAuth.isAuthenticated()) {
          setConnection('offline', 'Cần đăng nhập');
          return;
        }
      }
      await loadState();
      connectEvents();
    };
    startOnline();
    pollTimer = setInterval(() => {
      const realtimeReady = NETLIFY_POLLING
        ? window.KTHSAuth?.isRealtimeConnected?.() === true
        : eventSource?.readyState === EventSource.OPEN;
      if (document.visibilityState === 'visible'
        && (!window.KTHSAuth || window.KTHSAuth.isAuthenticated())
        && !realtimeReady) loadState({ quiet: true });
    }, 60000);
    window.addEventListener('kths:authchange', () => {
      if (window.KTHSIsAuthenticated?.() === true) startOnline();
      else {
        realtimeUnsubscribe?.();
        realtimeUnsubscribe = null;
        eventSource?.close();
        setConnection('offline', 'Cần đăng nhập');
      }
    });
    window.addEventListener('kths:realtime-status', (event) => {
      if (!window.KTHSAuth?.isAuthenticated()) return;
      setConnection(event.detail?.status === 'connected' ? 'online' : 'syncing',
        event.detail?.status === 'connected' ? 'Supabase Realtime' : 'Đang kết nối lại');
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && (!window.KTHSAuth || window.KTHSAuth.isAuthenticated())) loadState({ quiet: true });
    });
  }

  window.KTHSWorkflow = {
    getState: () => state,
    getActor: () => actorKey,
    refresh: () => loadState(),
    command: (type, options) => sendCommand(type, options),
    destroy() {
      eventSource?.close();
      realtimeUnsubscribe?.();
      clearTimeout(reconnectTimer);
      clearInterval(pollTimer);
    }
  };

  init();
})();
