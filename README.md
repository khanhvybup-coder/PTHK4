# KTHS online package - Supabase Auth, Realtime và RLS

Gói này đã gồm frontend, Netlify Function và dữ liệu khởi tạo Supabase. Netlify Function giữ `SUPABASE_SERVICE_ROLE_KEY`; khóa này không xuất hiện trong JavaScript trình duyệt.

## 1. Chuẩn bị Supabase

1. Tạo một Supabase project và sao lưu nếu project đã có dữ liệu.
2. Mở SQL Editor, chạy toàn bộ `supabase/001_schema.sql`. Tệp này chạy lặp lại an toàn, bổ sung RLS, bảng tín hiệu Realtime và publication mà không xóa dòng dữ liệu `main`.
3. Tạo 8 tài khoản Auth và liên kết `profiles` bằng script dưới đây. Tài khoản mới dùng mật khẩu mặc định `3103`; script không đặt lại mật khẩu của tài khoản đã tồn tại.

```powershell
$env:SUPABASE_URL="https://YOUR_PROJECT_REF.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="YOUR_SERVICE_ROLE_KEY"
node setup-auth-users.cjs
```

4. Không cần đưa `migration/workflow-state.json` lên thư mục public. Lần gọi API đầu tiên sau khi đăng nhập sẽ tự nhập bản dữ liệu cũ đóng kèm trong Netlify Function nếu bảng `kths_app_state` đang trống.

Gói khởi tạo sẵn đúng 5 phòng thực hành cùng công năng và sức chứa. Nếu project Supabase mới chưa có dòng `main`, 5 phòng này được nhập tự động cùng 19 phiếu cũ và 178 phương tiện.

`kths_app_state` là nguồn dữ liệu vận hành của bản online. Nếu dòng `main` đã tồn tại, Function chỉ đọc và cập nhật dòng đó, không ghi đè dữ liệu cũ. Các bảng chuẩn hóa `loans`, `equipment`... của một hệ thống cũ không tự được ghép ngược vào JSON state; cần xuất/chuyển đổi chúng thành một document state trước khi deploy nếu đó là nguồn dữ liệu cần giữ.

## 2. Deploy Netlify

1. Deploy **toàn bộ thư mục này**, không chỉ thư mục `site`.
2. Cách khuyến nghị: đưa toàn bộ thư mục lên một Git repository, sau đó chọn **Add new site > Import an existing project** trong Netlify. Không kéo riêng `site` vào Netlify Drop vì cách đó không đóng gói Functions.
3. Hoặc dùng Netlify CLI tại thư mục này: `npx netlify deploy --build --prod`.
4. Netlify tự đọc `netlify.toml`: publish directory là `site`, functions directory là `netlify/functions`.
5. Trong Site configuration > Environment variables, đặt:
   - `SUPABASE_URL`: URL project Supabase.
   - `SUPABASE_SERVICE_ROLE_KEY`: service-role key của project.
   - `SUPABASE_PUBLISHABLE_KEY`: publishable key (hoặc anon key cũ) của project.
   - `KTHS_AUTH_EMAIL_DOMAIN`: để `kths.local` nếu không có yêu cầu khác.
6. Redeploy sau khi đặt biến môi trường.

Không đặt service-role key trong `site`, `deploy-config.js` hoặc biến bắt đầu bằng `PUBLIC_`. Publishable key được phép gửi tới trình duyệt; quyền dữ liệu vẫn do access token, Function và RLS kiểm soát.

## 3. Kiểm tra sau deploy

- Mở giao diện, chọn người dùng và nhập mật khẩu. Khi chưa đăng nhập, `https://TEN-SITE.netlify.app/api/state` phải trả `401` thay vì lộ dữ liệu.
- Tạo một phiếu thử. Trình duyệt đang thao tác cập nhật ngay từ phản hồi lệnh; trình duyệt khác nhận thay đổi qua Supabase Realtime mà không chờ vòng polling 3 giây.
- Thêm hoặc sửa một phòng bằng tài khoản Huấn, sau đó mở cùng site trên điện thoại. Danh mục phòng và các chỉ số Tổng quan phải giống nhau trên hai thiết bị.
- Tải lại trang; phiếu vừa tạo vẫn phải còn.

