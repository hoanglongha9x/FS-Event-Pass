# Số đo staging FSchool Event Pass

Dữ liệu giả gồm 395 học sinh, 12 lớp, 11 gian hàng và 2.374 bản ghi. Staging là Web App Chỉ mình tôi.
Thời gian tính bằng ms. Mỗi ô ghi trung vị và p95 tính theo thứ hạng gần nhất. Với n = 1, ô ghi giá trị duy nhất.
Cột ngoài hàm Apps Script gồm mạng, vận chuyển RPC, hàng đợi hoặc nền tảng Google và giải mã trên client.
Cột Sheets cộng các lời gọi đã gắn đo. Một số API metadata như getLastRow có thể nằm trong pha gọi bao ngoài.
Nạp lại cache là phần thời gian riêng của pha nạp lại, sau khi tách các pha Sheets và CacheService con.
Kích thước là JSON nghiệp vụ trước khi gắn dữ liệu đo, không gồm phần đóng gói RPC.
20 vòng thu được 233 mẫu. Pilot độc lập thu 14 mẫu. Giá trị p95 với n = 10 là mẫu lớn nhất.
Trong 10 cặp ghi cùng lượt, mỗi cặp có đúng một thành công và một xung đột. Trong 10 ca poll chồng ghi, lượt đọc cũ hoàn tất trước lượt ghi.
Bản chép staging dùng cú pháp gán tương đương cho ba phép ||= mà trình biên tập Apps Script báo ParseError. Các tệp ứng dụng trong workspace không đổi.

