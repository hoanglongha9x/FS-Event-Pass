const EVENT_PASS_VERSION = "event-pass-scoped-v1";
const EVENT_LEDGER = {
  years: ["SchoolYears", "Năm học"],
  roster: ["StudentRoster", "Năm học::Mã học sinh"],
  accounts: ["EventAccounts", "Sự kiện::Mã học sinh"],
  staff: ["EventStaff", "Sự kiện::Gian hàng::Email"]
};
const EVENT_ADMIN_PERMISSIONS = ["roster", "accounts", "events", "assignments", "draw", "stats", "queue"];
const STUDENT_ACCESS_VERSION = "student-event-access-v1";
const STUDENT_ACCESS_KEY = "FS_EVENT_STUDENT_ACCESS_KEY";
const STUDENT_LOGIN_WINDOW_MS = 30000;
const STUDENT_LOGIN_FAILURES = 60;
const STUDENT_SESSION_MS = 12 * 60 * 60 * 1000;
const STUDENT_ROSTER_MAX = 400;

function eventError_(code, message) {
  throw teacherAuthError_(code, message);
}

function eventId_(value) {
  const id = String(value || "");
  if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(id)) eventError_("INVALID_INPUT", "Mã sự kiện hoặc gian hàng không hợp lệ.");
  return id;
}

function studentCode_(value) {
  const code = String(value ?? "").normalize("NFKC").trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{3,19}$/.test(code)) eventError_("INVALID_INPUT", "Mã học sinh phải có từ 4 đến 20 ký tự hợp lệ.");
  return code;
}

function eventYear_(value) {
  const year = String(value || "").trim().replace(/[–—]/g, "-");
  if (!/^20\d{2}-20\d{2}$/.test(year) || Number(year.slice(5)) !== Number(year.slice(0, 4)) + 1) {
    eventError_("INVALID_INPUT", "Nhập năm học theo dạng 2026-2027.");
  }
  return year;
}

function ledgerSheet_(kind, create, book = workflowSpreadsheet_()) {
  const [name, keyLabel] = EVENT_LEDGER[kind];
  const existing = book.getSheetByName(name);
  if (existing || !create) return existing;
  const sheet = book.insertSheet(name);
  sheet.getRange(1, 1, 1, 2).setValues([[keyLabel, "Dữ liệu JSON"]]);
  sheet.setFrozenRows(1);
  return sheet;
}

function ledgerRows_(kind, book) {
  const sheet = ledgerSheet_(kind, false, book);
  const lastRow = sheet?.getLastRow() || 0;
  return lastRow < 2 ? [] : sheet.getRange(2, 1, lastRow - 1, 2).getValues()
    .flatMap(function(row, index) {
      if (kind === "staff" && row[0] === "" && row[1] === "") return [];
      if (kind === "staff" && !String(row[0]).trim()) throw new Error("Thiếu khóa phân công.");
      return [{ key: String(row[0]), row: index + 2, data: JSON.parse(String(row[1])) }];
    });
}

function ledgerEntry_(kind, key, book) {
  const sheet = ledgerSheet_(kind, false, book);
  const lastRow = sheet?.getLastRow() || 0;
  if (lastRow < 2) return null;
  const match = sheet.getRange(2, 1, lastRow - 1, 1).createTextFinder(key)
    .useRegularExpression(false).matchEntireCell(true).matchCase(true).findNext();
  if (!match) return null;
  const row = match.getRow();
  return { key: key, row: row, data: JSON.parse(String(sheet.getRange(row, 2).getValue())) };
}

function ledgerWrite_(kind, key, data, entry, book) {
  const sheet = ledgerSheet_(kind, true, book);
  const values = [key, JSON.stringify(data)];
  if (entry) sheet.getRange(entry.row, 1, 1, 2).setValues([values]);
  else sheet.appendRow(values);
}

function initEventPassTables_() {
  withTeacherAuthLock_(function() {
    Object.keys(EVENT_LEDGER).forEach(function(kind) { ledgerSheet_(kind, true); });
    workflowSheet_();
    SpreadsheetApp.flush();
  });
}

function eventWrite_(action, invalidateView) {
  return withTeacherAuthLock_(function() {
    try {
      return action();
    } finally {
      SpreadsheetApp.flush();
      if (invalidateView) invalidateEventView_();
    }
  });
}

