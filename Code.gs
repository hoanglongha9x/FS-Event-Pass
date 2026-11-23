const WORKFLOW_SHEET_NAME = "WorkflowState";
const WORKFLOW_HEADERS = ["Loại bản ghi", "Mã bản ghi", "Cập nhật lúc", "Dữ liệu JSON"];
const TEACHER_EMAIL_PATTERN = /^[a-z0-9_+-]+(?:\.[a-z0-9_+-]+)*@(?:fpt\.edu\.vn|fe\.edu\.vn)$/i;
const TEACHER_OTP_TTL_SECONDS = 300;
const TEACHER_OTP_MAX_ATTEMPTS = 5;
const TEACHER_OTP_SEND_COOLDOWN_SECONDS = 60;
const TEACHER_OTP_SEND_WINDOW_SECONDS = 3600;
const TEACHER_OTP_SENDS_PER_EMAIL = 3;
const TEACHER_OTP_SENDS_PER_SCRIPT = 60;
const TEACHER_OTP_SEND_LOG_PROPERTY = "teacher-otp-send-log-v2";
const TEACHER_OTP_PROPERTY_PREFIX = "teacher-otp-challenge-v3:";
const TEACHER_OTP_API_VERSION = "teacher-otp-v3";
const TEACHER_SESSION_TTL_SECONDS = 21600;
const TEACHER_OTP_SEND_ACTIONS = ["SEND_TEACHER_OTP_V3", "sendOTP", "SEND_TEACHER_OTP"];
const TEACHER_OTP_VERIFY_ACTIONS = ["VERIFY_TEACHER_OTP_V3", "verifyOTP", "VERIFY_TEACHER_LOGIN"];
const TEACHER_OTP_ACTIONS = TEACHER_OTP_SEND_ACTIONS.concat(TEACHER_OTP_VERIFY_ACTIONS, "GET_TEACHER_OTP_VERSION");
const TEACHER_AUTH_ACTIONS = TEACHER_OTP_ACTIONS.concat("CHECK_TEACHER_SESSION", "LOGOUT_TEACHER");

function workflowSpreadsheet_() {
  const id = (PropertiesService.getScriptProperties().getProperty("FS_EVENT_SPREADSHEET_ID") || "").trim();
  if (!id) throw teacherViewDependencyError_("SPREADSHEET_CONFIGURATION", "Thiếu cấu hình FS_EVENT_SPREADSHEET_ID.");
  try {
    return SpreadsheetApp.openById(id);
  } catch {
    throw teacherViewDependencyError_("SPREADSHEET_OPEN", "Không thể mở bảng tính sự kiện.");
  }
}

function teacherViewDependencyError_(stage, message) {
  const error = new Error(message);
  error.teacherViewStage = stage;
  return error;
}

