const staff = [
  { key: 'teacher', name: 'Giáo viên đăng ký', title: 'GV', role: 'teacher' },
  { key: 'thuong', name: 'Nguyễn Tấn Thương', title: 'PTK', role: 'approver' },
  { key: 'cong', name: 'Lê Văn Công', title: 'PTK', role: 'approver' },
  { key: 'tot', name: 'Nguyễn Tốt', title: 'PTK', role: 'teacher' },
  { key: 'thanh', name: 'Đậu Trung Thành', title: 'PTK', role: 'teacher' },
  { key: 'huan', name: 'Trần Xuân Huấn', title: 'Cán bộ quản lý', role: 'manager' },
  { key: 'be', name: 'Nguyễn Văn Bé', title: 'GV', role: 'teacher' },
  { key: 'quan', name: 'Phạm Minh Quân', title: 'GV', role: 'teacher' }
];

const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const password = String(process.env.KTHS_DEFAULT_PASSWORD || '3103');
const domain = String(process.env.KTHS_AUTH_EMAIL_DOMAIN || 'kths.local').trim() || 'kths.local';

if (!url || !serviceKey) {
  console.error('Thiếu SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
  }
  return value;
}

async function main() {
  const listed = await request('/auth/v1/admin/users?per_page=1000&page=1');
  const users = Array.isArray(listed) ? listed : (listed?.users || []);
  const byEmail = new Map(users.map((user) => [String(user.email || '').toLowerCase(), user]));
  const profiles = [];

  for (const member of staff) {
    const email = `${member.key}@${domain}`.toLowerCase();
    let user = byEmail.get(email);
    if (!user) {
      user = await request('/auth/v1/admin/users', {
        method: 'POST',
        body: {
          email,
          password,
          email_confirm: true,
          user_metadata: { staff_key: member.key, full_name: member.name }
        }
      });
      console.log(`Đã tạo: ${member.name} (${email})`);
    } else {
      await request(`/auth/v1/admin/users/${encodeURIComponent(user.id)}`, {
        method: 'PUT',
        body: { user_metadata: { ...(user.user_metadata || {}), staff_key: member.key, full_name: member.name } }
      });
      console.log(`Đã giữ tài khoản hiện có: ${member.name} (${email})`);
    }
    profiles.push({
      id: user.id,
      staff_key: member.key,
      full_name: member.name,
      title: member.title,
      access_role: member.role,
      updated_at: new Date().toISOString()
    });
  }

  await request('/rest/v1/profiles?on_conflict=id', {
    method: 'POST',
    body: profiles,
    headers: { prefer: 'resolution=merge-duplicates,return=minimal' }
  });
  console.log(`Hoàn tất ${profiles.length} tài khoản. Mật khẩu mặc định chỉ áp dụng cho tài khoản vừa tạo: ${password}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