function eventStaff_(body, book) {
  const session = requireTeacherSession_(body);
  const raw = PropertiesService.getScriptProperties().getProperty("FS_EVENT_ADMINS") || "{}";
  let grants;
  try {
    grants = JSON.parse(raw);
  } catch {
    throw teacherViewDependencyError_("ADMIN_GRANTS", "Cấu hình quyền BTC không hợp lệ.");
  }
  if (!grants || typeof grants !== "object" || Array.isArray(grants)) {
    throw teacherViewDependencyError_("ADMIN_GRANTS", "Cấu hình quyền BTC không hợp lệ.");
  }
  const assigned = Object.prototype.hasOwnProperty.call(grants, session.email) ? grants[session.email] : null;
  const permissions = Array.isArray(assigned) ? EVENT_ADMIN_PERMISSIONS.filter(function(permission) {
    return assigned.includes(permission);
  }) : [];
  let assignments;
  try {
    assignments = ledgerRows_("staff", book).map(function(row) { return row.data; }).filter(function(row) {
      return row.email === session.email && row.enabled === true && !row.deletedAt;
    });
  } catch (error) {
    if (error.teacherViewStage) throw error;
    throw teacherViewDependencyError_("STAFF_ASSIGNMENTS", "Không thể đọc phân công giáo viên.");
  }
  if (!permissions.length && !assignments.length) eventError_("FORBIDDEN", "Tài khoản chưa được BTC phân quyền.");
  return { email: session.email, role: permissions.length ? "ADMIN" : "TEACHER", permissions: permissions, assignments: assignments };
}

function requireEventPermission_(actor, permission) {
  if (!actor.permissions.includes(permission)) eventError_("FORBIDDEN", "Bạn không có quyền thực hiện thao tác này.");
}

function canManageBooth_(actor, eventId, boothId) {
  return actor.permissions.includes("queue") || actor.assignments.some(function(item) {
    return item.eventId === eventId && item.boothId === boothId;
  });
}

function activeSchoolYear_(book) {
  const active = ledgerRows_("years", book).find(function(row) { return row.data.status === "active"; });
  return active ? active.key : "";
}

function requireSchoolYear_(year, book) {
  const existing = ledgerEntry_("years", year, book);
  if (!existing || existing.data.status === "closed") eventError_("YEAR_UNAVAILABLE", "Năm học chưa có hoặc đã đóng.");
  return existing;
}

function manageSchoolYear_(actor, body) {
  requireEventPermission_(actor, "roster");
  const year = eventYear_(body.schoolYear);
  return eventWrite_(function() {
    const existing = ledgerEntry_("years", year);
    if (body.operation === "create") {
      if (existing) eventError_("CONFLICT", "Năm học đã tồn tại.");
      ledgerWrite_("years", year, { status: "open" });
    } else if (body.operation === "activate") {
      requireSchoolYear_(year);
      const sheet = ledgerSheet_("years", false);
      const rows = ledgerRows_("years").map(function(row) {
        const status = row.key === year ? "active" : row.data.status === "active" ? "open" : row.data.status;
        return [row.key, JSON.stringify({ status: status })];
      });
      sheet.getRange(2, 1, rows.length, 2).setValues(rows);
    } else if (body.operation === "close") {
      if (body.confirmed !== true) eventError_("INVALID_INPUT", "BTC cần xác nhận đã đối chiếu dữ liệu và ảnh hưởng đến phiên học sinh trước khi đóng năm.");
      const open = requireSchoolYear_(year);
      if (open.data.status === "active" && body.closeActiveConfirmed !== true) {
        eventError_("CONFLICT", "Đóng năm đang hoạt động sẽ dừng các phiên học sinh. BTC cần xác nhận riêng ảnh hưởng này hoặc chuyển năm hoạt động trước.");
      }
      ledgerWrite_("years", year, { status: "closed" }, open);
    } else {
      eventError_("INVALID_INPUT", "Thao tác năm học không hợp lệ.");
    }
    return { success: true };
  });
}

function rosterProfile_(value) {
  const code = studentCode_(value.code);
  const name = String(value.name || "").normalize("NFC").trim().replace(/\s+/g, " ");
  const className = String(value.className || "").normalize("NFKC").trim().replace(/\s+/g, "").toUpperCase();
  if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name)) eventError_("INVALID_INPUT", "Họ tên không hợp lệ.");
  if (!/^(?:10|11|12)[A-Z0-9][A-Z0-9._-]{0,15}$/.test(className)) eventError_("INVALID_INPUT", "Lớp phải bắt đầu bằng khối 10, 11 hoặc 12.");
  return { code: code, name: name, className: className, grade: className.slice(0, 2) };
}