function workflowSheet_(spreadsheet = workflowSpreadsheet_()) {
  const sheet = spreadsheet.getSheetByName(WORKFLOW_SHEET_NAME) || spreadsheet.insertSheet(WORKFLOW_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, WORKFLOW_HEADERS.length).setValues([WORKFLOW_HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function workflowOutput_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function eventApiVersion_() {
  if (typeof EVENT_PASS_VERSION !== "string" || typeof eventView_ !== "function" || typeof dispatchEventPass_ !== "function" ||
      typeof TEACHER_PORTAL_VERSION !== "string" || typeof teacherEventView_ !== "function" || typeof eventStaff_ !== "function" ||
      typeof STUDENT_ACCESS_VERSION !== "string" || STUDENT_ACCESS_VERSION !== "student-event-access-v1" ||
      typeof loginStudentWithEventAccess_ !== "function" || typeof requireEventStudent_ !== "function" || typeof revokeStudent_ !== "function" ||
      typeof studentAuthRoutes_ !== "function" || studentAuthRoutes_().LOGIN_STUDENT !== loginStudentWithEventAccess_ ||
      studentAuthRoutes_().LOGOUT_STUDENT !== revokeStudent_) {
    return { success: false, code: "API_VERSION_MISMATCH", message: "Bản triển khai thiếu API sự kiện hoặc đăng nhập học sinh. BTC cần cập nhật đầy đủ các file Apps Script và phiên bản /exec." };
  }
  return { success: true, apiVersion: EVENT_PASS_VERSION, otpVersion: TEACHER_OTP_API_VERSION,
    teacherPortalVersion: TEACHER_PORTAL_VERSION, studentAccessVersion: STUDENT_ACCESS_VERSION,
    eventActivationVersion: typeof EVENT_ACTIVATION_VERSION === "string" && typeof configureEventActivation_ === "function" ? EVENT_ACTIVATION_VERSION : undefined,
    eventDeleteVersion: typeof EVENT_DELETE_VERSION === "string" && typeof eventDeleteState_ === "function" &&
      typeof manageEventLifecycle_ === "function" ? EVENT_DELETE_VERSION : undefined,
    eventAdminVersion: typeof EVENT_CONFIG_API_VERSION === "string" && typeof manageEventLifecycle_ === "function" &&
      typeof deleteEventAssignment_ === "function" && typeof eventAdminSetup_ === "function" ? EVENT_CONFIG_API_VERSION : undefined,
    eventImageVersion: typeof EVENT_IMAGE_API_VERSION === "string" && typeof checkedStoredEventImage_ === "function" &&
      typeof saveEventImage_ === "function" ? EVENT_IMAGE_API_VERSION : undefined };
}

function doGet(e) {
  const params = e?.parameter || {};
  if ((params.action && !["PUBLIC_EVENT", "GET_EVENT_IMAGE"].includes(params.action)) || params.callback) {
    return workflowOutput_({ success: false, code: "METHOD_NOT_ALLOWED", message: "Yêu cầu GET không được hỗ trợ." });
  }
  try {
    if (params.action === "GET_EVENT_IMAGE") return workflowOutput_(readEventImage_(params, false));
    return workflowOutput_(eventView_({}));
  } catch (error) {
    if (params.action === "GET_EVENT_IMAGE") {
      return workflowOutput_({ success: false, code: "IMAGE_UNAVAILABLE", message: "Ảnh sự kiện không khả dụng." });
    }
    return workflowOutput_({ success: false, code: "EVENT_UNAVAILABLE", message: "Thông tin sự kiện tạm thời không khả dụng." });
  }
}

function doPost(e) {
  let action = "";
  let teacherStage = "";
  const startedAt = Date.now();
  try {
    const raw = (e && e.postData && e.postData.contents) ? e.postData.contents : "{}";
    const body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) eventError_("INVALID_INPUT", "Yêu cầu không hợp lệ.");
    if (typeof body.action !== "string" || !body.action) {
      eventError_("METHOD_NOT_ALLOWED", "Thiếu action hợp lệ.");
    }
    action = body.action;
    if (action === "GET_EVENT_API_VERSION") {
      return workflowOutput_(eventApiVersion_());
    }
    if (action === "GET_TEACHER_OTP_VERSION") {
      return teacherOtpOutput_({ success: true, status: "ok" });
    }
    if (TEACHER_OTP_SEND_ACTIONS.includes(action)) {
      teacherStage = "OTP_SEND";
      if (Object.prototype.hasOwnProperty.call(body, "otp")) {
        throw teacherAuthError_("OTP_CLIENT_VALUE", "Yêu cầu gửi mã không được chứa OTP.");
      }
      return teacherOtpOutput_(sendTeacherOtp_(body.email));
    }
    if (TEACHER_OTP_VERIFY_ACTIONS.includes(action)) {
      teacherStage = "OTP_VERIFY";
      return teacherOtpOutput_(verifyTeacherLogin_(body.email, body.otp));
    }
    if (action === "CHECK_TEACHER_SESSION") {
      teacherStage = "SESSION_CHECK";
      const session = requireTeacherSession_(body);
      return workflowOutput_({
        success: true, status: "ok", email: session.email,
        expiresInSeconds: Math.max(0, Math.ceil((session.expiresAt - Date.now()) / 1000))
      });
    }
    if (action === "LOGOUT_TEACHER") {
      teacherStage = "SESSION_REVOKE";
      revokeTeacherSession_(body.authToken);
      return workflowOutput_({ success: true, status: "ok" });
    }
    if (action === "GET_EVENT_VIEW" && body.authToken && !body.studentSession) teacherStage = "TEACHER_ACCESS";
    return workflowOutput_(dispatchEventPass_(action, body));
  } catch (error) {
    let result;
    if (TEACHER_AUTH_ACTIONS.indexOf(action) >= 0 && !error.authCode) {
      const messages = {
        OTP_SEND: "Máy chủ chưa hoàn tất yêu cầu gửi mã. Hãy báo BTC kiểm tra trạng thái gửi trước khi yêu cầu lại.",
        OTP_VERIFY: "Máy chủ chưa hoàn tất xác minh. Vui lòng kiểm tra lại phiên hoặc báo BTC.",
        SESSION_CHECK: "Chưa kiểm tra được phiên giáo viên. Vui lòng thử lại.",
        SESSION_REVOKE: "Máy chủ chưa xác nhận thu hồi phiên giáo viên."
      };
      result = { success: false, status: "error", code: "AUTH_UNAVAILABLE", message: messages[teacherStage] || "Dịch vụ xác thực tạm thời không khả dụng." };
    } else if (!error.authCode && teacherStage) {
      result = { success: false, status: "error", code: "TEACHER_VIEW_UNAVAILABLE",
        message: "Máy chủ chưa trả được dữ liệu Cổng Giáo viên. Hãy báo BTC kiểm tra GET_EVENT_VIEW." };
    } else if (!error.authCode) {
      result = { success: false, status: "error", code: "EVENT_UNAVAILABLE", message: "Ứng dụng chưa thể xử lý. Vui lòng thử lại." };
    } else {
      const message = String(error.message || error);
      result = { success: false, status: "error", message: message, error: message };
      if (error.authCode) result.code = error.authCode;
      if (error.retryAfterSeconds) result.retryAfterSeconds = error.retryAfterSeconds;
    }
    if (teacherStage) {
      result.requestRef = Utilities.getUuid();
      const stage = error.teacherViewStage || (result.code === "SESSION_CREATE_FAILED" ? "SESSION_CREATE" :
        result.code === "OTP_MAIL_FAILED" ? "EMAIL_DELIVERY" : teacherStage);
      console.error(JSON.stringify({ requestRef: result.requestRef, action: action, stage: stage,
        code: result.code, at: new Date().toISOString(), elapsedMs: Date.now() - startedAt, success: false }));
    }
    return TEACHER_OTP_ACTIONS.includes(action) ? teacherOtpOutput_(result) : workflowOutput_(result);
  }
}

function teacherOtpOutput_(result) {
  return workflowOutput_({ ...result, otpVersion: TEACHER_OTP_API_VERSION });
}

function normalizeTeacherEmail_(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!TEACHER_EMAIL_PATTERN.test(email) || email.indexOf("@") > 64) {
    throw teacherAuthError_("INVALID_EMAIL", "Chỉ chấp nhận email @fpt.edu.vn hoặc @fe.edu.vn hợp lệ.");
  }
  return email;
}

function teacherAuthError_(code, message, retryAfterSeconds) {
  const error = new Error(message);
  error.authCode = code;
  error.retryAfterSeconds = retryAfterSeconds;
  return error;
}

function withTeacherAuthLock_(action) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return action();
  } finally {
    lock.releaseLock();
  }
}