### Cách phân quyền

- Supabase Auth xác thực mật khẩu và cấp access token.
- Netlify Function kiểm tra token, đọc `profiles.staff_key` rồi tự gắn người thực hiện vào lệnh. Giá trị `actorKey` do trình duyệt gửi không còn được tin cậy.
- RLS chỉ cho tài khoản đã đăng nhập đọc hồ sơ của chính mình và hàng tín hiệu Realtime. Document `kths_app_state` không mở trực tiếp cho trình duyệt.
- Huấn vẫn là người duy nhất có quyền quản trị/duyệt cuối; Công và Thương chỉ cho ý kiến khi được chỉ định; các quyền nghiệp vụ tiếp tục được kiểm tra tại Function.

### Đồng bộ dữ liệu phòng cũ

Bản online lưu phòng, phương tiện và phiếu trong cùng document `kths_app_state` trên Supabase. Nếu trình duyệt máy tính đang có dữ liệu phòng từ bản cũ lưu bằng `localStorage`, sau khi redeploy hãy mở trang trên máy tính, chọn Trần Xuân Huấn và nhập mật khẩu một lần. Ứng dụng sẽ nhập các phòng cũ lên Supabase; điện thoại nhận dữ liệu chung trong lần đồng bộ kế tiếp.

Nếu project Supabase đã có dòng `main` với danh mục 3 phòng cũ, redeploy sẽ không tự ghi đè dữ liệu đang vận hành. Sau khi sao lưu, chạy `supabase/update-canonical-rooms.sql` một lần trong SQL Editor. Script này chỉ thay danh mục phòng bằng 5 phòng chuẩn; toàn bộ phiếu, lịch sử xử lý, phương tiện, người dùng và bộ đếm mã phiếu được giữ nguyên.

Trên điện thoại, dùng nút menu ở góc trái thanh trên cùng để mở Tổng quan, Phòng thực hành, Phương tiện, Quản lý Mượn - Trả và Thống kê - Báo cáo.

## Xử lý lỗi tải dữ liệu

- `Cannot read properties of null (reading 'authEmailDomain')`: bản cũ không nhận được `/api/config`. Với bản mới, lỗi này được thay bằng thông báo rõ nguyên nhân. Mở `https://TEN-SITE.netlify.app/api/config`: nếu trả `404` thì Netlify Function chưa được deploy; nếu trả `500`/`SUPABASE_CONFIG_MISSING` thì thiếu biến môi trường; nếu trả JSON có `supabaseUrl` và `supabasePublishableKey` thì cấu hình đã đúng.
- `Không tải được dữ liệu (404)`: site được đưa lên bằng Netlify Drop nên Function chưa được build. Deploy lại bằng Git import hoặc Netlify CLI từ thư mục gốc của gói này.
- `Netlify chưa được cấu hình...`: kiểm tra đủ `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` và `SUPABASE_PUBLISHABLE_KEY` trong context Production, rồi redeploy.
- `Tài khoản chưa được gắn với người dùng KTHS`: chạy lại `node setup-auth-users.cjs` với service-role key đúng project.
- Không nhận cập nhật Realtime: chạy lại `supabase/001_schema.sql`, rồi kiểm tra Database > Publications có bảng `kths_state_signal` trong `supabase_realtime`.
- Lỗi `SUPABASE_REQUEST_FAILED`: kiểm tra đã chạy `supabase/001_schema.sql`, URL đúng dạng `https://<project-ref>.supabase.co`, và dùng đúng `service_role` key ở phía server.

## Reset riêng dữ liệu phiếu

Sau khi sao lưu, chạy `supabase/reset-loans.sql` trong SQL Editor. Phòng, phương tiện, người dùng và ảnh được giữ nguyên. Bộ đếm theo năm được xóa, nên phiếu đầu tiên sau reset có dạng `PM-2026-01`.
