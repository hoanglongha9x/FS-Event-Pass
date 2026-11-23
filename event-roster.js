/* BTC roster and account controls. Authorization is enforced by Apps Script. */
let rosterDesk = null;
let rosterStudentCode = "";
let rosterFilePreview = null;
let rosterRequest = 0;
let rosterRead = null;
let assignmentRequest = 0;
let assignmentRead = null;
let rosterMutationBusy = false;

function deskOptions(entries, selected, emptyLabel) {
  const options = entries.map(entry => {
    const option = document.createElement("option");
    option.value = entry.value;
    option.textContent = entry.label;
    return option;
  });
  if (emptyLabel) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = emptyLabel;
    options.unshift(option);
  }
  return options;
}

function setDeskOptions(id, entries, selected, emptyLabel) {
  const select = $(id);
  select.replaceChildren(...deskOptions(entries, selected, emptyLabel));
  if ([...select.options].some(option => option.value === selected)) select.value = selected;
}

function clearRosterScreen() {
  rosterRequest++;
  rosterRead = null;
  assignmentRequest++;
  assignmentRead = null;
  rosterDesk = null;
  if(typeof resetEventAdministration==="function")resetEventAdministration();
  rosterStudentCode = "";
  clearRosterImport();
  $("rosterRows").replaceChildren();
  $("rosterDetail").replaceChildren();
  $("rosterTotals").textContent = "";
  $("rosterStatus").textContent = "";
  $("staffAssignmentList").replaceChildren();
  ["rosterEditCode", "rosterEditName", "rosterEditClass", "rosterSearch", "staffEmail"].forEach(id => { $(id).value = ""; });
  if ($("rosterEditor").open) $("rosterEditor").close();
  $("rosterStudentAccessInput").value = "";
  renderStudentAccessStatus();
}

function loadRoster(year = "", eventId = "", force = false) {
  if (!hasPermission("roster") && !hasPermission("accounts")) return;
  const user = currentUser;
  if (!force && rosterRead?.user === user && rosterRead.year === year && rosterRead.eventId === eventId) {
    return rosterRead.promise;
  }
  const ticket = ++rosterRequest;
  const promise = readRoster(year, eventId, user, ticket).finally(() => {
    if (rosterRead?.ticket === ticket) rosterRead = null;
  });
  rosterRead = {user, year, eventId, ticket, promise};
  return promise;
}

async function readRoster(year, eventId, user, ticket) {
  $("rosterStatus").textContent = "Đang tải danh sách…";
  try {
    const result = await eventCall("LIST_ROSTER", { schoolYear: year, eventId });
    if (ticket !== rosterRequest || user !== currentUser) return;
    if (!rosterDesk || rosterDesk.schoolYear !== result.schoolYear || rosterDesk.eventId !== result.eventId) {
      rosterStudentCode = "";
      $("rosterStudentAccessInput").value = "";
      clearRosterImport();
    }
    rosterDesk = result;
    if(typeof noteRosterLoaded==="function")noteRosterLoaded();
    if(typeof acknowledgeManagedYears==="function")acknowledgeManagedYears(result.years,result.schoolYearsRevision);
    renderConfigSchoolYears();
    setDeskOptions("rosterYear", result.years.map(item => ({
      value: item.id,
      label: item.id + (item.status === "active" ? " · Đang hoạt động" : item.status === "closed" ? " · Đã đóng" : "")
    })), result.schoolYear, result.years.length ? "" : "Chưa có năm học");
    setDeskOptions("rosterEvent", result.events.map(item => ({ value: item.id, label: item.name })), result.eventId,
      result.events.length ? "" : "Năm học chưa có sự kiện");
    const classes = [...new Set(result.roster.map(item => item.className))].sort();
    setDeskOptions("rosterClass", classes.map(value => ({ value, label: value })), $("rosterClass").value, "Mọi lớp");
    renderRosterTable();
    $("rosterStatus").textContent = "";
  } catch (error) {
    if (ticket === rosterRequest && user === currentUser) handleRosterError(error);
  }
}

