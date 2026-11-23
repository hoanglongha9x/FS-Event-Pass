# Đối chiếu staging sau tối ưu ghi

Hai lượt đo dùng cùng bảng staging với 395 học sinh giả, 12 lớp, 11 gian hàng và 2.374 bản ghi. Mỗi lượt có 20 vòng và 233 mẫu có mã tham chiếu riêng. Lần sau tiếp tục dùng các lượt chờ còn lại trong bảng. Không đặt lại dữ liệu.

## Thời gian chờ xác nhận

Đơn vị ms, theo thứ tự p50 / p95. Trước đây, mỗi mẫu cộng thời gian ghi và đọc trong cùng vòng trước khi tính phân vị. Bản mới chỉ chờ xác nhận ghi. Đây là thời gian RPC từ trình chạy staging. Màn hình ứng dụng được kiểm tra riêng bằng Chrome và dữ liệu giả.

| Thao tác | Chờ trước | Chờ sau | Tổng ghi và đối soát sau | Byte trả về khi ghi trước → sau (p50 / p95) |
|---|---:|---:|---:|---:|
| SAVE_EVENT_BOOTHS | 4967 / 6879 | 2437 / 3174 | 5041 / 5703 | 16 / 16 → 2674 / 2675 |
| SAVE_EVENT_CONFIG | 5363 / 6872 | 2637 / 3587 | 5143 / 6655 | 16 / 16 → 475 / 475 |
| TEACHER_COMPLETE | 5999 / 7659 | 3141 / 4170 | 5723 / 6427 | 16 / 16 → 472 / 484 |

Mỗi thao tác riêng lẻ có 2 request nghiệp vụ trước và sau. Số request phải chờ giảm từ 2 xuống 1. Lượt GET nền vẫn có thể trả toàn bộ bản chiếu theo quyền. Kịch bản đổi sự kiện dùng lượt đọc giáo viên sau lần ghi BTC ở cả hai lần đo.

## Từng action và kịch bản

Mỗi ô là p50 / p95. Các cột thời gian dùng ms. Sheets là tổng thời gian mở, đọc, ghi và flush đã gắn đo. Số byte đo trước khi thêm thông tin chẩn đoán và đóng gói RPC.

| Kịch bản · action | n | RPC trước → sau | Apps Script trước → sau | Sheets trước → sau | Byte JSON trước → sau |
|---|---:|---:|---:|---:|---:|
| first_request · GET_EVENT_VIEW | 1 | 3273 / 3273 → 3912 / 3912 | 1956 / 1956 → 2432 / 2432 | 766 / 766 → 1145 / 1145 | 613110 / 613110 → 308434 / 308434 |
| normal · LIST_EVENT_ASSIGNMENTS | 20 | 1678 / 2506 → 1823 / 2310 | 612 / 1059 → 614 / 884 | 328 / 650 → 340 / 541 | 662 / 662 → 662 / 662 |
| normal · LIST_ROSTER | 20 | 2939 / 4710 → 2626 / 3647 | 1672 / 3499 → 1482 / 2460 | 746 / 1350 → 655 / 914 | 53060 / 53060 → 53060 / 53060 |
| normal · SAVE_EVENT_BOOTHS | 20 | 2389 / 3270 → 2437 / 3174 | 1346 / 1962 → 1285 / 1713 | 774 / 1245 → 699 / 1037 | 16 / 16 → 2674 / 2675 |
| after_write · GET_EVENT_VIEW | 20 | 2521 / 3836 → 2578 / 3196 | 1472 / 2557 → 1254 / 1688 | 553 / 1170 → 529 / 857 | 613154 / 613896 → 461643 / 614762 |
| warm_candidate · GET_EVENT_VIEW | 20 | 1663 / 2090 → 1697 / 2148 | 608 / 983 → 548 / 958 | 298 / 577 → 272 / 496 | 174 / 174 → 174 / 174 |
| normal · SAVE_EVENT_CONFIG | 20 | 2490 / 3718 → 2637 / 3587 | 1488 / 2500 → 1471 / 2161 | 850 / 1247 → 866 / 1137 | 16 / 16 → 475 / 475 |
| teacher_after_switch · GET_EVENT_VIEW | 20 | 2526 / 3483 → 2451 / 3449 | 1366 / 2242 → 1144 / 1965 | 562 / 1388 → 481 / 1029 | 294949 / 392829 → 295814 / 393689 |
| normal · TEACHER_COMPLETE | 20 | 2959 / 4383 → 3141 / 4170 | 1886 / 3089 → 2034 / 2751 | 1132 / 1526 → 1119 / 1734 | 16 / 16 → 472 / 484 |
| teacher_after_write · GET_EVENT_VIEW | 20 | 2661 / 3667 → 2547 / 3168 | 1454 / 2382 → 1242 / 1847 | 614 / 840 → 464 / 1073 | 294992 / 392872 → 295858 / 393732 |
| concurrent_writes · TEACHER_COMPLETE | 20 | 4353 / 6076 → 3475 / 4377 | 3229 / 4884 → 2380 / 3344 | 1166 / 1664 → 894 / 1174 | 116 / 216 → 342 / 480 |
| poll_while_write · GET_EVENT_VIEW | 10 | 1756 / 2086 → 1637 / 2139 | 605 / 924 → 540 / 842 | 348 / 611 → 270 / 657 | 174 / 174 → 174 / 174 |
| poll_while_write · TEACHER_COMPLETE | 10 | 2978 / 4140 → 2786 / 3616 | 1996 / 3043 → 1710 / 2580 | 1154 / 1949 → 945 / 1988 | 16 / 16 → 480 / 484 |
| poll_after_overlap · GET_EVENT_VIEW | 10 | 2527 / 3452 → 2497 / 3500 | 1334 / 2337 → 1286 / 2364 | 566 / 843 → 517 / 1125 | 197462 / 197849 → 198322 / 198716 |
| student_view · GET_EVENT_VIEW | 1 | 2095 / 2095 → 3016 / 3016 | 1019 / 1019 → 1858 / 1858 | 708 / 708 → 1276 / 1276 | 3791 / 3791 → 3798 / 3798 |
| student_no_admin · LIST_ROSTER | 1 | 871 / 871 → 1471 / 1471 | 35 / 35 → 17 / 17 | 0 / 0 → 0 / 0 | 255 / 255 → 255 / 255 |

Cả hai lượt đo đều có 10/10 cặp cùng xử lý một lượt chờ cho đúng một thành công và một xung đột. Có 10 vòng poll chồng thao tác ghi. Phiên học sinh đọc được thông tin của chính mình và bị từ chối đọc danh sách quản trị.

Cùng cơ chế HTML Service và google.script.run. Lần trước dùng bản staging riêng tư /exec, lần này dùng URL /dev của cùng dự án cho người có quyền chỉnh sửa. Độ trễ ngoài hàm có thể thay đổi giữa hai lượt. Thứ hạng gần nhất dùng cho p95. Với một mẫu, hai giá trị trùng nhau và không ước lượng được phân phối.

Phạm vi triển khai gồm phản hồi ghi có giới hạn quyền, cập nhật giao diện sau xác nhận, bỏ qua poll cũ và đối soát nền. Nếu mất phản hồi của chính lần ghi, trạng thái thực tế cần được kiểm tra lại trước khi thao tác tiếp. Thiết bị khác vẫn nhận cập nhật theo chu kỳ đồng bộ hiện có.