function teacherAuthDigest_(value) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value));
}

function generateTeacherOtp_() {
  // The first 32 bits of a random UUID are random. Reject the incomplete range
  // so all one million six-digit strings have the same probability.
  const codeCount = 1000000;
  const limit = Math.floor(0x100000000 / codeCount) * codeCount;
  let number;
  do {
    number = parseInt(Utilities.getUuid().slice(0, 8), 16);
  } while (number >= limit);
  return String(number % codeCount).padStart(6, "0");
}

function readTeacherAuthCache_(cache, key) {
  const value = cache.get(key);
  return value ? JSON.parse(value) : null;
}

function otpAttemptsError_(challenge, now) {
  return teacherAuthError_(
    "OTP_ATTEMPTS_EXHAUSTED", "Đã hết số lần thử. Hãy chờ rồi yêu cầu mã mới.",
    Math.ceil((challenge.expiresAt - now) / 1000)
  );
}

function reserveTeacherOtpSend_(properties, addressDigest, now) {
  const windowMs = TEACHER_OTP_SEND_WINDOW_SECONDS * 1000;
  const recent = JSON.parse(properties.getProperty(TEACHER_OTP_SEND_LOG_PROPERTY) || "[]")
    .filter(function(entry) { return entry[1] > now - windowMs; });
  const emailSends = recent.filter(function(entry) { return entry[0] === addressDigest; });
  const lastSend = emailSends[emailSends.length - 1];
  const nextAllowed = Math.max(
    lastSend ? lastSend[1] + TEACHER_OTP_SEND_COOLDOWN_SECONDS * 1000 : 0,
    emailSends.length >= TEACHER_OTP_SENDS_PER_EMAIL ? emailSends[0][1] + windowMs : 0,
    recent.length >= TEACHER_OTP_SENDS_PER_SCRIPT ? recent[0][1] + windowMs : 0
  );
  if (nextAllowed > now) {
    throw teacherAuthError_("OTP_SEND_LIMIT", "Đã đạt giới hạn gửi mã. Vui lòng thử lại sau.", Math.ceil((nextAllowed - now) / 1000));
  }
  recent.push([addressDigest, now]);
  properties.setProperty(TEACHER_OTP_SEND_LOG_PROPERTY, JSON.stringify(recent));
}