| Kịch bản | Action | n | Thành công | Cache hit | RPC | Apps Script | Ngoài hàm Apps Script | Sheets | Mở Sheets | Đọc Sheets | Ghi Sheets | Flush | Chờ khóa | Đọc cache | Nạp lại cache | Cập nhật cache | Xác thực/quyền | Nghiệp vụ | Tiếp nhận | JSON | Byte JSON |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Pilot · lượt đầu | GET_EVENT_VIEW | 1 | 1 | 0 | 2704 | 1450 | 1254 | 664 | 355 | 309 | 0 | 0 | 99 | 23 | 115 | 131 | 143 | 109 | 15 | 3 | 613049 |
| first_request | GET_EVENT_VIEW | 1 | 1 | 0 | 3273 | 1956 | 1317 | 766 | 196 | 570 | 0 | 0 | 107 | 29 | 108 | 138 | 562 | 88 | 20 | 2 | 613110 |
| normal | LIST_EVENT_ASSIGNMENTS | 20 | 20 | 0 | 1678 / 2506 | 612 / 1059 | 1025 / 1698 | 328 / 650 | 218 / 563 | 96 / 143 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 158 / 358 | 102 / 193 | 22 / 50 | 0 / 0 | 662 / 662 |
| normal | LIST_ROSTER | 20 | 20 | 10 | 2939 / 4710 | 1672 / 3499 | 1193 / 1472 | 746 / 1350 | 226 / 520 | 508 / 943 | 0 / 0 | 0 / 0 | 28 / 125 | 39 / 78 | 44 / 201 | 49 / 346 | 162 / 347 | 356 / 807 | 22 / 77 | 0 / 1 | 53060 / 53060 |
| normal | SAVE_EVENT_BOOTHS | 20 | 20 | 0 | 2389 / 3270 | 1346 / 1962 | 988 / 1336 | 774 / 1245 | 221 / 599 | 314 / 496 | 3 / 12 | 196 / 618 | 73 / 121 | 0 / 0 | 0 / 0 | 46 / 93 | 126 / 243 | 275 / 435 | 19 / 76 | 0 / 0 | 16 / 16 |
| after_write | GET_EVENT_VIEW | 20 | 20 | 0 | 2521 / 3836 | 1472 / 2557 | 1161 / 1410 | 553 / 1170 | 222 / 433 | 328 / 666 | 0 / 0 | 0 / 0 | 80 / 151 | 36 / 91 | 128 / 224 | 156 / 519 | 190 / 432 | 99 / 179 | 22 / 89 | 2 / 6 | 613154 / 613896 |
| warm_candidate | GET_EVENT_VIEW | 20 | 20 | 20 | 1663 / 2090 | 608 / 983 | 1055 / 1209 | 298 / 577 | 202 / 278 | 94 / 138 | 0 / 0 | 0 / 0 | 0 / 0 | 56 / 106 | 0 / 0 | 0 / 0 | 172 / 345 | 30 / 45 | 22 / 40 | 0 / 0 | 174 / 174 |
| normal | SAVE_EVENT_CONFIG | 20 | 20 | 0 | 2490 / 3718 | 1488 / 2500 | 1122 / 1268 | 850 / 1247 | 212 / 339 | 408 / 546 | 3 / 6 | 196 / 298 | 70 / 156 | 0 / 0 | 0 / 0 | 44 / 139 | 135 / 277 | 360 / 674 | 20 / 76 | 0 / 0 | 16 / 16 |
| teacher_after_switch | GET_EVENT_VIEW | 20 | 20 | 0 | 2526 / 3483 | 1366 / 2242 | 1182 / 1388 | 562 / 1388 | 232 / 550 | 333 / 601 | 0 / 0 | 0 / 0 | 76 / 135 | 36 / 102 | 116 / 239 | 141 / 503 | 152 / 324 | 88 / 179 | 24 / 50 | 2 / 4 | 294949 / 392829 |
| normal | TEACHER_COMPLETE | 20 | 20 | 0 | 2959 / 4383 | 1886 / 3089 | 1089 / 1666 | 1132 / 1526 | 226 / 393 | 668 / 939 | 8 / 15 | 194 / 342 | 72 / 126 | 0 / 0 | 0 / 0 | 46 / 264 | 154 / 280 | 462 / 950 | 20 / 73 | 0 / 0 | 16 / 16 |
| teacher_after_write | GET_EVENT_VIEW | 20 | 20 | 0 | 2661 / 3667 | 1454 / 2382 | 1147 / 1402 | 614 / 840 | 237 / 424 | 310 / 508 | 0 / 0 | 0 / 0 | 74 / 153 | 36 / 89 | 122 / 255 | 150 / 509 | 154 / 377 | 102 / 170 | 23 / 86 | 2 / 4 | 294992 / 392872 |
| concurrent_writes | TEACHER_COMPLETE | 20 | 10 | 0 | 4353 / 6076 | 3229 / 4884 | 1084 / 1263 | 1166 / 1664 | 226 / 444 | 788 / 1019 | 2 / 6 | 152 / 281 | 840 / 2734 | 0 / 0 | 0 / 0 | 65 / 151 | 182 / 353 | 493 / 768 | 32 / 77 | 0 / 1 | 116 / 216 |
| poll_while_write | GET_EVENT_VIEW | 10 | 10 | 10 | 1756 / 2086 | 605 / 924 | 1085 / 1392 | 348 / 611 | 234 / 388 | 96 / 310 | 0 / 0 | 0 / 0 | 0 / 0 | 50 / 87 | 0 / 0 | 0 / 0 | 169 / 503 | 16 / 44 | 20 / 29 | 0 / 1 | 174 / 174 |
| poll_while_write | TEACHER_COMPLETE | 10 | 10 | 0 | 2978 / 4140 | 1996 / 3043 | 990 / 1286 | 1154 / 1949 | 199 / 435 | 684 / 1383 | 7 / 11 | 215 / 456 | 64 / 98 | 0 / 0 | 0 / 0 | 45 / 67 | 150 / 235 | 498 / 810 | 18 / 36 | 0 / 0 | 16 / 16 |
| poll_after_overlap | GET_EVENT_VIEW | 10 | 10 | 0 | 2527 / 3452 | 1334 / 2337 | 1101 / 1719 | 566 / 843 | 224 / 393 | 331 / 450 | 0 / 0 | 0 / 0 | 71 / 127 | 41 / 146 | 112 / 186 | 138 / 505 | 168 / 509 | 88 / 141 | 27 / 83 | 1 / 2 | 197462 / 197849 |
| student_view | GET_EVENT_VIEW | 1 | 1 | 1 | 2095 | 1019 | 1076 | 708 | 177 | 531 | 0 | 0 | 0 | 41 | 0 | 0 | 237 | 13 | 12 | 0 | 3791 |
| student_no_admin | LIST_ROSTER | 1 | 0 | 0 | 871 | 35 | 836 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 5 | 15 | 0 | 255 |
| Cạnh tranh · ghi thành công | TEACHER_COMPLETE | 10 | 10 | 0 | 3397 / 4229 | 2364 / 3132 | 1020 / 1162 | 1306 / 1784 | 256 / 444 | 755 / 1205 | 5 / 10 | 210 / 537 | 72 / 208 | 0 / 0 | 0 / 0 | 54 / 151 | 141 / 516 | 477 / 830 | 18 / 80 | 0 / 0 | 16 / 16 |
| Cạnh tranh · từ chối xung đột | TEACHER_COMPLETE | 10 | 0 | 0 | 5223 / 6327 | 4056 / 5005 | 1154 / 1443 | 1098 / 1514 | 222 / 497 | 788 / 919 | 0 / 0 | 107 / 152 | 2108 / 2980 | 0 / 0 | 0 / 0 | 76 / 263 | 214 / 276 | 505 / 768 | 42 / 62 | 0 / 1 | 216 / 216 |
| Cache ấm đã xác nhận | GET_EVENT_VIEW | 20 | 20 | 20 | 1663 / 2090 | 608 / 983 | 1055 / 1209 | 298 / 577 | 202 / 278 | 94 / 138 | 0 / 0 | 0 / 0 | 0 / 0 | 56 / 106 | 0 / 0 | 0 / 0 | 172 / 345 | 30 / 45 | 22 / 40 | 0 / 0 | 174 / 174 |
| Đọc liên tiếp nhưng cache hụt | GET_EVENT_VIEW | 0 | 0 | 0 | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |

## Chuỗi ghi rồi đọc

Hai phép đo trong cùng vòng được cộng trước khi tính trung vị và p95.

| Chuỗi action | n | RPC p50 / p95 | RPC lượt đọc p50 / p95 |
| --- | ---: | ---: | ---: |
| SAVE_EVENT_BOOTHS → GET_EVENT_VIEW (after_write) | 20 | 4967 / 6879 | 2521 / 3836 |
| SAVE_EVENT_CONFIG → GET_EVENT_VIEW (teacher_after_switch) | 20 | 5363 / 6872 | 2526 / 3483 |
| TEACHER_COMPLETE → GET_EVENT_VIEW (teacher_after_write) | 20 | 5999 / 7659 | 2661 / 3667 |

Chuỗi chuyển sự kiện ở đây dùng lượt đọc dưới quyền giáo viên. Giao diện BTC dùng lượt đọc dưới quyền BTC.