function renderConfigSchoolYears(){
  const context=typeof managedYearContext==="function"?managedYearContext():rosterDesk;
  const valid=id=>/^20\d{2}-20\d{2}$/.test(id)&&Number(id.slice(5))===Number(id.slice(0,4))+1;
  const years=(context?.years||[]).filter(year=>valid(year.id)),event=EVENTS.find(item=>item.id===managedEventId());
  const choice=event?.schoolYear||eventAdminState.yearChoices.get(managedEventId())||years.find(year=>year.status==="active")?.id||"";
  setDeskOptions("configEventYear",years.map(year=>({value:year.id,label:year.id})),choice,"Chọn năm học");
  $("configEventYear").querySelectorAll("option").forEach(option=>{option.disabled=years.find(year=>year.id===option.value)?.status==="closed"});
  $("configEventYear").disabled=!context||!!event?.schoolYear||!hasPermission("events");
  const createChoice=$("newEventYear").value||choice;
  setDeskOptions("newEventYear",years.filter(year=>year.status!=="closed").map(year=>({value:year.id,label:year.id})),createChoice,"Chọn năm học");
  if(typeof renderManagedActivationControls==="function")renderManagedActivationControls();
}

function visibleRoster() {
  const match = value => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/đ/g, "d");
  const query = match($("rosterSearch").value.trim());
  const grade = $("rosterGrade").value;
  const className = $("rosterClass").value;
  return (rosterDesk?.roster || []).filter(item => (!grade || item.grade === grade) &&
    (!className || item.className === className) && (!query || match(item.code + " " + item.name).includes(query)));
}

function rosterCell(row, value) {
  const cell = row.insertCell();
  cell.className = "p-2 align-middle";
  if (typeof value === "string") cell.textContent = value;
  else cell.append(value);
  return cell;
}

function renderRosterTable() {
  const roster = rosterDesk?.roster || [], visible = visibleRoster();
  const activated = roster.filter(student => student.lastLoginAt).length;
  $("rosterTotals").textContent = roster.length + " học sinh · " + activated + " đã đăng nhập · " +
    (roster.length - activated) + " chưa đăng nhập · " +
    ["10", "11", "12"].map(grade => "Khối " + grade + " " + roster.filter(item => item.grade === grade).length).join(" · ");
  const rows = document.createElement("tbody");
  const canEdit = hasPermission("roster");
  visible.forEach((item, index) => {
    const row = rows.insertRow();
    row.className = "border-t border-slate-100 hover:bg-blue-50/60";
    row.dataset.studentCode = item.code;
    row.classList.toggle("ui-row-selected", item.code === rosterStudentCode);
    [String(index + 1), item.code, item.name, item.className,
      item.locked ? "Đã khóa" : item.lastLoginAt ? "Đã đăng nhập" : "Chưa đăng nhập"].forEach(text => rosterCell(row, text));
    const select = document.createElement("button");
    select.type = "button";
    select.className = "rounded-lg bg-blue-50 px-2 py-1 font-bold text-blue-900";
    select.textContent = "Quản lý";
    select.addEventListener("click", () => {
      $("rosterRows").querySelector(".ui-row-selected")?.classList.remove("ui-row-selected");
      row.classList.add("ui-row-selected");
      rosterStudentCode = item.code; renderRosterDetail();
    });
    const actions = rosterCell(row, select);
    if (canEdit) {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "ml-1 rounded-lg bg-orange-50 px-2 py-1 font-bold text-orange-700";
      edit.textContent = "Sửa";
      edit.addEventListener("click", () => editRosterProfile(item));
      actions.append(edit);
    }
  });
  if (!visible.length) {
    const cell = rosterCell(rows.insertRow(), "Chưa có học sinh phù hợp.");
    cell.colSpan = 6;
  }
  $("rosterRows").replaceChildren(...rows.children);
  ["yearCreate","yearActivate","yearClose","rosterAdd"].forEach(id=>{$(id).hidden=!canEdit;});
  $("rosterAdd").disabled = !rosterDesk?.schoolYear;
  $("rosterFile").closest("label").hidden=!canEdit;
  $("rosterFile").disabled = !canEdit || !rosterDesk?.schoolYear;
  renderStudentAccessStatus();
  renderRosterDetail();
}