function teacherOtpKey_(email) {
  return TEACHER_OTP_PROPERTY_PREFIX + teacherAuthDigest_(email);
}

function readTeacherOtpState_(properties, key) {
  return JSON.parse(properties.getProperty(key) || "{}");
}

function pruneTeacherOtpStates_(properties, now) {
  const states = properties.getProperties();
  Object.keys(states).forEach(function(key) {
    if (!key.startsWith(TEACHER_OTP_PROPERTY_PREFIX)) return;
    const state = JSON.parse(states[key]);
    if (!(state.active?.expiresAt > now) && !(state.pending?.expiresAt > now)) {
      properties.deleteProperty(key);
    }
  });
}

function otpSendInProgressError_() {
  return teacherAuthError_("OTP_SEND_IN_PROGRESS", "Đang gửi mã OTP. Vui lòng chờ gửi xong rồi thử lại.");
}

function sendTeacherOtp_(value) {
  const email = normalizeTeacherEmail_(value);
  const properties = PropertiesService.getScriptProperties();
  const otpKey = teacherOtpKey_(email);
  const addressDigest = teacherAuthDigest_(email.replace(/\+[^@]*(?=@)/, ""));
  const code = generateTeacherOtp_();
  const nonce = Utilities.getUuid();
  withTeacherAuthLock_(function() {
    const now = Date.now();
    const state = readTeacherOtpState_(properties, otpKey);
    if (state.pending?.expiresAt > now) throw otpSendInProgressError_();
    const current = state.active;
    if (current && current.expiresAt > now && current.attempts >= TEACHER_OTP_MAX_ATTEMPTS) {
      throw otpAttemptsError_(current, now);
    }
    reserveTeacherOtpSend_(properties, addressDigest, now);
    pruneTeacherOtpStates_(properties, now);
    properties.setProperty(otpKey, JSON.stringify({
      active: current?.expiresAt > now ? current : null,
      pending: { nonce: nonce, expiresAt: now + TEACHER_OTP_TTL_SECONDS * 1000 }
    }));
  });

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

  let mailSent = false;
  try {
    MailApp.sendEmail({
      to: email,
      subject: "[FSchool Event Pass] Mã OTP xác thực Giáo viên",
      body: "Mã xác thực của bạn là " + code + ". Mã có hiệu lực trong 5 phút.",
      htmlBody: htmlBody,
      name: "FSchool Event Pass"
    });
    mailSent = true;
  } catch {
    // Finalize this reservation without exposing the mail provider error.
  }
  withTeacherAuthLock_(function() {
    const state = readTeacherOtpState_(properties, otpKey);
    const now = Date.now();
    if (state.pending?.nonce !== nonce) {
      if (mailSent) throw teacherAuthError_("OTP_REPLACED", "Yêu cầu gửi mã đã được thay thế. Vui lòng dùng mã mới nhất.");
      return;
    }
    if (!mailSent) {
      if (state.active?.expiresAt > now) {
        properties.setProperty(otpKey, JSON.stringify({ active: state.active }));
      } else {
        properties.deleteProperty(otpKey);
      }
      return;
    }
    properties.setProperty(otpKey, JSON.stringify({ active: {
      digest: teacherAuthDigest_(nonce + ":" + code), nonce: nonce, attempts: 0,
      expiresAt: now + TEACHER_OTP_TTL_SECONDS * 1000
    } }));
  });
  if (!mailSent) throw teacherAuthError_("OTP_MAIL_FAILED", "Không gửi được email mới. Mã trước đó vẫn dùng được nếu còn hiệu lực.");
  return { success: true, status: "ok", expiresInSeconds: TEACHER_OTP_TTL_SECONDS };
}