function importRoster_(actor, body) {
  requireEventPermission_(actor, "roster");
  const year = eventYear_(body.schoolYear);
  if (!Array.isArray(body.rows) || body.rows.length < 1 || body.rows.length > STUDENT_ROSTER_MAX ||
      !["skip", "update"].includes(body.mode) || body.confirmed !== true) {
    eventError_("INVALID_INPUT", "Xác nhận danh sách và chế độ nhập hợp lệ.");
  }
  const seen = new Set();
  const profiles = body.rows.map(function(row) {
    const profile = rosterProfile_(row || {});
    if (seen.has(profile.code)) eventError_("CONFLICT", "Danh sách gửi lên có mã học sinh trùng.");
    seen.add(profile.code);
    return profile;
  });
  return eventWrite_(function() {
    requireSchoolYear_(year);
    const existing = ledgerRows_("roster").filter(function(row) { return row.key.startsWith(year + "::"); });
    const byKey = new Map(existing.map(function(row) { return [row.key, row]; }));
    const additions = profiles.filter(function(profile) { return !byKey.has(year + "::" + profile.code); });
    if (existing.length + additions.length > STUDENT_ROSTER_MAX) eventError_("LIMIT", "Mỗi năm học hỗ trợ tối đa 400 học sinh.");
    if (body.mode === "update" && body.expectedRevision !== rosterRevision_(existing)) {
      eventError_("CONFLICT", "Danh sách đã thay đổi. Hãy tải lại và xác nhận lại.");
    }
    const sheet = ledgerSheet_("roster", true);
    const changed = new Map();
    const rows = profiles.map(function(profile) {
      const key = year + "::" + profile.code;
      const entry = byKey.get(key);
      const data = { ...profile, schoolYear: year, updatedAt: new Date().toISOString() };
      if (entry && body.mode === "update") changed.set(entry.row, [key, JSON.stringify(data)]);
      return { entry: entry, values: [key, JSON.stringify(data)] };
    });
    writeLedgerEdits_(sheet, changed, rows.filter(function(row) { return !row.entry; }).map(function(row) { return row.values; }));
    return { success: true, added: additions.length, updated: changed.size, skipped: profiles.length - additions.length - changed.size };
  });
}

function writeLedgerEdits_(sheet, edits, additions) {
  const indexes = [...edits.keys()].sort(function(a, b) { return a - b; });
  let offset = 0;
  while (offset < indexes.length) {
    const start = indexes[offset];
    const values = [edits.get(start)];
    offset++;
    while (offset < indexes.length && indexes[offset] === start + values.length) {
      values.push(edits.get(indexes[offset++]));
    }
    sheet.getRange(start, 1, values.length, 2).setValues(values);
  }
  if (additions.length) {
    const first = sheet.getLastRow() + 1;
    const extra = first + additions.length - 1 - sheet.getMaxRows();
    if (extra > 0) sheet.insertRowsAfter(sheet.getMaxRows(), extra);
    sheet.getRange(first, 1, additions.length, 2).setValues(additions);
  }
}

function rosterRevision_(rows) {
  return teacherAuthDigest_(JSON.stringify(rows.map(function(row) { return [row.key, row.data]; })));
}

function listRoster_(actor, body) {
  if (!actor.permissions.includes("roster") && !actor.permissions.includes("accounts")) {
    eventError_("FORBIDDEN", "Bạn chưa có quyền xem danh sách học sinh.");
  }
  const book = workflowSpreadsheet_();
  const years = ledgerRows_("years", book).map(function(row) { return { id: row.key, status: row.data.status }; });
  const config = eventConfigFromRows_(readEventRows_());
  const year = body.schoolYear ? eventYear_(body.schoolYear) : (years.find(function(row) { return row.status === "active"; })?.id || "");
  const events = config.events.filter(function(event) { return event.schoolYear === year && !event.deletedAt; });
  const event = events.find(function(entry) { return entry.id === body.eventId; }) ||
    events.find(function(entry) { return entry.id === config.activeEventId; }) || events[0];
  const accounts = new Map(event ? ledgerRows_("accounts", book).filter(function(row) {
    return row.key.startsWith(event.id + "::");
  }).map(function(row) { return [row.key, row.data]; }) : []);
  const listed = year ? ledgerRows_("roster", book).filter(function(row) { return row.key.startsWith(year + "::"); }) : [];
  const properties = PropertiesService.getScriptProperties();
  const access = event ? studentAccessConfig_(properties, event.id) : null;
  const active = !!event && !event.archived && event.id === config.activeEventId &&
    years.some(function(entry) { return entry.id === year && entry.status === "active"; });
  const now = Date.now();
  const roster = listed.map(function(row) {
    const profile = row.data;
    const account = event ? accounts.get(event.id + "::" + profile.code) || {} : {};
    return {
      code: profile.code, name: profile.name, className: profile.className, grade: profile.grade,
      locked: account.locked === true, lastLoginAt: account.lastLoginAt || account.activatedAt || 0,
      sessionActive: active && studentSessionActive_(account, access, year, now)
    };
  });
  return { success: true, years: years, schoolYear: year, events: events, eventId: event?.id || "",
    schoolYearsRevision: typeof eventSchoolYearsRevision_ === "function" ? eventSchoolYearsRevision_(years) : "",
    activeEventId: config.activeEventId, revision: rosterRevision_(listed), roster: roster,
    studentAccess: actor.permissions.includes("accounts") && event ? studentAccessStatus_(access) : undefined };
}

function eventAccountContext_(eventId, rows, book) {
  const config = eventConfigFromRows_(rows);
  const event = config.events.find(function(item) { return item.id === eventId; });
  if (!event || event.deletedAt) eventError_("EVENT_UNAVAILABLE", "Sự kiện không khả dụng hoặc đã xóa mềm.");
  if (!event?.schoolYear) eventError_("EVENT_UNAVAILABLE", "Sự kiện chưa được gắn với năm học.");
  requireSchoolYear_(event.schoolYear, book);
  return { event: event, config: config };
}