function renderRosterDetail() {
  const student = rosterDesk?.roster.find(item => item.code === rosterStudentCode);
  const detail = $("rosterDetail");
  detail.replaceChildren();
  if (!student) {
    detail.textContent = "Chọn học sinh trong danh sách để quản lý tài khoản.";
  } else {
    const event = rosterDesk.events.find(item => item.id === rosterDesk.eventId);
    const entries = [
      ["Mã học sinh", student.code], ["Họ và tên", student.name], ["Lớp", student.className], ["Năm học", rosterDesk.schoolYear],
      ["Trạng thái", student.locked ? "Đã khóa" : student.lastLoginAt ? "Đã đăng nhập" : "Chưa đăng nhập"],
      ["Sự kiện", event?.name || "Chưa chọn"],
      ["Phiên", student.sessionActive ? "Còn hiệu lực" : "Không có phiên hoạt động"]
    ];
    if (student.lastLoginAt) entries.push(["Lần đăng nhập gần nhất", new Date(student.lastLoginAt).toLocaleString("vi-VN")]);
    for (const [label, value] of entries) {
      const paragraph = document.createElement("p");
      paragraph.textContent = label + " · " + value;
      detail.append(paragraph);
    }
    $("rosterLock").textContent = student.locked ? "Mở khóa tài khoản" : "Khóa tài khoản";
    $("rosterRevokeSession").disabled = !student.sessionActive;
  }
  $("rosterAccountActions").hidden = !student || !rosterDesk?.eventId || !hasPermission("accounts");
}

function editRosterProfile(student) {
  if (!rosterDesk?.schoolYear || !hasPermission("roster")) return;
  $("rosterEditCode").value = student?.code || "";
  $("rosterEditCode").readOnly = Boolean(student);
  $("rosterEditName").value = student?.name || "";
  $("rosterEditClass").value = student?.className || "";
  $("rosterEditor").showModal();
}

function clearRosterImport() {
  rosterFilePreview = null;
  $("rosterImportPreview").hidden = true;
  $("rosterImportUpdate").checked = false;
  $("rosterFile").value = "";
  $("rosterImportRows").replaceChildren();
  $("rosterImportSummary").textContent = "";
  $("rosterImportImpact").textContent = "";
}

async function previewRosterFile(file) {
  clearRosterImport();
  if (!file || !rosterDesk?.schoolYear || !hasPermission("roster")) return;
  const desk = rosterDesk, user = currentUser;
  try {
    const rows = await readRosterFile(file);
    if (desk !== rosterDesk || user !== currentUser) return;
    const preview = rosterImportPreview(rows, new Set(desk.roster.map(item => item.code)));
    const invalid = preview.filter(item => item.error).length;
    const duplicates = preview.filter(item => item.duplicate).length;
    rosterFilePreview = { items: preview, revision: desk.revision, schoolYear: desk.schoolYear };
    $("rosterImportSummary").textContent = (preview.length - invalid) + " hợp lệ · " + invalid + " lỗi · " + duplicates + " trùng";
    for (const item of preview) {
      const line = document.createElement("div");
      line.className = item.error ? "p-1 text-rose-700" : "p-1 text-slate-700";
      line.textContent = "Dòng " + item.sourceRow + " · " + item.profile.code + " · " + item.profile.name + " · " +
        item.profile.className + (item.error ? " · " + item.error : item.duplicate ? " · Đã có" : "");
      $("rosterImportRows").append(line);
    }
    renderRosterImportImpact();
    $("rosterImportConfirm").disabled = invalid === preview.length;
    $("rosterImportPreview").hidden = false;
  } catch (error) {
    if (user === currentUser) handleRosterError(error);
  }
}

function renderRosterImportImpact() {
  if (!rosterFilePreview || !rosterDesk) return;
  const items = rosterFilePreview.items.filter(item => !item.error);
  const existing = new Set(rosterDesk.roster.map(item => item.code));
  const fileCodes = new Set(rosterFilePreview.items.map(item => item.profile.code));
  const added = items.filter(item => !existing.has(item.profile.code)).length;
  const matches = items.length - added;
  const absent = rosterDesk.roster.filter(item => !fileCodes.has(item.code)).length;
  $("rosterImportImpact").textContent = "Năm đích " + rosterFilePreview.schoolYear + " · Thêm " + added +
    ($("rosterImportUpdate").checked ? " · Cập nhật " + matches : " · Giữ nguyên " + matches + " hồ sơ đã có") +
    " · " + absent + " học sinh vắng khỏi file được giữ lại.";
}