function verifyTeacherLogin_(emailValue, otpValue) {
  const email = normalizeTeacherEmail_(emailValue);
  const otp = typeof otpValue === "string" ? otpValue.replace(/[\s\u200B-\u200F\u2060]/g, "") : "";
  const cache = CacheService.getScriptCache();
  const properties = PropertiesService.getScriptProperties();
  const otpKey = teacherOtpKey_(email);
  return withTeacherAuthLock_(function() {
    const now = Date.now();
    const state = readTeacherOtpState_(properties, otpKey);
    if (state.pending?.expiresAt > now) throw otpSendInProgressError_();
    const challenge = state.active;
    if (!challenge || !challenge.digest) {
      throw teacherAuthError_("OTP_INVALID", "Mã OTP không đúng hoặc đã được sử dụng.");
    }
    if (challenge.expiresAt <= now) {
      throw teacherAuthError_("OTP_EXPIRED", "Mã OTP đã hết hạn. Hãy yêu cầu mã mới.");
    }
    if (challenge.attempts >= TEACHER_OTP_MAX_ATTEMPTS) throw otpAttemptsError_(challenge, now);
    if (!/^\d{6}$/.test(otp) || teacherAuthDigest_(challenge.nonce + ":" + otp) !== challenge.digest) {
      challenge.attempts++;
      properties.setProperty(otpKey, JSON.stringify({ active: challenge }));
      if (challenge.attempts >= TEACHER_OTP_MAX_ATTEMPTS) throw otpAttemptsError_(challenge, now);
      throw teacherAuthError_("OTP_INVALID", "Mã OTP không đúng. Hãy nhập mã trong email mới nhất.");
    }

    const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "");
    const key = teacherSessionKey_(token);
    const value = JSON.stringify({
      email: email, expiresAt: now + TEACHER_SESSION_TTL_SECONDS * 1000
    });
    try {
      cache.put(key, value, TEACHER_SESSION_TTL_SECONDS);
      if (cache.get(key) !== value) throw new Error();
    } catch {
      throw teacherAuthError_("SESSION_CREATE_FAILED", "Máy chủ chưa lưu được phiên. Hãy xác minh lại bằng mã còn hạn.");
    }
    properties.deleteProperty(otpKey);
    return { success: true, status: "ok", email: email, token: token, expiresInSeconds: TEACHER_SESSION_TTL_SECONDS };
  });
}

function teacherSessionKey_(token) {
  return typeof token === "string" && /^[0-9a-f]{64}$/i.test(token)
    ? "teacher-session:v2:" + teacherAuthDigest_(token) : "";
}

function requireTeacherSession_(body) {
  const key = teacherSessionKey_(body.authToken);
  const session = key ? readTeacherAuthCache_(CacheService.getScriptCache(), key) : null;
  if (!session || typeof session.email !== "string" || !TEACHER_EMAIL_PATTERN.test(session.email) ||
      !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) {
    throw teacherAuthError_("AUTH_REQUIRED", "Phiên giáo viên không hợp lệ hoặc đã hết hạn. Hãy đăng nhập lại.");
  }
  return session;
}

function revokeTeacherSession_(token) {
  const key = teacherSessionKey_(token);
  if (!key) return;
  withTeacherAuthLock_(function() {
    CacheService.getScriptCache().remove(key);
  });
}

function workflowRows_(sheet) {
  const lastRow = sheet.getLastRow();
  return lastRow < 2 ? [] : sheet.getRange(2, 1, lastRow - 1, 4).getValues();
}

function drawHistoryResetAt_(rows, eventId) {
  const marker = rows.find(function(row) {
    return row[0] === "drawHistory" && String(row[1]).trim() === "reset:" + eventId;
  });
  if (!marker) return 0;
  const data = parseWorkflowData_(marker);
  return Date.parse(data.resetAt || data.updatedAt || marker[2]) || 0;
}

function parseWorkflowData_(row) {
  try {
    return JSON.parse(String(row[3] || "{}"));
  } catch {
    throw new Error("Dữ liệu bản ghi hiện có không hợp lệ.");
  }
}