function accountSummary_(account, operation, actor, now) {
  return {
    ...account,
    audit: [...(Array.isArray(account.audit) ? account.audit.slice(-29) : []), {
      action: operation, actor: actor, at: now
    }]
  };
}

function manageStudentAccounts_(actor, body) {
  requireEventPermission_(actor, "accounts");
  const eventId = eventId_(body.eventId);
  if (!Array.isArray(body.codes) || !body.codes.length || body.codes.length > STUDENT_ROSTER_MAX ||
      !["revoke", "lock", "unlock"].includes(body.operation)) {
    eventError_("INVALID_INPUT", "Chọn học sinh và thao tác hợp lệ.");
  }
  const codes = [...new Set(body.codes.map(studentCode_))];
  return eventWrite_(function() {
    const book = workflowSpreadsheet_();
    const { event } = eventAccountContext_(eventId, canonicalEventRows_(book), book);
    const allowed = new Set(ledgerRows_("roster", book).filter(function(row) {
      return row.key.startsWith(event.schoolYear + "::");
    }).map(function(row) { return row.data.code; }));
    const existing = new Map(ledgerRows_("accounts", book).filter(function(row) {
      return row.key.startsWith(eventId + "::");
    }).map(function(row) { return [row.key, row]; }));
    const now = Date.now();
    const edits = new Map(), additions = [];
    codes.forEach(function(code) {
      if (!allowed.has(code)) eventError_("INVALID_INPUT", "Học sinh nằm ngoài danh sách của năm học này.");
      const key = eventId + "::" + code, entry = existing.get(key);
      if (!entry && body.operation !== "lock") return;
      const account = accountSummary_(entry?.data || {}, body.operation, actor.email, now);
      if (body.operation !== "revoke") account.locked = body.operation === "lock";
      if (body.operation !== "unlock") {
        account.sessionHash = "";
        account.sessionExpiresAt = 0;
      }
      const values = [key, JSON.stringify(account)];
      if (entry) edits.set(entry.row, values);
      else additions.push(values);
    });
    if (edits.size || additions.length) writeLedgerEdits_(ledgerSheet_("accounts", true, book), edits, additions);
    return { success: true };
  });
}