function handleRosterError(error) {
  if (error.code === "AUTH_REQUIRED") clearCurrentSession();
  else $("rosterStatus").textContent = error.message;
  showToast(error.message, "circle-alert", "error");
}

async function mutateRoster(action, payload, done) {
  if (rosterMutationBusy) return;
  const user = currentUser;
  const feedback = window.FSchoolUi.begin();
  rosterMutationBusy = true;
  $("rosterStatus").textContent = "Đang xử lý…";
  try {
    const result = await eventCall(action, payload);
    window.FSchoolUi.end(feedback, "success");
    if (user !== currentUser) return;
    await done(result);
  } catch (error) {
    window.FSchoolUi.end(feedback, "error");
    if (user === currentUser) handleRosterError(error);
  } finally {
    window.FSchoolUi.end(feedback);
    rosterMutationBusy = false;
    if (user === currentUser && $("rosterStatus").textContent === "Đang xử lý…") $("rosterStatus").textContent = "";
  }
}

async function manageDeskYear(operation) {
  const schoolYear = operation === "create" ? prompt("Năm học theo dạng 2026-2027") : rosterDesk?.schoolYear;
  if (!schoolYear) return;
  if (operation === "close" && !confirm("Đóng năm học " + schoolYear +
    "? BTC xác nhận đã đối chiếu kết quả gian hàng, hàng chờ, quay thưởng và lưu bản sao dữ liệu quan trọng. " +
    "Phiên học sinh thuộc năm này sẽ không truy cập được. Dữ liệu lịch sử và phân công được giữ lại.")) return;
  if (operation === "activate" && !confirm("Chuyển năm học hoạt động? Phiên của năm học khác sẽ không còn truy cập.")) return;
  await mutateRoster("MANAGE_YEAR", { operation, schoolYear, confirmed: operation === "close",
    closeActiveConfirmed:operation==="close"&&rosterDesk?.years.some(item=>item.id===schoolYear&&item.status==="active") }, async () => {
    await loadRoster(schoolYear, "", true);
    renderConfigSchoolYears(schoolYear);
    if (operation !== "create") await refreshEventNow();
    showToast("Đã cập nhật năm học.", "check");
  });
}

function renderStudentAccessStatus() {
  const access = rosterDesk?.studentAccess, form = $("rosterStudentAccessForm");
  form.hidden = !access || !hasPermission("accounts");
  if (form.hidden) return;
  $("rosterStudentAccessStatus").textContent = !access.configured ? "Chưa thiết lập mã." :
    (access.enabled ? "Đăng nhập đang bật." : "Đăng nhập đang tắt.") +
    (access.updatedAt ? " Cập nhật " + new Date(access.updatedAt).toLocaleString("vi-VN") + "." : "");
  const toggle = $("rosterStudentAccessToggle");
  toggle.textContent = access.enabled ? "Tắt đăng nhập" : "Bật đăng nhập";
  toggle.disabled = !access.configured;
}

async function configureDeskStudentAccess(operation) {
  const {schoolYear,eventId,studentAccess} = rosterDesk || {};
  if (!eventId || !studentAccess || !hasPermission("accounts") || rosterMutationBusy) return;
  const input = $("rosterStudentAccessInput"), accessCode = input.value;
  if (operation === "set" && studentAccess.configured && !confirm("Đổi mã sẽ thu hồi các phiên học sinh của sự kiện này. Tiếp tục?")) return;
  if (operation === "disable" && !confirm("Tắt đăng nhập sẽ thu hồi các phiên học sinh của sự kiện này. Tiếp tục?")) return;
  input.value = "";
  await mutateRoster("CONFIGURE_STUDENT_ACCESS", {eventId,operation,...(operation === "set" ? {accessCode} : {})}, async result => {
    if (rosterDesk?.eventId === eventId) {
      rosterDesk.studentAccess = result.studentAccess;
      renderStudentAccessStatus();
      await loadRoster(schoolYear,eventId,true);
    }
    showToast("Đã cập nhật đăng nhập học sinh.", "check");
  });
}

