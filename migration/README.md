# Dữ liệu chuyển đổi

`workflow-state.json` là bản lưu để đối chiếu và phục hồi thủ công. Bản deploy sử dụng bản sao `netlify/functions/seed-state.json`; Netlify Function tự nhập dữ liệu này khi `kths_app_state` chưa có dòng `main`.

Không đưa tệp JSON này vào thư mục `site` hoặc kho public. Khi cần thay dữ liệu seed trước lần deploy đầu tiên, cập nhật đồng thời `workflow-state.json` và `../netlify/functions/seed-state.json`.