function eventDigestMatches_(actual, expected) {
  if (typeof expected !== "string" || expected.length !== actual.length) return false;
  let different = 0;
  for (let index = 0; index < actual.length; index++) {
    different |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return different === 0;
}

function studentSessionDigest_(key, schoolYear, generation, token) {
  return teacherAuthDigest_(JSON.stringify([STUDENT_ACCESS_VERSION, key, schoolYear, generation, token]));
}

function studentAccessConfig_(properties, eventId) {
  const value = properties.getProperty("student-event-access:" + eventId);
  return value ? JSON.parse(value) : null;
}

function studentAccessStatus_(config) {
  return { configured: !!config, enabled: config?.enabled === true, updatedAt: config?.updatedAt || 0 };
}

function studentAccessConfigValid_(config) {
  return !!config && typeof config === "object" && !Array.isArray(config) &&
    typeof config.salt === "string" && config.salt.length >= 16 &&
    typeof config.digest === "string" && /^[A-Za-z0-9_-]{43}=?$/.test(config.digest) &&
    typeof config.generation === "string" && config.generation.length >= 16;
}

// Pure, safe metadata: never contains the shared code, hashes, or student data.
function studentLoginState_(config, activeYear, access, secret) {
  const event = config.events.find(function(item) { return item?.id === config.activeEventId; });
  let code = "READY";
  if (!event) code = "EVENT_MISSING";
  else if (event.deletedAt) code = "EVENT_DELETED";
  else if (event.archived === true) code = "EVENT_ARCHIVED";
  else if (!event.schoolYear) code = "EVENT_YEAR_MISSING";
  else if (!/^20\d{2}-20\d{2}$/.test(event.schoolYear) || Number(event.schoolYear.slice(5)) !== Number(event.schoolYear.slice(0, 4)) + 1) code = "EVENT_YEAR_INVALID";
  else if (activeYear !== event.schoolYear) code = "YEAR_NOT_ACTIVE";
  else if (!access) code = "ACCESS_NOT_CONFIGURED";
  else if (typeof secret !== "string" || secret.length < 32) code = "ACCESS_SECRET_MISSING";
  else if (!studentAccessConfigValid_(access)) code = "ACCESS_CONFIG_INVALID";
  else if (access.enabled !== true) code = "ACCESS_DISABLED";
  return { enabled: code === "READY", code: code };
}

function studentLoginAvailability_(config, book, activeYear) {
  if (!eventApiVersion_().success) return {enabled: false, code: "API_COMPONENTS_MISSING"};
  const properties = PropertiesService.getScriptProperties();
  let access;
  try { access = studentAccessConfig_(properties, config.activeEventId); }
  catch { return {enabled: false, code: "ACCESS_CONFIG_INVALID"}; }
  return studentLoginState_(config, activeYear === undefined ? activeSchoolYear_(book) : activeYear,
    access, properties.getProperty(STUDENT_ACCESS_KEY));
}

// Run manually in Apps Script Editor. Read-only; deliberately not an API action.
function diagnoseStudentLogin() {
  const report = { apiVersion: EVENT_PASS_VERSION, studentAccessVersion: STUDENT_ACCESS_VERSION,
    hasLoginStudent: typeof studentAuthRoutes_ === "function" && typeof studentAuthRoutes_().LOGIN_STUDENT === "function",
    apiReady: typeof eventApiVersion_ === "function" && eventApiVersion_().success === true,
    studentLoginEnabled: false, activeEvent: null, activeSchoolYear: "", events: [] };
  let stage = "SPREADSHEET_CONFIGURATION";
  try {
    const properties = PropertiesService.getScriptProperties();
    report.spreadsheetConfigured = !!properties.getProperty("FS_EVENT_SPREADSHEET_ID")?.trim();
    stage = "SPREADSHEET_READ";
    const book = workflowSpreadsheet_(), config = eventConfigFromRows_(canonicalEventRows_(book));
    report.activeSchoolYear = activeSchoolYear_(book);
    const active = config.events.find(function(event) { return event?.id === config.activeEventId; });
    report.activeEvent = active ? {id: active.id, name: active.name || "", schoolYear: active.schoolYear || ""} : null;
    stage = "STUDENT_CONFIGURATION";
    const roster = ledgerRows_("roster", book), secret = properties.getProperty(STUDENT_ACCESS_KEY);
    for (const event of config.events.filter(function(item) {
      return item && (item.id === config.activeEventId || /openday/i.test(String(item.name || "")));
    })) {
      let access = null, readable = true;
      try { access = studentAccessConfig_(properties, event.id); } catch { readable = false; }
      const state = event.id !== config.activeEventId ? {enabled: false, code: "EVENT_NOT_ACTIVE"} :
        !readable ? {enabled: false, code: "ACCESS_CONFIG_INVALID"} : studentLoginState_(config, report.activeSchoolYear, access, secret);
      const entry = { eventId: event.id, name: event.name || "", schoolYear: event.schoolYear || "",
        active: event.id === config.activeEventId, archived: event.archived === true,
        schoolYearActive: !!event.schoolYear && event.schoolYear === report.activeSchoolYear,
        rosterPresent: !!event.schoolYear && roster.some(function(row) {
          return row.key.startsWith(event.schoolYear + "::") && row.data.schoolYear === event.schoolYear;
        }),
        accessConfigured: !!access, accessEnabled: access?.enabled === true,
        accessConfigValid: readable && studentAccessConfigValid_(access), secretConfigured: typeof secret === "string" && secret.length >= 32,
        studentLoginEnabled: report.apiReady && state.enabled, state: state.code };
      entry.configurationIssues = [!report.apiReady ? "API_COMPONENTS_MISSING" : "", state.enabled ? "" : state.code,
        entry.rosterPresent ? "" : "ROSTER_FOR_YEAR_MISSING"].filter(Boolean);
      report.events.push(entry);
      if (entry.active) report.studentLoginEnabled = entry.studentLoginEnabled;
    }
    report.opendayFound = report.events.some(function(event) { return /openday/i.test(String(event.name)); });
  } catch {
    report.failureStage = stage;
    report.code = "DIAGNOSTIC_UNAVAILABLE";
  }
  console.log(JSON.stringify(report));
  return report;
}

function studentAccessDigest_(eventId, salt, code, secret) {
  const value = JSON.stringify([STUDENT_ACCESS_VERSION, eventId, salt, code]);
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(value, secret, Utilities.Charset.UTF_8));
}

function validEventAccessCode_(code) {
  return typeof code === "string" && code.length >= 8 && code.length <= 64 &&
    !/[\s\u0000-\u001f\u007f]/.test(code);
}