async function manageDeskAccount(operation, code) {
  const {schoolYear,eventId} = rosterDesk || {};
  if (!eventId || !code || !hasPermission("accounts")) return;
  if (operation === "lock" && !confirm("Khóa tài khoản và thu hồi phiên hiện có?")) return;
  if (operation === "revoke" && !confirm("Thu hồi phiên học sinh đang hoạt động?")) return;
  await mutateRoster("MANAGE_STUDENT_ACCOUNTS", {operation,codes:[code],eventId}, async () => {
    if (rosterDesk?.eventId === eventId) await loadRoster(schoolYear,eventId,true);
    showToast("Đã cập nhật tài khoản.", "check");
  });
}

function loadStaffAssignments(eventId) {
  const user = currentUser;
  if (assignmentRead?.user === user && assignmentRead.eventId === eventId) return assignmentRead.promise;
  const seq = ++assignmentRequest;
  const promise = readStaffAssignments(eventId, user, seq).finally(() => {
    if (assignmentRead?.seq === seq) assignmentRead = null;
  });
  assignmentRead = {user, eventId, seq, promise};
  return promise;
}

async function readStaffAssignments(eventId, user, seq) {
  const panel = $("staffAssignmentList");
  panel.replaceChildren();
  if (!hasPermission("assignments") || !eventId) return;
  try {
    const result = await eventCall("LIST_EVENT_ASSIGNMENTS", { eventId });
    if (seq !== assignmentRequest || user !== currentUser) return;
    for (const row of result.assignments) {
      const line = document.createElement("div");
      line.className = "flex items-center justify-between gap-2 rounded-xl bg-slate-50 p-2";
      const label = document.createElement("span");
      label.textContent = row.email + " · " + (getBooth(row.boothId)?.name || row.boothId);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "shrink-0 rounded-lg bg-rose-50 px-2 py-1 font-bold text-rose-700";
      remove.textContent = "Thu hồi";
      remove.addEventListener("click", () => {
        if (confirm("Thu hồi phân công này?")) {
          void mutateRoster("SET_EVENT_ASSIGNMENT", { email: row.email, eventId, boothId: row.boothId, enabled: false },
            () => loadStaffAssignments(eventId));
        }
      });
      line.append(label, remove);
      panel.append(line);
    }
  } catch (error) { if (user === currentUser && seq === assignmentRequest) handleRosterError(error); }
}

function openRosterScreen() {
  if (hasPermission("roster") || hasPermission("accounts")) void loadRoster(rosterDesk?.schoolYear, rosterDesk?.eventId,true);
}

