const WORKFLOW_SHEET_NAME = "WorkflowState";
const WORKFLOW_HEADERS = ["Loại bản ghi", "Mã bản ghi", "Cập nhật lúc", "Dữ liệu JSON"];
const ALLOWED_RECORD_TYPES = ["student", "queue", "draw", "drawHistory", "config"];
const EVENT_BOOTH_IDS = ["robotics", "chemistry", "ai-iot", "3d-print", "culture", "green"];
const TEACHER_EMAIL_PATTERN = /^[^@\s]+@(?:fpt\.edu\.vn|fe\.edu\.vn)$/i;
const TEACHER_OTP_TTL_SECONDS = 300;
const TEACHER_SESSION_TTL_SECONDS = 21600;

function workflowSpreadsheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error("Hãy gắn Apps Script trực tiếp vào Google Sheets sự kiện.");
  return spreadsheet;
}

function workflowSheet_() {
  const spreadsheet = workflowSpreadsheet_();
  const sheet = spreadsheet.getSheetByName(WORKFLOW_SHEET_NAME) || spreadsheet.insertSheet(WORKFLOW_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, WORKFLOW_HEADERS.length).setValues([WORKFLOW_HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function workflowOutput_(data, callback) {
  const json = JSON.stringify(data);
  if (callback && /^[A-Za-z0-9_$.]+$/.test(callback)) {
    return ContentService.createTextOutput(callback + "(" + json + ");")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  const params = (e && e.parameter) ? e.parameter : {};
  const callback = params.callback || "";
  try {
    const action = String(params.action || "");
    if (action === "sendOTP" || action === "SEND_TEACHER_OTP") {
      return workflowOutput_(sendTeacherOtp_(params.email, params.otp), callback);
    }
    if (action === "VERIFY_TEACHER_LOGIN" || action === "verifyOTP") {
      return workflowOutput_(verifyTeacherLogin_(params.email, params.otp), callback);
    }

    const sheet = workflowSheet_();
    const lastRow = sheet.getLastRow();
    const records = lastRow < 2 ? [] : sheet.getRange(2, 1, lastRow - 1, 4).getValues()
      .filter(function(row) { return row[0] && row[1] && row[3]; })
      .map(function(row) {
        return {
          type: String(row[0]),
          id: String(row[1]),
          updatedAt: String(row[2]),
          data: JSON.parse(String(row[3]))
        };
      });
    return workflowOutput_({
      success: true,
      updatedAt: new Date().toISOString(),
      records: records
    }, callback);
  } catch (error) {
    return workflowOutput_({ success: false, status: "error", message: String(error.message || error), error: String(error.message || error) }, callback);
  }
}

function doPost(e) {
  try {
    const raw = (e && e.postData && e.postData.contents) ? e.postData.contents : "{}";
    const body = JSON.parse(raw);
    const action = String(body.action || "SYNC_RECORD");
    if (action === "sendOTP" || action === "SEND_TEACHER_OTP") {
      return workflowOutput_(sendTeacherOtp_(body.email, body.otp));
    }
    if (action === "VERIFY_TEACHER_LOGIN" || action === "verifyOTP") {
      return workflowOutput_(verifyTeacherLogin_(body.email, body.otp));
    }
    return workflowOutput_(processWorkflowAction_(action, body));
  } catch (error) {
    return workflowOutput_({ success: false, status: "error", message: String(error.message || error), error: String(error.message || error) });
  }
}

function normalizeTeacherEmail_(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!TEACHER_EMAIL_PATTERN.test(email)) throw new Error("Chỉ chấp nhận email @fpt.edu.vn hoặc @fe.edu.vn.");
  return email;
}

function sendTeacherOtp_(value, requestedCode) {
  const email = normalizeTeacherEmail_(value);
  const cache = CacheService.getScriptCache();
  
  // Làm sạch mã OTP nếu được truyền từ trình duyệt sang
  const cleanRequested = requestedCode ? String(requestedCode).replace(/\D/g, "") : "";
  const code = (cleanRequested.length === 6)
    ? cleanRequested
    : String(Math.floor(100000 + Math.random() * 900000));

  const otpKey = "teacher-otp:" + email;
  cache.put(otpKey, code, TEACHER_OTP_TTL_SECONDS);
  cache.put("teacher-otp-attempts:" + email, "0", TEACHER_OTP_TTL_SECONDS);

  const htmlBody = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px;">
      <h2 style="color: #F27024; margin-top: 0;">FSchool Event Pass - THPT FPT Quy Nhơn</h2>
      <p>Xin chào thầy/cô <b>${email}</b>,</p>
      <p>Mã xác thực (OTP) để truy cập Cổng Giáo viên & BTC là:</p>
      <div style="background: #fff7ed; border: 2px dashed #f97316; padding: 16px; text-align: center; font-size: 28px; font-weight: bold; letter-spacing: 6px; color: #1e3a8a; border-radius: 12px; margin: 20px 0;">
        ${code}
      </div>
      <p style="color: #64748b; font-size: 13px;">Mã có hiệu lực trong 5 phút.</p>
    </div>
  `;

  try {
    MailApp.sendEmail({
      to: email,
      subject: "[FSchool Event Pass] Mã OTP xác thực Giáo viên: " + code,
      body: "Mã xác thực của bạn là " + code + ". Mã có hiệu lực trong 5 phút.",
      htmlBody: htmlBody,
      name: "FSchool Event Pass"
    });
  } catch (error) {
    throw new Error("Không gửi được email OTP. Hãy kiểm tra quyền gửi thư của Apps Script.");
  }
  return { success: true, status: "ok", expiresInSeconds: TEACHER_OTP_TTL_SECONDS };
}

function verifyTeacherLogin_(emailValue, otpValue) {
  const email = normalizeTeacherEmail_(emailValue || "teacher@fpt.edu.vn");
  // Chỉ giữ lại các chữ số từ 0-9, loại bỏ hoàn toàn dấu cách ẩn khi copy từ điện thoại
  const otp = String(otpValue || "").replace(/\D/g, "");
  const cache = CacheService.getScriptCache();
  const otpKey = "teacher-otp:" + email;
  const cachedOtp = String(cache.get(otpKey) || "").replace(/\D/g, "");

  const isValidOtp = (otp.length === 6 && cachedOtp === otp);

  if (!isValidOtp) throw new Error("Mã OTP không đúng hoặc đã hết hạn.");

  cache.remove(otpKey);
  const token = Utilities.getUuid() + Utilities.getUuid();
  cache.put("teacher-session:" + token, email, TEACHER_SESSION_TTL_SECONDS);
  return { success: true, status: "ok", email: email, token: token, expiresInSeconds: TEACHER_SESSION_TTL_SECONDS };
}

function requireTeacherSession_(body) {
  const token = String(body.authToken || "");
  const email = token ? CacheService.getScriptCache().get("teacher-session:" + token) : "";
  if (!email) throw new Error("Phiên giáo viên không hợp lệ hoặc đã hết hạn. Hãy đăng nhập lại.");
  return email;
}

function safeWorkflowCell_(value) {
  const text = String(value || "").trim();
  return /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
}

function makeUniqueLuckyNumbers_(record, rows) {
  if (record.type !== "student" || !record.data.luckyNumbers) return;
  const usedByEvent = {};
  rows.forEach(function(row) {
    if (String(row[0]) !== "student" || String(row[1]).trim() === String(record.id)) return;
    try {
      const data = JSON.parse(String(row[3] || "{}"));
      Object.keys(data.luckyNumbers || {}).forEach(function(eventId) {
        const number = String(data.luckyNumbers[eventId]);
        usedByEvent[eventId] = usedByEvent[eventId] || {};
        usedByEvent[eventId][number] = true;
      });
    } catch (error) {
      console.warn("Bỏ qua bản ghi học sinh không hợp lệ khi kiểm tra số may mắn.", error);
    }
  });
  Object.keys(record.data.luckyNumbers).forEach(function(eventId) {
    const used = usedByEvent[eventId] || {};
    const number = String(record.data.luckyNumbers[eventId] || "");
    if (!/^\d{4}$/.test(number)) throw new Error("Mã vé may mắn phải gồm đúng 4 chữ số.");
    if (used[number]) throw new Error("Mã vé may mắn " + number + " đã được cấp cho học sinh khác trong sự kiện này.");
  });
}

function workflowRows_(sheet) {
  const lastRow = sheet.getLastRow();
  return lastRow < 2 ? [] : sheet.getRange(2, 1, lastRow - 1, 4).getValues();
}

function drawHistoryResetAt_(rows, eventId) {
  const markerId = safeWorkflowCell_("reset:" + String(eventId || ""));
  const marker = rows.find(function(row) {
    return String(row[0]) === "drawHistory" && String(row[1]).trim() === markerId;
  });
  if (!marker) return 0;
  const data = parseWorkflowData_(marker);
  return Date.parse(data.resetAt || data.updatedAt || marker[2]) || 0;
}

function parseWorkflowData_(row) {
  try {
    return JSON.parse(String(row[3] || "{}"));
  } catch (error) {
    throw new Error("Dữ liệu bản ghi hiện có không hợp lệ.");
  }
}

function configuredBoothIds_(rows) {
  const configRow = rows.find(function(row) {
    return String(row[0]) === "config" && String(row[1]).trim() === "booth-config";
  });
  if (!configRow) return EVENT_BOOTH_IDS.slice();
  const config = parseWorkflowData_(configRow);
  const ids = Array.isArray(config.boothList) ? config.boothList.map(function(booth) {
    return booth && String(booth.id || "");
  }).filter(function(id, index, list) {
    return id && list.indexOf(id) === index;
  }) : [];
  return ids.length ? ids : EVENT_BOOTH_IDS.slice();
}

function validateQueueTeacherAction_(action, record, rows) {
  const data = record.data;
  const previousRow = rows.find(function(row) {
    return String(row[0]) === "queue" && String(row[1]).trim() === safeWorkflowCell_(record.id);
  });
  const previous = previousRow ? parseWorkflowData_(previousRow) : null;
  if (!previous || previous.status !== "waiting") throw new Error("Lượt này không còn ở trạng thái đang chờ.");
  if (data.eventId !== previous.eventId || data.boothId !== previous.boothId || data.studentCode !== previous.studentCode) {
    throw new Error("Không thể thay đổi thông tin định danh của lượt.");
  }
  const waiting = rows.map(function(row) {
    return String(row[0]) === "queue" ? parseWorkflowData_(row) : null;
  }).filter(function(item) {
    return item && item.eventId === data.eventId && item.boothId === data.boothId && item.status === "waiting";
  }).sort(function(a, b) {
    return Number(a.ticketNo) - Number(b.ticketNo);
  });
  if (!waiting.length || String(waiting[0].studentCode) !== String(data.studentCode)) {
    throw new Error("Chỉ có thể xử lý học sinh đang đứng đầu hàng đợi.");
  }
  if (action === "TEACHER_COMPLETE" && data.status !== "completed") throw new Error("Trạng thái hoàn thành không hợp lệ.");
  if (action === "TEACHER_SKIP" && data.status !== "missed") throw new Error("Trạng thái bỏ lượt không hợp lệ.");
}

function validateQueueRecall_(record, previous) {
  const data = record.data;
  if (!previous || previous.status !== "missed" || data.status !== "waiting" ||
      data.eventId !== previous.eventId || data.boothId !== previous.boothId ||
      data.studentCode !== previous.studentCode) {
    throw new Error("Không thể gọi lại lượt này.");
  }
}

function sameMapExcept_(first, second, excludedKey) {
  const keys = {};
  Object.keys(first || {}).forEach(function(key) { if (key !== excludedKey) keys[key] = true; });
  Object.keys(second || {}).forEach(function(key) { if (key !== excludedKey) keys[key] = true; });
  return Object.keys(keys).every(function(key) {
    return String((first || {})[key] || "") === String((second || {})[key] || "");
  });
}

function processWorkflowAction_(action, body) {
  const teacherActions = ["TEACHER_COMPLETE", "TEACHER_SKIP", "TEACHER_RECALL", "ANNOUNCE_WINNER", "RESET_DRAW_HISTORY"];
  if (teacherActions.indexOf(action) >= 0) requireTeacherSession_(body);
  const record = body.record;
  if (!record || ALLOWED_RECORD_TYPES.indexOf(record.type) < 0 || !record.id || !record.data) {
    throw new Error("Bản ghi đồng bộ không hợp lệ.");
  }
  const type = String(record.type);
  const id = safeWorkflowCell_(record.id);
  const updatedAt = String(record.updatedAt || record.data.updatedAt || new Date().toISOString());
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = workflowSheet_();
    const rows = workflowRows_(sheet);
    const rowIndex = rows.findIndex(function(row) {
      return String(row[0]) === type && String(row[1]).trim() === id;
    });
    const prior = rowIndex < 0 ? null : parseWorkflowData_(rows[rowIndex]);

    if (action === "RESET_DRAW_HISTORY") {
      const eventId = String(record.data.eventId || "");
      const resetAt = String(record.data.resetAt || updatedAt);
      if (type !== "drawHistory" || !eventId || id !== safeWorkflowCell_("reset:" + eventId) ||
          record.data.reset !== true || Number.isNaN(Date.parse(resetAt))) {
        throw new Error("Thông tin đặt lại lịch sử quay không hợp lệ.");
      }
      for (let index = rows.length - 1; index >= 0; index--) {
        const rowType = String(rows[index][0]);
        if (rowType !== "draw" && rowType !== "drawHistory") continue;
        const existing = parseWorkflowData_(rows[index]);
        if (String(existing.eventId || "") === eventId) sheet.deleteRow(index + 2);
      }
      record.data.resetAt = resetAt;
      record.data.updatedAt = updatedAt;
      sheet.appendRow([type, id, updatedAt, JSON.stringify(record.data)]);
      return { success: true, status: "ok", resetAt: resetAt };
    } else if (action === "JOIN_QUEUE") {
      if (type !== "queue" || record.data.status !== "waiting" || !record.data.eventId || !record.data.boothId || !record.data.studentCode) {
        throw new Error("Thông tin bốc số không hợp lệ.");
      }
      if (prior && prior.status !== "cancelled") {
        return { success: true, status: "ok", duplicate: true, record: prior };
      }
      const maxNumber = rows.reduce(function(max, row) {
        if (String(row[0]) !== "queue") return max;
        const queueItem = parseWorkflowData_(row);
        return queueItem.eventId === record.data.eventId && queueItem.boothId === record.data.boothId
          ? Math.max(max, Number(queueItem.ticketNo) || 0)
          : max;
      }, 0);
      record.data.ticketNo = maxNumber + 1;
    } else if (action === "CANCEL_QUEUE") {
      if (type !== "queue" || record.data.status !== "cancelled" || !prior || prior.status !== "waiting") {
        throw new Error("Không thể hủy lượt này.");
      }
    } else if (action === "TEACHER_COMPLETE" || action === "TEACHER_SKIP") {
      if (type !== "queue") throw new Error("Bản ghi hàng đợi không hợp lệ.");
      validateQueueTeacherAction_(action, record, rows);
    } else if (action === "TEACHER_RECALL") {
      if (type !== "queue") throw new Error("Bản ghi hàng đợi không hợp lệ.");
      validateQueueRecall_(record, prior);
      record.data.ticketNo = rows.reduce(function(max, row) {
        if (String(row[0]) !== "queue") return max;
        const item = parseWorkflowData_(row);
        return item.eventId === record.data.eventId && item.boothId === record.data.boothId
          ? Math.max(max, Number(item.ticketNo) || 0)
          : max;
      }, 0) + 1;
    } else if (action === "SUBMIT_RATING") {
      const rating = Number(record.data.rating);
      if (type !== "queue" || !prior || prior.status !== "completed" || record.data.status !== "completed" ||
          record.data.studentCode !== prior.studentCode || !Number.isInteger(rating) || rating < 1 || rating > 5) {
        throw new Error("Đánh giá không hợp lệ hoặc gian hàng chưa được hoàn thành.");
      }
    } else if (action === "ISSUE_LUCKY_NUMBER") {
      if (type !== "student") throw new Error("Bản ghi học sinh không hợp lệ.");
      const priorData = prior || {};
      const eventId = String(body.eventId || Object.keys(record.data.luckyNumbers || {}).find(function(key) {
        return record.data.luckyNumbers && record.data.luckyNumbers[key];
      }) || "");
      const number = record.data.luckyNumbers && record.data.luckyNumbers[eventId];
      if (!eventId || !/^\d{4}$/.test(String(number || "")) ||
          !sameMapExcept_(record.data.favoriteBooths, priorData.favoriteBooths, eventId) ||
          !sameMapExcept_(record.data.luckyNumbers, priorData.luckyNumbers, eventId) ||
          (priorData.luckyNumbers && priorData.luckyNumbers[eventId] &&
           String(priorData.luckyNumbers[eventId]) !== String(number))) {
        throw new Error("Không thể thay đổi bình chọn hoặc số may mắn đã ghi nhận.");
      }
    } else if (action === "ANNOUNCE_WINNER") {
      if (type !== "draw" || !record.data.eventId || !record.data.winnerCode || !/^\d{4}$/.test(String(record.data.winningNumber || ""))) {
        throw new Error("Thông tin quay số không hợp lệ.");
      }
      const resetAt = drawHistoryResetAt_(rows, record.data.eventId);
      if ((Date.parse(record.data.drawAt || record.data.updatedAt || updatedAt) || 0) <= resetAt) {
        return { success: true, status: "ok", stale: true, reset: true };
      }
      const winnerRow = rows.find(function(row) {
        return String(row[0]) === "student" && String(row[1]).trim() === safeWorkflowCell_(record.data.winnerCode);
      });
      const winner = winnerRow ? parseWorkflowData_(winnerRow) : null;
      if (!winner || String(winner.luckyNumbers && winner.luckyNumbers[record.data.eventId]) !== String(record.data.winningNumber)) {
        throw new Error("Số trúng thưởng không khớp với vé may mắn đã cấp.");
      }
    } else if (action === "SYNC_RECORD") {
      if (type === "queue") throw new Error("Hãy dùng lệnh hàng đợi phù hợp để thay đổi trạng thái.");
      if (type === "draw" || type === "drawHistory" || type === "config") requireTeacherSession_(body);
      if (type === "drawHistory" && !record.data.reset &&
          (Date.parse(record.data.drawAt || record.data.updatedAt || updatedAt) || 0) <= drawHistoryResetAt_(rows, record.data.eventId)) {
        return { success: true, status: "ok", stale: true, reset: true };
      }
    } else {
      throw new Error("Lệnh đồng bộ không được hỗ trợ.");
    }

    makeUniqueLuckyNumbers_(record, rows);
    const serialized = JSON.stringify(record.data);
    if (serialized.length > 40000) throw new Error("Dữ liệu bản ghi vượt quá giới hạn.");
    if (rowIndex < 0) {
      sheet.appendRow([type, id, updatedAt, serialized]);
    } else {
      const savedAt = Date.parse(String(rows[rowIndex][2]) || "");
      const incomingAt = Date.parse(updatedAt);
      if (!Number.isNaN(savedAt) && !Number.isNaN(incomingAt) && incomingAt < savedAt) {
        return { success: true, status: "ok", stale: true };
      }
      sheet.getRange(rowIndex + 2, 1, 1, 4).setValues([[type, id, updatedAt, serialized]]);
    }
    return { success: true, status: "ok", record: record };
  } finally {
    lock.releaseLock();
  }
}