function configureStudentAccess_(body) {
  const eventId = eventId_(body.eventId), op = body.operation;
  return withTeacherAuthLock_(function() {
    requireEventPermission_(eventStaff_(body), "accounts");
    if (!["set", "enable", "disable"].includes(op) || (op === "set" && !validEventAccessCode_(body.accessCode))) {
      eventError_("INVALID_INPUT", "Mã truy cập phải có 8–64 ký tự, không có khoảng trắng.");
    }
    const rows = canonicalEventRows_(), {event} = eventAccountContext_(eventId, rows);
    if (event.archived) eventError_("EVENT_UNAVAILABLE", "Sự kiện đã lưu trữ.");
    const properties = PropertiesService.getScriptProperties();
    let previous;
    try { previous = studentAccessConfig_(properties, eventId); }
    catch {
      if (op !== "set") eventError_("STUDENT_ACCESS_UNAVAILABLE", "Cấu hình mã truy cập bị lỗi. BTC cần Lưu mã trước khi bật đăng nhập.");
    }
    let config;
    if (op === "set") {
      let secret = properties.getProperty(STUDENT_ACCESS_KEY);
      if (typeof secret !== "string" || secret.length < 32) {
        secret = Utilities.getUuid() + Utilities.getUuid();
        properties.setProperty(STUDENT_ACCESS_KEY, secret);
      }
      const salt = Utilities.getUuid();
      config = {salt: salt, digest: studentAccessDigest_(eventId, salt, body.accessCode, secret), enabled: previous?.enabled === true};
    } else {
      if (!previous) eventError_("INVALID_INPUT", "Hãy thiết lập mã truy cập trước.");
      const enabled = op === "enable";
      const secret = properties.getProperty(STUDENT_ACCESS_KEY);
      if (enabled && (!studentAccessConfigValid_(previous) || typeof secret !== "string" || secret.length < 32)) {
        eventError_("STUDENT_ACCESS_UNAVAILABLE", "Cấu hình mã truy cập chưa hợp lệ. BTC cần Lưu mã trước khi bật đăng nhập.");
      }
      if (previous.enabled === enabled) return {success: true, studentAccess: studentAccessStatus_(previous)};
      config = {...previous, enabled: enabled};
    }
    config.generation = Utilities.getUuid();
    config.updatedAt = Date.now();
    properties.setProperty("student-event-access:" + eventId, JSON.stringify(config));
    properties.deleteProperty("student-login-limit:" + eventId);
    return { success: true, studentAccess: studentAccessStatus_(config) };
  });
}

function studentLoginError_(retryAfterSeconds) {
  throw teacherAuthError_("STUDENT_LOGIN_INVALID", "Không đăng nhập được. Kiểm tra mã học sinh và mã truy cập hoặc liên hệ BTC.", retryAfterSeconds);
}

function studentLoginFailures_(properties, key, now) {
  const state = JSON.parse(properties.getProperty(key) || "null");
  return state?.until > now ? state : {count: 0, until: now + STUDENT_LOGIN_WINDOW_MS};
}

function loginStudentWithEventAccess_(body) {
  if (body.studentAccessVersion !== STUDENT_ACCESS_VERSION) {
    eventError_("API_VERSION_MISMATCH", "Trang đăng nhập học sinh cần được cập nhật. Hãy tải lại trang hoặc báo BTC.");
  }
  const eventId = typeof body.eventId === "string" ? body.eventId : "";
  if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(eventId)) studentLoginError_();
  return withTeacherAuthLock_(function() {
    const properties = PropertiesService.getScriptProperties(), access = studentAccessConfig_(properties, eventId);
    if (access?.enabled !== true) studentLoginError_();
    const now = Date.now(), limitKey = "student-login-limit:" + eventId;
    const failures = studentLoginFailures_(properties, limitKey, now);
    if (failures.count >= STUDENT_LOGIN_FAILURES) studentLoginError_(Math.ceil((failures.until - now) / 1000));
    function fail() {
      failures.count++;
      properties.setProperty(limitKey, JSON.stringify(failures));
      studentLoginError_();
    }
    const secret = properties.getProperty(STUDENT_ACCESS_KEY);
    if (typeof secret !== "string" || secret.length < 32 || !studentAccessConfigValid_(access)) {
      eventError_("STUDENT_ACCESS_UNAVAILABLE", "BTC cần kiểm tra cấu hình đăng nhập học sinh.");
    }
    if (!validEventAccessCode_(body.accessCode) ||
        !eventDigestMatches_(studentAccessDigest_(eventId, access.salt, body.accessCode, secret), access.digest)) fail();

    const book = workflowSpreadsheet_(), config = eventConfigFromRows_(canonicalEventRows_(book));
    const event = config.activeEventId === eventId && config.events.find(function(item) { return item.id === eventId && !item.archived && !item.deletedAt; });
    if (!studentLoginState_(config, activeSchoolYear_(book), access, secret).enabled || !event) fail();
    const code = typeof body.code === "string" && body.code.length <= 64 ? body.code.normalize("NFKC").trim().toUpperCase() : "";
    if (!/^[A-Z0-9][A-Z0-9._-]{3,19}$/.test(code)) fail();
    const key = eventId + "::" + code;
    const profile = ledgerEntry_("roster", event.schoolYear + "::" + code, book)?.data;
    const entry = ledgerEntry_("accounts", key, book), account = entry?.data || {};
    if (!profile || profile.code !== code || profile.schoolYear !== event.schoolYear || account.locked) fail();

    const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "");
    account.sessionHash = studentSessionDigest_(key, event.schoolYear, access.generation, token);
    account.sessionExpiresAt = now + STUDENT_SESSION_MS;
    account.sessionSchoolYear = event.schoolYear;
    account.sessionAccessGeneration = access.generation;
    account.lastLoginAt = now;
    ledgerWrite_("accounts", key, account, entry, book);
    SpreadsheetApp.flush();
    return { success: true, studentAccessVersion: STUDENT_ACCESS_VERSION, profile: publicStudentProfile_(profile),
      eventId: eventId, token: token, expiresAt: account.sessionExpiresAt };
  });
}