function initializeRosterScreen() {
  const on = (id, type, handler) => $(id).addEventListener(type, handler);
  ["rosterSearch", "rosterGrade", "rosterClass"].forEach(id => on(id, "input", renderRosterTable));
  on("eventArchiveButton", "click", openEventArchive);
  on("eventArchiveForm", "submit", event => void renderEventArchive(event));
  on("eventArchiveClose", "click", clearArchiveScreen);
  on("eventArchiveDialog", "close", () => $("eventArchiveData").replaceChildren());
  on("rosterYear", "change", () => void loadRoster($("rosterYear").value));
  on("rosterEvent", "change", () => void loadRoster($("rosterYear").value, $("rosterEvent").value));
  on("rosterRefresh", "click", openRosterScreen);
  [["yearCreate", "create"], ["yearActivate", "activate"], ["yearClose", "close"]].forEach(([id, operation]) =>
    on(id, "click", () => void manageDeskYear(operation)));
  on("rosterAdd", "click", () => editRosterProfile());
  on("rosterEditCancel", "click", () => $("rosterEditor").close());
  on("rosterEditorForm", "submit", event => {
    event.preventDefault();
    if (!rosterDesk) return;
    const desk = rosterDesk;
    const row = {code:$("rosterEditCode").value, name:$("rosterEditName").value, className:$("rosterEditClass").value};
    void mutateRoster("SAVE_ROSTER", {schoolYear:desk.schoolYear, expectedRevision:desk.revision, rows:[row], confirmed:true,
      mode:$("rosterEditCode").readOnly ? "update" : "skip"}, async result => {
      if (!result.added && !result.updated) { showToast("Mã học sinh đã có trong danh sách.", "triangle-alert"); return; }
      $("rosterEditor").close();
      await loadRoster(desk.schoolYear, desk.eventId, true);
    });
  });
  on("rosterFile", "change", event => void previewRosterFile(event.target.files[0]));
  on("rosterImportCancel", "click", clearRosterImport);
  on("rosterImportUpdate", "change", renderRosterImportImpact);
  on("rosterImportConfirm", "click", () => {
    const preview = rosterFilePreview, desk = rosterDesk;
    if (!preview || !desk || preview.schoolYear !== desk.schoolYear || preview.revision !== desk.revision) {
      showToast("Danh sách đã thay đổi. Hãy xem trước tệp lại.", "triangle-alert"); return;
    }
    const rows = preview.items.filter(item => !item.error).map(item => item.profile);
    if (!rows.length || !confirm("Nhập các dòng hợp lệ vào năm " + preview.schoolYear + "? Hồ sơ vắng khỏi file được giữ lại.")) return;
    void mutateRoster("SAVE_ROSTER", {schoolYear:desk.schoolYear, rows, expectedRevision:preview.revision, confirmed:true,
      mode:$("rosterImportUpdate").checked ? "update" : "skip"}, async result => {
      clearRosterImport();
      await loadRoster(desk.schoolYear, desk.eventId, true);
      showToast("Đã thêm " + result.added + " · cập nhật " + result.updated + " · bỏ qua " + result.skipped + ".", "check");
    });
  });
  on("rosterStudentAccessForm", "submit", event => {
    event.preventDefault();
    void configureDeskStudentAccess("set");
  });
  on("rosterStudentAccessToggle", "click", () =>
    void configureDeskStudentAccess(rosterDesk?.studentAccess?.enabled ? "disable" : "enable"));
  on("rosterRevokeSession", "click", () => void manageDeskAccount("revoke", rosterStudentCode));
  on("rosterLock", "click", () => {
    const student = rosterDesk?.roster.find(item => item.code === rosterStudentCode);
    if (student) void manageDeskAccount(student.locked ? "unlock" : "lock", student.code);
  });

}

function clearArchiveScreen() {
  $("eventArchiveData").replaceChildren();
  if ($("eventArchiveDialog").open) $("eventArchiveDialog").close();
}

function openEventArchive() {
  if (!hasPermission("stats") && !hasPermission("draw")) return;
  setDeskOptions("eventArchiveSelect", EVENTS.map(event => ({
    value:event.id, label:event.name + (event.schoolYear ? " · " + event.schoolYear : "")
  })), activeEvent().id, "Chọn sự kiện");
  $("eventArchiveData").replaceChildren();
  $("eventArchiveDialog").showModal();
}

async function renderEventArchive(event) {
  event.preventDefault();
  const user = currentUser, eventId = $("eventArchiveSelect").value, target = $("eventArchiveData");
  if (!eventId) return;
  target.textContent = "Đang tải lịch sử…";
  try {
    const { stats, draws } = await eventCall("GET_EVENT_ARCHIVE", {eventId});
    if (user !== currentUser || !$("eventArchiveDialog").open || eventId !== $("eventArchiveSelect").value) return;
    target.replaceChildren();
    const line = text => {
      const paragraph = document.createElement("p");
      paragraph.className = "rounded-lg bg-slate-50 p-2";
      paragraph.textContent = text;
      target.append(paragraph);
    };
    if (stats) {
      line(stats.participants + " học sinh · " + stats.total + " lượt ghi nhận");
      stats.booths.forEach(item => line(item.name + " · " + item.completed + " hoàn thành · " + item.votes +
        " phiếu · " + (item.ratingAverage===null ? "Chưa chấm điểm" : item.ratingAverage.toFixed(1) + " ★")));
    }
    if (draws) {
      line("Kết quả quay đã lưu · " + draws.length);
      draws.forEach(item => line([item.winningNumber,item.winnerName,item.className,new Date(item.drawAt).toLocaleString("vi-VN")].join(" · ")));
    }
  } catch (error) {
    if (user === currentUser) target.textContent = error.message;
  }
}