function studentSessionActive_(account, access, schoolYear, now) {
  return access?.enabled === true && !account?.locked && !!account?.sessionHash &&
    account.sessionExpiresAt > now && account.sessionSchoolYear === schoolYear &&
    !!access.generation && account.sessionAccessGeneration === access.generation;
}

function publicStudentProfile_(profile) {
  return { code: profile.code, name: profile.name, className: profile.className, schoolYear: profile.schoolYear };
}

function requireStudentAccount_(body, book) {
  const session = body.studentSession || {};
  if (session.studentAccessVersion !== STUDENT_ACCESS_VERSION || typeof session.schoolYear !== "string" ||
      !/^20\d{2}-20\d{2}$/.test(session.schoolYear) || typeof session.token !== "string" || !/^[0-9a-f]{64}$/i.test(session.token) ||
      typeof session.eventId !== "string" || typeof session.code !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,119}$/.test(session.eventId) || !/^[A-Z0-9][A-Z0-9._-]{3,19}$/.test(session.code)) {
    eventError_("AUTH_REQUIRED", "Vui lòng đăng nhập lại bằng mã truy cập sự kiện.");
  }
  const key = session.eventId + "::" + session.code;
  if (!book) book = workflowSpreadsheet_();
  const entry = ledgerEntry_("accounts", key, book), account = entry?.data;
  const access = studentAccessConfig_(PropertiesService.getScriptProperties(), session.eventId);
  if (!studentSessionActive_(account, access, session.schoolYear, Date.now()) ||
      !eventDigestMatches_(studentSessionDigest_(key, session.schoolYear, access.generation, session.token), account.sessionHash)) {
    eventError_("AUTH_REQUIRED", "Phiên học sinh đã hết hiệu lực. Vui lòng đăng nhập lại.");
  }
  return { key: key, entry: entry, eventId: session.eventId, code: session.code, schoolYear: session.schoolYear, book: book };
}

function requireEventStudent_(body, rows, book) {
  const actor = requireStudentAccount_(body, book);
  const config = eventConfigFromRows_(rows);
  const event = config.events.find(function(entry) { return entry.id === actor.eventId && !entry.archived && !entry.deletedAt; });
  const activeYear = activeSchoolYear_(actor.book);
  if (!event?.schoolYear || actor.schoolYear !== event.schoolYear ||
      actor.eventId !== config.activeEventId || activeYear !== event.schoolYear) {
    eventError_("AUTH_REQUIRED", "Sự kiện hoặc năm học đã thay đổi. Vui lòng đăng nhập lại.");
  }
  const profile = ledgerEntry_("roster", event.schoolYear + "::" + actor.code, actor.book)?.data;
  if (profile?.code !== actor.code || profile.schoolYear !== actor.schoolYear) {
    eventError_("AUTH_REQUIRED", "Hồ sơ học sinh không còn hiệu lực.");
  }
  return { ...actor, profile: publicStudentProfile_(profile), role: "STUDENT", activeSchoolYear: activeYear };
}

function revokeStudent_(body) {
  return eventWrite_(function() {
    const actor = requireStudentAccount_(body);
    const account = actor.entry.data;
    account.sessionHash = "";
    account.sessionExpiresAt = 0;
    ledgerWrite_("accounts", actor.key, account, actor.entry, actor.book);
    return { success: true };
  });
}

function assignmentRevision_(assignments) {
  return teacherAuthDigest_(JSON.stringify(assignments));
}

function setEventAssignment_(actor, body) {
  requireEventPermission_(actor, "assignments");
  const email = normalizeTeacherEmail_(body.email), eventId = eventId_(body.eventId);
  const input = body.boothIds === undefined ? [body.boothId] : body.boothIds;
  if (!Array.isArray(input) || !input.length || input.length > 40) eventError_("INVALID_INPUT", "Chọn ít nhất một gian hàng hợp lệ.");
  const ids = input.map(eventId_);
  if (new Set(ids).size !== ids.length) eventError_("INVALID_INPUT", "Danh sách gian hàng bị trùng.");
  if (body.replace !== undefined && (typeof body.replace !== "boolean" || body.enabled !== true)) eventError_("INVALID_INPUT", "Thao tác chỉnh sửa phân công không hợp lệ.");
  if (typeof body.enabled !== "boolean") eventError_("INVALID_INPUT", "Chọn cấp hoặc thu hồi phân công.");
  const name = String(body.name || "").normalize("NFC").trim().replace(/\s+/g, " ");
  if (name.length > 80 || /[\u0000-\u001f]/.test(name)) eventError_("INVALID_INPUT", "Tên giáo viên không hợp lệ.");
  return eventWrite_(function() {
    requireEventPermission_(eventStaff_(body), "assignments");
    const rows = canonicalEventRows_();
    const {event} = eventAccountContext_(eventId, rows);
    const booths = new Set(eventBooths_(rows, eventId).map(function(booth) { return booth.id; }));
    if (body.enabled && (event.archived || ids.some(function(id) { return !booths.has(id); }))) {
      eventError_("INVALID_INPUT", "Gian hàng không còn trong cấu hình.");
    }
    const existing = ledgerRows_("staff"), changes = new Set(ids);
    if (body.expectedAssignmentRevision !== undefined && body.expectedAssignmentRevision !== assignmentRevision_(existing
      .map(function(row) { return row.data; }).filter(function(row) { return row.eventId === eventId && !row.deletedAt; }))) {
      eventError_("CONFLICT", "Phân công đã thay đổi. Nạp lại sự kiện trước khi cập nhật.");
    }
    if (body.replace === true) existing.forEach(function(row) {
      if (row.data.eventId === eventId && row.data.email === email && row.data.enabled) changes.add(row.data.boothId);
    });
    const byKey = new Map(existing.map(function(row) { return [row.key, row]; })), edits = new Map(), additions = [];
    for (const boothId of changes) {
      const key = eventId + "::" + boothId + "::" + email, prior = byKey.get(key);
      if (prior?.data.deletedAt && body.enabled !== true) eventError_("INVALID_INPUT", "Phân công đã được xóa mềm.");
      const now = new Date().toISOString();
      const enabled = body.replace === true ? ids.includes(boothId) : body.enabled;
      const data = { eventId: eventId, boothId: boothId, email: email, name: name || prior?.data.name || "",
        enabled: enabled, updatedAt: now, updatedBy: actor.email,
        audit: [...(Array.isArray(prior?.data.audit) ? prior.data.audit.slice(-29) : []),
          {operation: enabled ? "grant" : "revoke", at: now, actor: actor.email}] };
      if (prior) edits.set(prior.row, [key, JSON.stringify(data)]);
      else additions.push([key, JSON.stringify(data)]);
      byKey.set(key, {data: data});
    }
    writeLedgerEdits_(ledgerSheet_("staff", true), edits, additions);
    const assignments = [...byKey.values()].map(function(row) { return row.data; }).filter(function(row) { return row.eventId === eventId && !row.deletedAt; });
    return { success: true, eventId: eventId, assignments: assignments, assignmentRevision: assignmentRevision_(assignments) };
  });
}

function deleteEventAssignment_(body) {
  return eventWrite_(function() {
    const book = workflowSpreadsheet_(), actor = eventStaff_(body, book);
    requireEventPermission_(actor, "assignments");
    const eventId = eventId_(body.eventId), boothId = eventId_(body.boothId), email = normalizeTeacherEmail_(body.email);
    const event = eventConfigFromRows_(canonicalEventRows_(book)).events.find(function(item) { return item.id === eventId && !item.deletedAt; });
    if (!event || body.confirmed !== true) eventError_("INVALID_INPUT", "Chọn phân công và xác nhận xóa hợp lệ.");
    const existing = ledgerRows_("staff", book), visible = existing.map(function(row) { return row.data; })
      .filter(function(row) { return row.eventId === eventId && !row.deletedAt; });
    if (body.expectedAssignmentRevision !== assignmentRevision_(visible)) eventError_("CONFLICT", "Phân công đã thay đổi. Nạp lại sự kiện trước khi xóa.");
    const key = eventId + "::" + boothId + "::" + email, entry = existing.find(function(row) { return row.key === key; });
    if (!entry || entry.data.deletedAt) eventError_("INVALID_INPUT", "Phân công không tồn tại hoặc đã xóa mềm.");
    if (entry.data.eventId !== eventId || entry.data.boothId !== boothId || entry.data.email !== email) eventError_("INVALID_INPUT", "Dữ liệu phân công không khớp khóa lưu trữ; BTC cần đối chiếu trước khi xóa.");
    if (entry.data.enabled !== false) eventError_("ASSIGNMENT_ACTIVE", "Cần thu hồi phân công trước khi xóa.");
    const now = new Date().toISOString(), data = {...entry.data, enabled: false, deletedAt: now, deletedBy: actor.email, updatedAt: now, updatedBy: actor.email,
      audit: [...(Array.isArray(entry.data.audit) ? entry.data.audit.slice(-29) : []), {operation: "delete", at: now, actor: actor.email}]};
    ledgerWrite_("staff", key, data, entry, book);
    const assignments = visible.filter(function(row) { return row.email !== email || row.boothId !== boothId; });
    return {success: true, eventId: eventId, boothId: boothId, assignments: assignments,
      assignmentRevision: assignmentRevision_(assignments)};
  }, true);
}
