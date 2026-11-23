"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const vm = require("node:vm");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const source = file => fs.readFileSync(path.join(root, file), "utf8");
const backend = ["Code.gs", "EventAccess.gs", "EventWorkflow.gs", "EventImages.gs"].map(file =>
  new vm.Script(source(file), { filename: file }));
const admin = "fixture.admin@fpt.edu.vn";
const supervisor = "fixture.teacher@fpt.edu.vn";
const unassigned = "fixture.other@fe.edu.vn";
const actorA = "FA0001", actorB = "FA0002";
const year = "2026-2027", eventId = "fixture-event-a";
const studentAccessVersion = "student-event-access-v1";

function fakeAppsScript() {
  let clock = Date.UTC(2026, 10, 21, 1);
  let locked = false, contentionProbe = null;
  const cacheEntries = new Map(), sheets = new Map(), mail = [], logs = [];
  const imageFiles = new Map();
  function accountWriteProbe(name) {
    if (!contentionProbe || name !== "EventAccounts") return;
    const probe = contentionProbe;
    contentionProbe = null;
    probe();
  }
  const metrics = { workflowRangeReads: 0, writes: 0 };
  const props = new Map([
    ["FS_EVENT_SPREADSHEET_ID", "fixture-spreadsheet"],
    ["FS_EVENT_ADMINS", JSON.stringify({
      [admin]: ["roster", "accounts", "events", "assignments", "draw", "stats", "queue"],
      "fixture.stats@fpt.edu.vn": ["stats"]
    })]
  ]);
  const cache = {
    get(key) {
      const entry = cacheEntries.get(key);
      return entry && entry.expires > clock ? entry.value : null;
    },
    getAll(keys) { return Object.fromEntries(keys.filter(key => this.get(key) !== null).map(key => [key, this.get(key)])); },
    put(key, value, seconds) { cacheEntries.set(key, { value, expires: clock + seconds * 1000 }); },
    putAll(values, seconds) { for (const [key, value] of Object.entries(values)) this.put(key, value, seconds); },
    remove(key) { cacheEntries.delete(key); }
  };
  function makeSheet(name) {
    const rows = [];
    let maxRows = 1000;
    return {
      rows, name, getLastRow: () => rows.length, getMaxRows: () => maxRows, setFrozenRows() {},
      insertRowsAfter(_last, extra) { assert.equal(locked, true); maxRows += extra; },
      appendRow(values) { assert.equal(locked, true); metrics.writes++; accountWriteProbe(name); rows.push([...values]); },
      getRange(first, column, height = 1, width = 1) {
        return {
          getValue() { return rows[first - 1]?.[column - 1] ?? ""; },
          getValues() {
            if (name === "WorkflowState") metrics.workflowRangeReads++;
            return Array.from({length:height}, (_, offset) => Array.from({length:width}, (_, col) =>
              rows[first - 1 + offset]?.[column - 1 + col] ?? ""));
          },
          setValues(values) {
            assert.equal(locked, true, "all application writes happen under ScriptLock");
            assert.ok(first + height - 1 <= maxRows);
            metrics.writes++;
            accountWriteProbe(name);
            values.forEach((value, offset) => {
              rows[first - 1 + offset] ??= [];
              value.forEach((cell, col) => { rows[first - 1 + offset][column - 1 + col] = cell; });
            });
          },
          createTextFinder(key) {
            return {
              useRegularExpression() { return this; },
              matchEntireCell() { return this; },
              matchCase() { return this; },
              findNext() {
                const found = rows.findIndex((row, index) => index >= first - 1 &&
                  index < first - 1 + height && row[column - 1] === key);
                return found < 0 ? null : { getRow: () => found + 1 };
              }
            };
          }
        };
      }
    };
  }

  const book = {
    getSheetByName: name => sheets.get(name) ?? null,
    insertSheet(name) { assert.equal(locked, true); const sheet = makeSheet(name); sheets.set(name, sheet); return sheet; }
  };
  const context = vm.createContext({
    Date: class FixtureDate extends Date {
      constructor(...args) { super(...(args.length ? args : [clock])); }
      static now() { return clock; }
    },
    SpreadsheetApp: { openById(id) { assert.equal(id, "fixture-spreadsheet"); return book; }, flush() {} },
    LockService: { getScriptLock: () => ({
      waitLock() { if (locked) throw new Error("fixture lock contention"); locked = true; },
      releaseLock() { assert.equal(locked, true); locked = false; }
    }) },
    ContentService: { MimeType: { JSON: "JSON", JAVASCRIPT: "JS" },
      createTextOutput: value => ({ value, setMimeType(mime) { this.mime = mime; return this; } }) },
    CacheService: { getScriptCache: () => cache },
    DriveApp: {
      getFolderById(id) {
        assert.equal(id, "fixture-images");
        return { getId:()=>id, createFile(blob) {
          const key = "private-fixture-" + crypto.randomUUID();
          imageFiles.set(key, blob);
          return { getId: () => key, getBlob: () => blob };
        } };
      },
      getFileById(id) {
        if (!imageFiles.has(id)) throw new Error("Missing fixture file");
        return { getBlob: () => imageFiles.get(id) };
      }
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => props.get(key) ?? null,
      setProperty: (key, value) => { assert.equal(locked, true); props.set(key, value); },
      getProperties: () => Object.fromEntries(props),
      deleteProperty: key => props.delete(key)
    }) },
    Utilities: {
      getUuid: crypto.randomUUID,
      DigestAlgorithm: { SHA_256: "sha256" },
      computeDigest: (algorithm, text) => crypto.createHash(algorithm).update(text).digest(),
      Charset: { UTF_8: "utf8" },
      computeHmacSha256Signature: (value, key) => crypto.createHmac("sha256", key).update(value).digest(),
      base64EncodeWebSafe: bytes => Buffer.from(bytes).toString("base64url"),
      base64Decode: value => Array.from(Buffer.from(value, "base64")),
      base64Encode: bytes => Buffer.from(bytes).toString("base64"),
      newBlob: bytes => ({getBytes: () => bytes})
    },
    MailApp: { sendEmail(message) { mail.push(message); } },
    console: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) }
  });
  backend.forEach(script => script.runInContext(context));
  const post = (action, payload = {}) => JSON.parse(
    context.doPost({ postData: { contents: JSON.stringify({action, ...payload}) } }).value
  );
  const get = (query = {}) => context.doGet({ parameter: query });
  return {
    post, get, mail, logs, cache, metrics, sheets, context, imageFiles,
    seedTeacher(email) {
      const token = crypto.randomBytes(32).toString("hex");
      const key = vm.runInContext("teacherSessionKey_(" + JSON.stringify(token) + ")", context);
      cache.put(key, JSON.stringify({email, expiresAt: clock + 7 * 86400000}), 7 * 86400);
      return { authToken: token };
    },
    advance(ms) { clock += ms; },
    setProperty(key, value) { if (value === null) props.delete(key); else props.set(key, value); },
    onAccountWrite(probe) { contentionProbe = probe; },
    seedRows(name, rows) {
      const sheet = sheets.get(name) || makeSheet(name);
      sheets.set(name, sheet);
      sheet.rows.push(...rows);
    }
  };
}

function expectOk(response) {
  assert.equal(response.success, true, response.code || response.message);
  return response;
}
function expectDenied(response, code) {
  assert.equal(response.success, false);
  if (code) assert.equal(response.code, code);
  assert.ok(!response.records && !response.record && !response.token && !response.issued);
}

function assertTeacherDiagnostics(logs) {
  assert.ok(logs.length>0);
  for(const [line] of logs){
    const entry=JSON.parse(line);
    assert.deepEqual(Object.keys(entry).sort(),["action","at","code","elapsedMs","requestRef","stage","success"]);
    assert.match(entry.requestRef,/^[0-9a-f-]{36}$/i);
    assert.match(entry.action,/^[A-Z_0-9]+$/);
    assert.match(entry.stage,/^[A-Z_]+$/);
    assert.match(entry.code,/^[A-Z_]+$/);
    assert.equal(entry.success,false);
    assert.ok(Number.isFinite(Date.parse(entry.at))&&Number.isFinite(entry.elapsedMs)&&entry.elapsedMs>=0);
  }
}

function rosterRow(index) {
  return { code: "FA" + String(index).padStart(4, "0"), name: "Học sinh giả " + index, className: (10 + index % 3) + "A1" };
}
function setup(count = 3) {
  const cloud = fakeAppsScript(), btc = cloud.seedTeacher(admin);
  const teacher = cloud.seedTeacher(supervisor), nobody = cloud.seedTeacher(unassigned);
  for (const schoolYear of [year, "2027-2028", "2028-2029"]) {
    expectOk(cloud.post("MANAGE_YEAR", {...btc, operation:"create", schoolYear}));
  }
  expectOk(cloud.post("MANAGE_YEAR", {...btc, operation:"activate", schoolYear:year}));
  const events = [eventId,"fixture-event-b","fixture-event-c","fixture-event-d"].map((id, index) =>
    ({id, name:"Sự kiện giả " + (index + 1), date:"11/01", schoolYear:index === 3 ? "2027-2028" : year, published:index === 0}));
  expectOk(cloud.post("SAVE_EVENT_CONFIG", {...btc, config:{ activeEventId:eventId, events }}));
  expectOk(cloud.post("SAVE_ROSTER", {...btc, schoolYear:year, mode:"skip", confirmed:true,
    rows:Array.from({length:count},(_,index)=>rosterRow(index+1))}));
  expectOk(cloud.post("SET_EVENT_ASSIGNMENT",{...btc, email:supervisor, eventId, boothId:"robotics", enabled:true}));
  return { cloud, btc, teacher, nobody, events };
}
function studentLogins(cloud, btc, codes, target = eventId) {
  const accessCode="Fixture@" + target;
  expectOk(cloud.post("CONFIGURE_STUDENT_ACCESS",{...btc,eventId:target,operation:"set",accessCode}));
  expectOk(cloud.post("CONFIGURE_STUDENT_ACCESS",{...btc,eventId:target,operation:"enable"}));
  return codes.map(code=>({code,accessCode}));
}
function redeem(cloud, item, target = eventId) {
  const reply = expectOk(cloud.post("LOGIN_STUDENT",{eventId:target,...item,studentAccessVersion}));
  return { studentSession: {eventId:target, code:item.code, schoolYear:reply.profile.schoolYear,
    token:reply.token, studentAccessVersion} };
}

test("năm học, danh sách 400 học sinh, nhập trùng và cập nhật có xác nhận", () => {
  const { cloud, btc, teacher, events } = setup(400);
  const first = expectOk(cloud.post("LIST_ROSTER", btc));
  assert.equal(first.years.length, 3);
  assert.equal(first.events.length, 3);
  assert.equal(first.roster.length, 400);
  const rows = [ {...rosterRow(1), name:"Hồ sơ giả đã sửa"} ];
  const skipped = expectOk(cloud.post("SAVE_ROSTER",{...btc,schoolYear:year,mode:"skip",confirmed:true,rows}));
  assert.equal(skipped.skipped, 1);
  const updated = expectOk(cloud.post("SAVE_ROSTER",{...btc,schoolYear:year,mode:"update",confirmed:true,expectedRevision:first.revision,rows}));
  assert.equal(updated.updated, 1);
  expectDenied(cloud.post("SAVE_ROSTER",{...btc,schoolYear:year,mode:"update",confirmed:true,expectedRevision:first.revision,rows}), "CONFLICT");
  expectDenied(cloud.post("SAVE_ROSTER",{...btc,schoolYear:year,mode:"skip",confirmed:true,rows:[rows[0],rows[0]]}),"CONFLICT");
  expectDenied(cloud.post("SAVE_ROSTER",{...btc,schoolYear:year,mode:"skip",confirmed:false,rows}),"INVALID_INPUT");
  expectDenied(cloud.post("SAVE_ROSTER",{...teacher,schoolYear:year,mode:"skip",confirmed:true,rows}),"FORBIDDEN");
  expectDenied(cloud.post("SAVE_ROSTER",{...btc,schoolYear:year,mode:"skip",confirmed:true,rows:[rosterRow(401)]}),"LIMIT");
  const [oldCode] = studentLogins(cloud, btc, [actorA]);
  const oldSession = redeem(cloud, oldCode);
  expectOk(cloud.post("MANAGE_YEAR",{...btc,operation:"activate",schoolYear:"2027-2028"}));
  expectDenied(cloud.post("GET_EVENT_VIEW", oldSession),"AUTH_REQUIRED");
  expectOk(cloud.post("SAVE_EVENT_CONFIG",{...btc,config:{activeEventId:events[3].id,events}}));
  expectOk(cloud.post("MANAGE_YEAR",{...btc,operation:"close",schoolYear:year,confirmed:true}));
  assert.equal(expectOk(cloud.post("LIST_ROSTER",{...btc,schoolYear:year})).roster.length,400);
  assert.equal(expectOk(cloud.post("LIST_ROSTER",btc)).roster.length,0);
});

test("mã chung đúng hoa thường, lỗi đồng nhất, giới hạn theo sự kiện và vòng đời phiên", () => {
  const {cloud,btc,teacher,events}=setup(395);
  const batch=studentLogins(cloud,btc,Array.from({length:395},(_,index)=>rosterRow(index+1).code));
  const [a,b,c]=batch;
  const schoolYear="2027-2028", otherYearCode=rosterRow(400).code;
  expectOk(cloud.post("SAVE_ROSTER",{...btc,schoolYear,mode:"skip",confirmed:true,rows:[rosterRow(400)]}));
  const status=()=>expectOk(cloud.post("LIST_ROSTER",{...btc,eventId})).roster;
  assert.equal(status().filter(row=>row.lastLoginAt).length,0);
  assert.equal(cloud.sheets.get("EventAccounts"),undefined);
  const accessProperties=cloud.context.PropertiesService.getScriptProperties().getProperties();
  assert.equal(JSON.stringify(accessProperties).includes(a.accessCode),false);
  assert.equal(JSON.stringify(cloud.post("LIST_ROSTER",btc)).includes(a.accessCode),false);
  assert.equal(JSON.stringify(cloud.post("GET_EVENT_VIEW")).includes(a.accessCode),false);
  expectDenied(cloud.post("CONFIGURE_STUDENT_ACCESS",{...teacher,eventId,operation:"disable"}),"FORBIDDEN");
  const otherEvent=events[1].id;
  const other=studentLogins(cloud,btc,[actorA],otherEvent)[0];
  const login=(item,target=eventId)=>cloud.post("LOGIN_STUDENT",{eventId:target,...item,studentAccessVersion});
  const deny=item=>{const result=login(item);expectDenied(result,"STUDENT_LOGIN_INVALID");return result.message;};
  const invalid=deny({...a,accessCode:a.accessCode.toLowerCase()});
  assert.equal(deny({...a,accessCode:a.accessCode + " "}),invalid);
  assert.equal(deny({...a,accessCode:other.accessCode}),invalid);
  assert.equal(deny({...a,code:"MISSING-1"}),invalid);
  assert.equal(deny({...a,code:otherYearCode}),invalid);
  expectDenied(login(other,otherEvent),"STUDENT_LOGIN_INVALID");
  expectDenied(cloud.post("LOGIN_STUDENT",{eventId,...a}),"API_VERSION_MISMATCH");
  expectDenied(cloud.post("REDEEM_STUDENT",{eventId,code:a.code}),"API_VERSION_MISMATCH");
  expectDenied(cloud.post("MANAGE_ACTIVATION",{...btc,eventId,operation:"issue"}),"API_VERSION_MISMATCH");
  expectDenied(JSON.parse(cloud.get({action:"LOGIN_STUDENT"}).value),"METHOD_NOT_ALLOWED");

  cloud.onAccountWrite(()=>expectDenied(login(a),"EVENT_UNAVAILABLE"));
  const sessionA=redeem(cloud,a), sessionB=redeem(cloud,b);
  assert.equal(status().filter(row=>row.lastLoginAt).length,2);
  assert.equal(status()[0].sessionActive,true);
  expectDenied(cloud.post("LIST_ROSTER",sessionA),"AUTH_REQUIRED");
  expectDenied(cloud.post("CONFIGURE_STUDENT_ACCESS",{...sessionA,eventId,operation:"disable"}),"AUTH_REQUIRED");
  const wrongYear={studentSession:{...sessionA.studentSession,schoolYear}};
  expectDenied(cloud.post("GET_EVENT_VIEW",wrongYear),"AUTH_REQUIRED");
  expectDenied(cloud.post("GET_EVENT_VIEW",{studentSession:{eventId,code:a.code,token:sessionA.studentSession.token}}),"AUTH_REQUIRED");

  for(let i=0;i<60;i++)deny({code:"UNKNOWN-"+i,accessCode:"Fixture.Invalid"});
  const blocked=login(c);
  expectDenied(blocked,"STUDENT_LOGIN_INVALID");
  assert.equal(blocked.retryAfterSeconds,30);
  expectOk(cloud.post("GET_EVENT_VIEW",sessionA));
  assert.equal(status().some(row=>row.locked),false);
  cloud.advance(29000);
  assert.equal(login(c).retryAfterSeconds,1);
  cloud.advance(1000);
  const sessionC=redeem(cloud,c);

  const change=(operation,codes)=>expectOk(cloud.post("MANAGE_STUDENT_ACCOUNTS",{...btc,eventId,operation,codes}));
  change("lock",[b.code]);
  assert.equal(deny(b),invalid);
  expectDenied(cloud.post("GET_EVENT_VIEW",sessionB),"AUTH_REQUIRED");
  change("unlock",[b.code]);
  expectDenied(cloud.post("GET_EVENT_VIEW",sessionB),"AUTH_REQUIRED");
  const newB=redeem(cloud,b);
  change("revoke",[b.code]);
  expectDenied(cloud.post("GET_EVENT_VIEW",newB),"AUTH_REQUIRED");
  expectOk(cloud.post("LOGOUT_STUDENT",sessionC));
  expectDenied(cloud.post("GET_EVENT_VIEW",sessionC),"AUTH_REQUIRED");
  const nextC=redeem(cloud,c);
  cloud.advance(12*3600000);
  expectDenied(cloud.post("GET_EVENT_VIEW",nextC),"AUTH_REQUIRED");
  redeem(cloud,c);
  assert.ok(!JSON.stringify(cloud.logs).includes(a.accessCode));
});

test("chuyển mã và đóng mở sự kiện thu hồi phiên, giữ hồ sơ cũ và tiến độ", () => {
  const {cloud,btc,events}=setup();
  const old={locked:false,codeHash:"legacy-data",sessionHash:"legacy-session",activatedAt:1};
  cloud.seedRows("EventAccounts",[["key","data"],[eventId+"::"+actorA,JSON.stringify(old)]]);
  const legacyProgress={luckyNumbers:{[eventId]:"0427"},favoriteBooths:{[eventId]:"robotics"}};
  cloud.seedRows("WorkflowState",[["student",actorA,"2026-11-21T01:00:00.000Z",JSON.stringify(legacyProgress)]]);
  const [student]=studentLogins(cloud,btc,[actorA]);
  const login=redeem(cloud,student);
  const record=expectOk(cloud.post("JOIN_QUEUE",{...login,eventId,boothId:"robotics"})).record;
  expectOk(cloud.post("TEACHER_COMPLETE",{...btc,eventId,boothId:"robotics",ids:[record.id]}));
  const oldSecret=student.accessCode;
  const newer={...student,accessCode:"New.Fixture"};
  const cfg=(operation,accessCode)=>expectOk(cloud.post("CONFIGURE_STUDENT_ACCESS",{...btc,eventId,operation,accessCode}));
  cfg("set",newer.accessCode);
  expectDenied(cloud.post("GET_EVENT_VIEW",login),"AUTH_REQUIRED");
  expectDenied(cloud.post("LOGIN_STUDENT",{eventId,code:actorA,accessCode:oldSecret,studentAccessVersion}),"STUDENT_LOGIN_INVALID");
  const newerSession=redeem(cloud,newer);
  const preserved=expectOk(cloud.post("GET_EVENT_VIEW",newerSession)).records;
  assert.equal(preserved.find(row=>row.id===record.id).data.status,"completed");
  assert.equal(preserved.find(row=>row.type==="student").data.luckyNumbers[eventId],legacyProgress.luckyNumbers[eventId]);
  assert.equal(preserved.find(row=>row.type==="student").data.favoriteBooths[eventId],legacyProgress.favoriteBooths[eventId]);
  assert.equal(JSON.parse(cloud.sheets.get("EventAccounts").rows[1][1]).codeHash,old.codeHash);
  cfg("disable");
  assert.equal(expectOk(cloud.post("GET_EVENT_VIEW")).studentLoginEnabled,false);
  expectDenied(cloud.post("GET_EVENT_VIEW",newerSession),"AUTH_REQUIRED");
  cfg("enable");
  const resumed=redeem(cloud,newer);
  const archived=events.map(event=>event.id===eventId?{...event,archived:true}:event);
  expectOk(cloud.post("SAVE_EVENT_CONFIG",{...btc,config:{activeEventId:events[1].id,events:archived}}));
  expectDenied(cloud.post("GET_EVENT_VIEW",resumed),"AUTH_REQUIRED");
  expectDenied(cloud.post("LOGIN_STUDENT",{eventId,...newer,studentAccessVersion}),"STUDENT_LOGIN_INVALID");
  assert.equal(expectOk(cloud.post("GET_EVENT_ARCHIVE",{...btc,eventId})).stats.booths[0].completed,1);
});

test("quyền đọc và ghi, QR/PIN, hàng đợi, đánh giá, bình chọn và quay thưởng", () => {
  const { cloud, btc, teacher, nobody, events } = setup();
  const [a,b] = studentLogins(cloud,btc,[actorA,actorB]);
  const studentA = redeem(cloud,a), studentB = redeem(cloud,b);
  const booths = expectOk(cloud.post("GET_EVENT_VIEW",btc)).records.find(record=>record.id==="booth-config").data.boothList;
  for (const booth of booths.slice(1)) expectOk(cloud.post("SET_EVENT_ASSIGNMENT",{
    ...btc,email:supervisor,eventId,boothId:booth.id,enabled:true
  }));
  const qr = expectOk(cloud.post("RESOLVE_BOOTH",{...studentA,eventId,pin:booths[0].pin}));
  assert.equal(qr.boothId,"robotics");
  expectDenied(cloud.post("RESOLVE_BOOTH",{...studentA,eventId:events[1].id,pin:booths[0].pin}),"INVALID_INPUT");
  for(const booth of booths) {
    const input = {eventId,boothId:booth.id};
    const claimed = expectOk(cloud.post("JOIN_QUEUE",{...studentA,...input,studentCode:actorB}));
    assert.equal(claimed.record.data.studentCode,actorA);
    const next = expectOk(cloud.post("JOIN_QUEUE",{...studentB,...input}));
    assert.equal(next.record.data.ticketNo,2);
    expectOk(cloud.post("CANCEL_QUEUE",{...studentB,...input}));
    expectOk(cloud.post("TEACHER_COMPLETE",{...teacher,...input,ids:[claimed.record.id]}));
    expectOk(cloud.post("SUBMIT_RATING",{...studentA,...input,rating:5,tags:["Dễ hiểu"]}));
    expectDenied(cloud.post("SUBMIT_RATING",{...studentA,...input,rating:1}),"CONFLICT");
  }
  expectOk(cloud.post("SUBMIT_VOTE",{...studentA,eventId,boothId:"robotics"}));
  expectDenied(cloud.post("SUBMIT_VOTE",{...studentA,eventId,boothId:"chemistry"}),"INVALID_INPUT");
  const drawn = expectOk(cloud.post("START_DRAW",{...btc,eventId,count:1}));
  assert.equal(drawn.winners[0].winnerCode,actorA);
  expectDenied(cloud.post("START_DRAW",{...teacher,eventId,count:1}),"FORBIDDEN");
  const persistedBeforeReset = cloud.sheets.get("WorkflowState").rows.length;
  const beforeReveal=expectOk(cloud.post("GET_EVENT_VIEW",{...studentA,knownRevision:""}));
  assert.equal(beforeReveal.records.some(item=>item.type==="drawHistory"),false);
  cloud.advance(3000);
  const afterReveal=expectOk(cloud.post("GET_EVENT_VIEW",{...studentA,knownRevision:beforeReveal.viewRevision}));
  assert.equal(afterReveal.records.some(item=>item.type==="drawHistory"),true);
  assert.notEqual(afterReveal.viewRevision,beforeReveal.viewRevision);
  assert.equal(expectOk(cloud.post("GET_EVENT_VIEW",studentB)).records.some(item=>item.type==="drawHistory"),false);
  expectOk(cloud.post("RESET_DRAW_HISTORY",{...btc,eventId}));
  assert.equal(cloud.sheets.get("WorkflowState").rows.length,persistedBeforeReset+1);
  assert.equal(expectOk(cloud.post("GET_EVENT_VIEW",studentA)).records.some(item=>item.type==="drawHistory"),false);
  const archive=expectOk(cloud.post("GET_EVENT_ARCHIVE",{...btc,eventId}));
  assert.equal(archive.draws.length,1);
  assert.equal(archive.stats.booths.find(item=>item.name===booths[0].name).ratingAverage,5);
  expectDenied(cloud.post("GET_EVENT_ARCHIVE",{...teacher,eventId}),"FORBIDDEN");
  expectDenied(cloud.post("GET_EVENT_ARCHIVE",{...studentA,eventId}),"AUTH_REQUIRED");

  const guest=cloud.get();
  assert.equal(guest.mime,"JSON");
  const guestData=JSON.parse(guest.value);
  assert.equal(guestData.records.every(item=>item.type==="config"),true);
  assert.equal(guest.value.includes(actorA)||guest.value.includes('"pin"')||guest.value.includes(events[1].name),false);
  expectDenied(JSON.parse(cloud.get({callback:"fixture"}).value),"METHOD_NOT_ALLOWED");
  expectDenied(cloud.post("GET_EVENT_VIEW",nobody),"FORBIDDEN");
  expectDenied(cloud.post("SYNC_RECORD",{...studentA,record:{type:"student"}}),"METHOD_NOT_ALLOWED");
  expectDenied(cloud.post("JOIN_QUEUE",{eventId,boothId:"robotics",studentCode:actorA}),"FORBIDDEN");
  for(const booth of booths.slice(1))expectOk(cloud.post("SET_EVENT_ASSIGNMENT",{
    ...btc,email:supervisor,eventId,boothId:booth.id,enabled:false
  }));
  const teacherView=expectOk(cloud.post("GET_EVENT_VIEW",teacher));
  assert.deepEqual(Object.keys(teacherView.queueSummary),["robotics"]);
  assert.ok(teacherView.records.filter(item=>item.type==="queue").every(item=>item.data.boothId==="robotics"));
  expectDenied(cloud.post("TEACHER_SKIP",{...teacher,eventId,boothId:"chemistry",ids:["fake"]}),"FORBIDDEN");
  const input={eventId,boothId:"robotics"};
  const bWait=expectOk(cloud.post("JOIN_QUEUE",{...studentB,...input})).record;
  expectOk(cloud.post("TEACHER_SKIP",{...teacher,...input,ids:[bWait.id]}));
  expectOk(cloud.post("TEACHER_RECALL",{...teacher,...input,ids:[bWait.id]}));
  const duplicate=expectOk(cloud.post("JOIN_QUEUE",{...studentB,...input,studentCode:actorA}));
  assert.equal(duplicate.record.data.studentCode,actorB);
  assert.equal(duplicate.duplicate,true);
  assert.equal(duplicate.record.data.ticketNo,4);
  expectOk(cloud.post("SAVE_EVENT_CONFIG",{...btc,config:{activeEventId:events[1].id,events}}));
  expectDenied(cloud.post("GET_EVENT_VIEW",studentA),"AUTH_REQUIRED");
  const newEvent=redeem(cloud,studentLogins(cloud,btc,[actorA],events[1].id)[0],events[1].id);
  const isolated=expectOk(cloud.post("GET_EVENT_VIEW",newEvent));
  assert.equal(isolated.records.some(item=>item.type==="queue"||item.type==="drawHistory"),false);
  assert.deepEqual(isolated.records.find(item=>item.type==="student").data.luckyNumbers,{});
  assert.deepEqual(isolated.records.find(item=>item.type==="student").data.favoriteBooths,{});
});

test("OTP giáo viên giữ nguyên xác minh và phiên hợp lệ", () => {
  const cloud = fakeAppsScript();
  const sent = expectOk(cloud.post("SEND_TEACHER_OTP_V3",{email:admin}));
  assert.equal(sent.otpVersion,"teacher-otp-v3");
  assert.equal("otp" in sent,false);
  assert.equal(cloud.mail.length,1);
  const code=cloud.mail[0].body.match(/\b\d{6}\b/)[0];
  const verified=expectOk(cloud.post("VERIFY_TEACHER_OTP_V3",{email:admin,otp:code}));
  assert.equal(verified.otpVersion,"teacher-otp-v3");
  expectDenied(cloud.post("VERIFY_TEACHER_OTP_V3",{email:admin,otp:code}),"OTP_INVALID");
  assert.equal(expectOk(cloud.post("CHECK_TEACHER_SESSION",{authToken:verified.token})).email,admin);
});

test("OTP kiểm tra email, từ chối mã client, hết hạn và giới hạn thử sai", () => {
  const cloud=fakeAppsScript();
  const send=email=>cloud.post("SEND_TEACHER_OTP_V3",{email});
  const verify=(email,otp)=>cloud.post("VERIFY_TEACHER_OTP_V3",{email,otp});
  expectDenied(send("fixture@invalid.example"),"INVALID_EMAIL");
  expectDenied(cloud.post("SEND_TEACHER_OTP_V3",{email:admin,otp:"000000"}),"OTP_CLIENT_VALUE");
  assert.equal(cloud.mail.length,0);
  expectOk(send(" " + admin.toUpperCase() + " "));
  assert.equal(cloud.mail[0].to,admin);
  const code=cloud.mail[0].body.match(/\b\d{6}\b/)[0];
  expectDenied(verify(supervisor,code),"OTP_INVALID");
  const wrong=(code[0]==="0"?"1":"0")+code.slice(1);
  for(let i=0;i<4;i++)expectDenied(verify(admin,wrong),"OTP_INVALID");
  const exhausted=verify(admin,wrong);
  expectDenied(exhausted,"OTP_ATTEMPTS_EXHAUSTED");
  assert.equal(exhausted.retryAfterSeconds,300);
  cloud.advance(60000);
  assert.equal(verify(admin,code).retryAfterSeconds,240);
  assert.equal(send(admin).retryAfterSeconds,240);
  cloud.advance(240000);
  expectDenied(verify(admin,code),"OTP_EXPIRED");
  expectOk(send(admin));
  assertTeacherDiagnostics(cloud.logs);
});

test("giới hạn gửi giữ mốc 60 giây, 3 email/giờ và 60 toàn hệ thống; yêu cầu bị từ chối không kéo dài mốc", () => {
  const cloud=fakeAppsScript();
  const send=(email=admin)=>cloud.post("SEND_TEACHER_OTP_V3",{email});
  expectOk(send());
  cloud.advance(59000);
  const cooldown=send();
  expectDenied(cooldown,"OTP_SEND_LIMIT");
  assert.equal(cooldown.retryAfterSeconds,1);
  cloud.advance(1000);
  expectOk(send());
  cloud.advance(60000);
  expectOk(send());
  cloud.advance(60000);
  const rollingLimit=send();
  expectDenied(rollingLimit,"OTP_SEND_LIMIT");
  assert.equal(rollingLimit.retryAfterSeconds,3420);
  cloud.advance(3419000);
  assert.equal(send().retryAfterSeconds,1);
  cloud.advance(1000);
  expectOk(send());
  assert.equal(cloud.mail.length,4);

  const shared=fakeAppsScript();
  for(let index=0;index<60;index++){
    expectOk(shared.post("SEND_TEACHER_OTP_V3",{email:`fixture.${index}@fpt.edu.vn`}));
  }
  expectDenied(shared.post("SEND_TEACHER_OTP_V3",{email:admin}),"OTP_SEND_LIMIT");
  assert.equal(shared.mail.length,60);
  shared.advance(3600000);
  expectOk(shared.post("SEND_TEACHER_OTP_V3",{email:admin}));
});

test("lỗi MailApp được báo rõ và giữ lại OTP cũ còn hạn", () => {
  const cloud=fakeAppsScript();
  expectOk(cloud.post("SEND_TEACHER_OTP_V3",{email:admin}));
  const delivered=cloud.mail[0].body.match(/\b\d{6}\b/)[0];
  cloud.advance(60000);
  cloud.context.MailApp.sendEmail=()=>{throw new Error("fixture transport failure");};
  expectDenied(cloud.post("SEND_TEACHER_OTP_V3",{email:admin}),"OTP_MAIL_FAILED");
  const result=expectOk(cloud.post("VERIFY_TEACHER_OTP_V3",{email:admin,otp:delivered}));
  expectOk(cloud.post("LOGOUT_TEACHER",{authToken:result.token}));
  expectDenied(cloud.post("CHECK_TEACHER_SESSION",{authToken:result.token}),"AUTH_REQUIRED");
  assertTeacherDiagnostics(cloud.logs);
  assert.deepEqual(cloud.logs.map(([line])=>JSON.parse(line).stage),["EMAIL_DELIVERY","SESSION_CHECK"]);
});

test("400 lượt đọc dữ liệu đã phân quyền trong mô phỏng", t => {
  const { cloud, btc, teacher, events } = setup(400);
  const entries = studentLogins(cloud,btc,Array.from({length:400},(_,index)=>rosterRow(index+1).code));
  const sessions = entries.map(entry => redeem(cloud,entry));
  const booths = expectOk(cloud.post("GET_EVENT_VIEW",btc)).records.find(record=>record.id==="booth-config").data.boothList;
  const legacy = [];
  for(const event of events)for(let sequence=0;sequence<400;sequence++)for(const booth of booths) {
    const profile=rosterRow(sequence+1), id=event.id+"::"+booth.id+"::"+profile.code, updatedAt="2026-11-21T00:00:00.000Z";
    legacy.push(["queue",id,updatedAt,JSON.stringify({id,eventId:event.id,boothId:booth.id,studentCode:profile.code,
      studentName:profile.name,className:profile.className,status:sequence%2?"completed":"waiting",ticketNo:sequence+1,updatedAt})]);
  }
  cloud.seedRows("WorkflowState",legacy);
  cloud.cache.remove("event-pass-read-v1");
  const before=cloud.metrics.workflowRangeReads;
  let max=0;
  const start=performance.now();
  const samples = sessions.map(session => {
    const requestStart=performance.now(), result=expectOk(cloud.post("GET_EVENT_VIEW",session));
    max=Math.max(max,Buffer.byteLength(JSON.stringify(result)));
    assert.equal(result.records.filter(item=>item.type==="queue").length,booths.length);
    assert.equal(result.records.filter(item=>item.type==="student").length,1);
    return performance.now()-requestStart;
  }).sort((a,b)=>a-b);
  const reads=cloud.metrics.workflowRangeReads-before;
  assert.equal(reads,1);
  const staffView=expectOk(cloud.post("GET_EVENT_VIEW",teacher));
  assert.equal(staffView.records.filter(item=>item.type==="queue").length,400);
  assert.ok(max<8192);
  t.diagnostic("400 phiên · "+legacy.length+" lượt lưu · "+reads+" lần đọc toàn WorkflowState · tối đa "+max+
    " byte/phản hồi HS · p95 VM "+samples[379].toFixed(1)+" ms · tổng "+Math.round(performance.now()-start)+" ms");
});

function workbookFixture(entries) {
  const zlib = require("node:zlib");
  const local = [], central = [];
  let offset = 0;
  for (const [name, xml] of Object.entries(entries)) {
    const file = Buffer.from(name), data = Buffer.from(xml), compressed = zlib.deflateRawSync(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50,0); header.writeUInt16LE(20,4); header.writeUInt16LE(8,8);
    header.writeUInt32LE(compressed.length,18); header.writeUInt32LE(data.length,22); header.writeUInt16LE(file.length,26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50,0); record.writeUInt16LE(20,6); record.writeUInt16LE(8,10);
    record.writeUInt32LE(compressed.length,20); record.writeUInt32LE(data.length,24);
    record.writeUInt16LE(file.length,28); record.writeUInt32LE(offset,42);
    local.push(header,file,compressed);
    central.push(record,file);
    offset += header.length+file.length+compressed.length;
  }
  const eocd=Buffer.alloc(22), directory=Buffer.concat(central);
  eocd.writeUInt32LE(0x06054b50,0); eocd.writeUInt16LE(local.length/3,8); eocd.writeUInt16LE(local.length/3,10);
  eocd.writeUInt32LE(directory.length,12); eocd.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,eocd]);
}

function mockXmlNode(model) {
  const children = (model.children || []).map(mockXmlNode);
  return {
    name: model.name, get textContent() { return (model.text || "") + children.map(child=>child.textContent).join(""); },
    getAttribute: key => model.attrs[key] ?? null,
    getAttributeNS: (ns, key) => model.attrs["{"+ns+"}"+key] ?? null,
    getElementsByTagNameNS: (_ns, name) => children.flatMap(node =>
      [...(node.name===name?[node]:[]),...node.getElementsByTagNameNS("*",name)])
  };
}

class FixtureDOMParser {
  parseFromString(text) {
    const script = [
      "import json, sys, xml.etree.ElementTree as x",
      "def obj(e):",
      " return {'name':e.tag.split('}')[-1], 'attrs':e.attrib, 'text':e.text, 'children':[obj(c) for c in e]}",
      "print(json.dumps(obj(x.fromstring(sys.stdin.read()))))"
    ].join("\n");
    const parsed = JSON.parse(execFileSync("python3",["-c",script],{input:text,encoding:"utf8"}));
    return mockXmlNode({name:"document",attrs:{},children:[parsed]});
  }
}

test("Excel và CSV xem trước dòng lỗi, trùng, dấu tiếng Việt và số 0 đầu", async () => {
  const fixture=workbookFixture({
    "xl/workbook.xml":'<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Fixture" r:id="fixture-id"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":'<Relationships><Relationship Id="fixture-id" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/sharedStrings.xml":'<sst><si><t>STT</t></si><si><t>Mã học sinh</t></si><si><t>Họ và tên</t></si><si><t>Lớp</t></si></sst>',
    "xl/worksheets/sheet1.xml":'<worksheet><sheetData>'+
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>'+
      '<row r="2"><c r="A2"><v>1</v></c><c r="B2" t="inlineStr"><is><t> 0007 </t></is></c><c r="C2" t="inlineStr"><is><t>Họ tên giả</t></is></c><c r="D2" t="inlineStr"><is><t> 11 a 2 </t></is></c></row>'+
      '<row r="9"><c r="B9"><f>1234</f><v>1234</v></c><c r="C9" t="inlineStr"><is><t>Ô giả</t></is></c><c r="D9" t="inlineStr"><is><t>10A1</t></is></c></row>'+
      '</sheetData></worksheet>'
  });
  const context=vm.createContext({TextDecoder,Uint8Array,DataView,Blob,DecompressionStream,DOMParser:FixtureDOMParser});
  vm.runInContext(source("event-excel.js"),context);
  context.excelFile={name:"synthetic-roster.xlsx",size:fixture.length,arrayBuffer:async()=>fixture.buffer.slice(fixture.byteOffset,fixture.byteOffset+fixture.length)};
  const rows=await vm.runInContext("readRosterFile(excelFile)",context);
  context.fixtureRows=rows;
  const preview=vm.runInContext('rosterImportPreview(fixtureRows,new Set(["0007"]))',context);
  assert.equal(preview[0].profile.code,"0007");
  assert.equal(preview[0].profile.className,"11A2");
  assert.equal(preview[0].duplicate,true);
  assert.equal(preview[1].sourceRow,9);
  assert.match(preview[1].error,/công thức/);
  context.csv='STT;Mã học sinh;Họ và tên;Lớp\r\n1;ab12;"Tên; giả";12A2\r\n2;AB12;Trùng;12A2';
  const csvPreview=vm.runInContext("rosterImportPreview(rosterCsvRows(csv),new Set())",context);
  assert.equal(csvPreview[0].profile.name,"Tên; giả");
  assert.ok(csvPreview.every(item=>item.duplicate&&item.error));
  assert.throws(()=>vm.runInContext('rosterZipIndex(new Uint8Array(12))',context),/không hợp lệ/);
});

const appHtml=source("index.html");
const mainScript=new vm.Script(appHtml.match(/<script>([\s\S]*?)<\/script>/)[1],{filename:"index.html"});
function mockStore() {
  const values=new Map();
  return {values,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
}
function mockBrowser(cloud, sessionStorage=mockStore(), localStorage=mockStore(), settings={}) {
  const elements=new Map(), timers=[], requests=[], notices=[];
  let timerSequence=0, elementSequence=0;
  const hide=new Set(["loginAdmin","studentApp","adminApp","boothModal","qrScannerModal","favoriteVoteModal","reviewModal","winnerBanner"]);
  const node=id=>{
    if(!elements.has(id)){
      const classSet=new Set(hide.has(id)?["hidden"]:[]);
      const children=[];
      const events=new Map();
      elements.set(id,{
        id,value:"",disabled:id==="studentLoginButton",textContent:"",innerHTML:"",
        style:{setProperty(key,value){this[key]=value;},removeProperty(key){delete this[key];}},dataset:{},
        hidden:["studentPassButton","studentPassSync"].includes(id),
        lastChild:{nodeType:3},nextElementSibling:{},querySelector:selector=>node(id+"-"+selector),querySelectorAll:()=>[],
        get previousElementSibling(){return node(id+"-previous");}, get options(){return children;}, get children(){return children;},
        get open(){return Boolean(this.isOpen);},
        classList:{add:(...names)=>names.forEach(name=>classSet.add(name)),remove:(...names)=>names.forEach(name=>classSet.delete(name)),
          contains:name=>classSet.has(name),toggle(name,force){if(force??!classSet.has(name))classSet.add(name);else classSet.delete(name);}},
        insertBefore(){},setAttribute(){},removeAttribute(){},addEventListener(type,handler){events.set(type,handler);},closest:selector=>node(id+"-"+selector),
        click(){events.get("click")?.();},
        focus(){},blur(){},appendChild(child){children.push(child);if(id==="toastStack")notices.push(child.innerHTML);},
        replaceChildren(...items){children.splice(0,children.length,...items);},
        append(...items){children.push(...items);},
        insertRow(){const child=node("row-"+(++elementSequence));children.push(child);return child;},
        insertCell(){const child=node("cell-"+(++elementSequence));children.push(child);return child;},
        showModal(){this.isOpen=true;},close(){this.isOpen=false;events.get("close")?.();}
      });
    }
    return elements.get(id);
  };
  const {Date:serverDate}=cloud.context;
  const context=vm.createContext({
    Date:serverDate,URL,TextDecoder,ArrayBuffer,Blob,AbortController,
    window:{location:new URL("https://fixture.invalid/event-pass/"),addEventListener(){},localStorage,sessionStorage},
    navigator:{onLine:true}, localStorage,sessionStorage,console:{warn(){},error(){}},
    document:{getElementById:node,createElement:tag=>node(tag+"-"+(++elementSequence)),querySelector:s=>node("query-"+s),querySelectorAll:()=>[],addEventListener(){}},
    clearTimeout(){},clearInterval(){},setTimeout:(fn,ms)=>{timers.push({fn,ms});return ++timerSequence;},setInterval:()=>++timerSequence,
    fetch:async (url,options)=>{
      assert.equal(options.method,"POST");assert.equal(options.mode,"cors");
      assert.equal(options.credentials,"omit");
      assert.equal(options.headers["Content-Type"],"text/plain;charset=utf-8");
      const payload=JSON.parse(options.body);
      requests.push(payload.action);
      if(settings.httpResponses?.[payload.action])return settings.httpResponses[payload.action];
      if(settings.offline||settings.offlineAction===payload.action) throw new TypeError("fixture network");
      if(payload.action==="GET_EVENT_API_VERSION"){
        assert.match(url,/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/);
        assert.deepEqual(payload,{action:"GET_EVENT_API_VERSION"});
        if(settings.versionResponse)return settings.versionResponse;
      }
      return {ok:true,json:async()=>settings.reply?.(payload) ?? cloud.post(payload.action,payload)};
    }
  });
  vm.runInContext(source("event-ui.js"),context);
  vm.runInContext(source("event-excel.js"),context);
  vm.runInContext(source("event-roster.js"),context);
  vm.runInContext(source("event-admin.js"),context);
  vm.runInContext(source("student-pass.js"),context);
  vm.runInContext(source("event-images.js"),context);
  mainScript.runInContext(context);
  return {run:code=>vm.runInContext(code,context),node,requests,timers,notices,settings,sessionStorage,localStorage};
}
const browserSettled=()=>new Promise(resolve=>setImmediate(resolve));

async function activateStudentInBrowser(browser, item) {
  await browserSettled();
  if (browser.node("studentLoginButton").disabled) await browser.run("loadPublicEvent()");
  browser.node("studentCodeInput").value = item.code;
  browser.node("studentAccessInput").value = item.accessCode;
  await browser.run("submitStudentLogin({preventDefault(){}})");
  assert.equal(browser.run("currentUser.code"), item.code);
}

function passStamps(browser) {
  return browser.node("studentPassBooths").children.filter(card => card.children[0].classList.contains("is-complete"));
}

test("phiếu chỉ đóng dấu sau xác nhận và đồng bộ, giữ dấu cũ khi mất mạng", async () => {
  const { cloud, btc, nobody } = setup();
  const browser = mockBrowser(cloud);
  await browserSettled();
  assert.equal(browser.node("studentPassButton").hidden, true);
  await activateStudentInBrowser(browser, studentLogins(cloud, btc, [actorA])[0]);
  const student = browser.run("eventAuth()");
  browser.node("studentPassButton").click();
  assert.equal(browser.node("studentPassDialog").open, true);
  assert.equal(browser.node("studentPassCode").textContent, actorA);
  assert.equal(browser.node("studentPassBooths").children.length, 6);
  assert.equal(browser.node("studentPassCount").textContent, "0/6");
  assert.equal(passStamps(browser).length, 0);
  expectOk(cloud.post("RESOLVE_BOOTH", { ...student, eventId, boothId: "robotics" }));
  await browser.run("pollRemote()");
  assert.equal(passStamps(browser).length, 0);
  const join = boothId => expectOk(cloud.post("JOIN_QUEUE", { ...student, eventId, boothId })).record;
  const complete = record => expectOk(cloud.post("TEACHER_COMPLETE", {
    ...btc, eventId, boothId: record.data.boothId, ids: [record.id]
  }));

  const waiting = join("robotics");
  const missed = join("chemistry");
  expectOk(cloud.post("TEACHER_SKIP", { ...btc, eventId, boothId: "chemistry", ids: [missed.id] }));
  join("ai-iot");
  expectOk(cloud.post("CANCEL_QUEUE", { ...student, eventId, boothId: "ai-iot" }));
  expectDenied(cloud.post("TEACHER_COMPLETE", { ...nobody, eventId, boothId: "robotics", ids: [waiting.id] }), "FORBIDDEN");
  await browser.run("pollRemote()");
  assert.equal(passStamps(browser).length, 0);
  const card = id => browser.node("studentPassBooths").children.find(item => item.dataset.boothId === id);
  for (const id of ["robotics", "chemistry", "ai-iot"]) {
    const [circle] = card(id).children;
    assert.equal(card(id).children.length, 1);
    assert.equal(circle.type, "button");
    assert.equal(circle.children.length, 0);
    assert.ok(circle.title);
  }

  complete(waiting);
  browser.settings.offline = true;
  await browser.run("pollRemote()");
  assert.equal(browser.node("studentPassSync").hidden, false);
  assert.equal(passStamps(browser).length, 0);
  browser.settings.offline = false;
  await browser.run("pollRemote()");
  assert.equal(browser.node("studentPassSync").hidden, true);
  assert.equal(browser.node("studentPassCount").textContent, "1/6");
  const [firstStamp] = passStamps(browser);
  assert.equal(firstStamp.dataset.boothId, "robotics");
  const [stampCircle] = firstStamp.children;
  assert.equal(stampCircle.classList.contains("animate-stampPop"), true);
  assert.deepEqual(stampCircle.children.map(node => node.className), [
    "student-pass-stamp-icon", "student-pass-state"
  ]);
  assert.equal(stampCircle.children[1].textContent, "HOÀN THÀNH");
  assert.equal(firstStamp.children.length, 1);
  stampCircle.click();
  assert.equal(browser.node("studentPassStampName").textContent, "Trạm Robotics & Drone");
  assert.ok(browser.node("studentPassStampTime").dateTime);
  assert.equal(browser.node("studentPassStampDetails").hidden, false);
  await browser.run("pollRemote()");
  assert.equal(passStamps(browser)[0], firstStamp);
  browser.node("studentPassClose").click();
  assert.equal(browser.node("studentPassDialog").open, false);
  browser.node("studentPassButton").click();
  assert.equal(passStamps(browser)[0].children[0].classList.contains("animate-stampPop"), false);
  browser.settings.offline = true;
  await browser.run("pollRemote()");
  assert.equal(browser.node("studentPassSync").hidden, false);
  assert.equal(passStamps(browser).length, 1);
  browser.settings.offline = false;

  expectOk(cloud.post("TEACHER_RECALL", { ...btc, eventId, boothId: "chemistry", ids: [missed.id] }));
  complete(missed);
  complete(join("ai-iot"));
  await browser.run("pollRemote()");
  assert.equal(passStamps(browser).length, 3);
  assert.equal(browser.node("studentPassCount").textContent, "3/6");
  for (const id of ["3d-print", "culture", "green"]) complete(join(id));
  await browser.run("pollRemote()");
  assert.equal(passStamps(browser).length, 6);
  assert.equal(browser.node("studentPassCount").textContent, "6/6");
});

for (const boothCount of [6, 10, 15, 20]) test(`phiếu ${boothCount} gian: đúng icon, không dấu khi chờ, chỉ một hiệu ứng sau ACK`, async () => {
  const { cloud, btc } = setup();
  const booths = Array.from({length:boothCount}, (_, index) => ({
    id:"ui-booth-"+index, name:"Gian trải nghiệm "+(index+1), pin:String(7000+index), icon:"bot"
  }));
  expectOk(cloud.post("SAVE_EVENT_BOOTHS", {...btc,booths}));
  const browser=mockBrowser(cloud);
  await activateStudentInBrowser(browser,studentLogins(cloud,btc,[actorA])[0]);
  browser.node("studentPassButton").click();
  assert.equal(browser.node("studentPassBooths").children.length,boothCount);
  assert.equal(passStamps(browser).length,0);
  const joined=expectOk(cloud.post("JOIN_QUEUE",{...browser.run("eventAuth()"),eventId,boothId:booths[0].id})).record;
  await browser.run("pollRemote()");
  assert.equal(passStamps(browser).length,0);
  expectOk(cloud.post("TEACHER_COMPLETE",{...btc,eventId,boothId:booths[0].id,ids:[joined.id]}));
  await browser.run("pollRemote()");
  const stamp=passStamps(browser)[0];
  assert.equal(stamp.dataset.boothId,booths[0].id);
  assert.equal(stamp.children[0].classList.contains("animate-stampPop"),true);
  assert.equal(stamp.children[0].children[0].className,"student-pass-stamp-icon");
  await browser.run("pollRemote()");
  assert.equal(passStamps(browser).length,1);
  assert.equal(passStamps(browser)[0],stamp,"unchanged polling keeps the same DOM node");
});

test("phiếu phục hồi dấu, thay đổi cấu hình và tách dữ liệu theo học sinh/sự kiện", async () => {
  const { cloud, btc, events } = setup();
  const enrolled = studentLogins(cloud, btc, [actorA, actorB]);
  const studentA = redeem(cloud, enrolled[0]);
  const next = expectOk(cloud.post("JOIN_QUEUE", { ...studentA, eventId, boothId: "robotics" })).record;
  expectOk(cloud.post("TEACHER_COMPLETE", { ...btc, eventId, boothId: "robotics", ids: [next.id] }));

  const browser = mockBrowser(cloud);
  // A separate browser earns a new session with the same event code.
  await activateStudentInBrowser(browser, enrolled[0]);
  browser.node("studentPassButton").click();
  assert.equal(browser.node("studentPassCount").textContent, "1/6");
  assert.equal(passStamps(browser)[0].children[0].classList.contains("animate-stampPop"), false);

  const reloaded = mockBrowser(cloud,browser.sessionStorage,browser.localStorage);
  await browserSettled();
  reloaded.node("studentPassButton").click();
  assert.equal(reloaded.node("studentPassCount").textContent, "1/6");
  assert.equal(passStamps(reloaded).length, 1);

  const longName = "Trạm Robotics sáng tạo và ứng dụng cảm biến thông minh trong đời sống";
  const booths = Array.from({length: 10}, (_, index) => ({
    id: index === 4 ? "robotics" : "test-booth-" + index,
    name: index === 4 ? longName : "Gian thử nghiệm " + (index + 1),
    pin: String(6000 + index), icon: "bot"
  }));
  expectOk(cloud.post("SAVE_EVENT_BOOTHS", { ...btc, booths }));
  reloaded.settings.reply = payload => {
    if (payload.action !== "GET_EVENT_VIEW" || !payload.studentSession) return;
    const view = expectOk(cloud.post(payload.action, payload));
    const completed = view.records.find(record => record.type === "queue");
    view.records.push(completed,
      {...completed, data: {...completed.data, boothId: "test-booth-1", studentCode: actorB}},
      {...completed, data: {...completed.data, boothId: "test-booth-2", eventId: events[1].id}});
    return view;
  };
  await reloaded.run("pollRemote()");
  delete reloaded.settings.reply;
  assert.equal(reloaded.node("studentPassBooths").children.length, 10);
  assert.equal(reloaded.node("studentPassCount").textContent, "1/10");
  assert.deepEqual(passStamps(reloaded).map(card => card.dataset.boothId), ["robotics"]);
  const renamedCircle = reloaded.node("studentPassBooths").children[4].children[0];
  assert.equal(renamedCircle.title, longName);
  assert.equal(renamedCircle.children[1].textContent, "HOÀN THÀNH");
  renamedCircle.click();
  assert.equal(reloaded.node("studentPassStampName").textContent, longName);

  await reloaded.run("logout()");
  assert.equal(reloaded.node("studentPassDialog").open, false);
  assert.equal(reloaded.node("studentPassButton").hidden, true);
  assert.equal(reloaded.node("studentPassName").textContent, "");
  await activateStudentInBrowser(reloaded, enrolled[1]);
  reloaded.node("studentPassButton").click();
  assert.equal(reloaded.node("studentPassCode").textContent, actorB);
  assert.equal(passStamps(reloaded).length, 0);

  const newEvent = events[1].id;
  expectOk(cloud.post("SAVE_EVENT_CONFIG", { ...btc, config: {activeEventId: newEvent, events} }));
  await reloaded.run("pollRemote()");
  assert.equal(reloaded.node("studentPassDialog").open, false);
  assert.equal(reloaded.node("studentPassButton").hidden, true);
  await activateStudentInBrowser(reloaded, studentLogins(cloud, btc, [actorA], newEvent)[0]);
  reloaded.node("studentPassButton").click();
  assert.equal(reloaded.node("studentPassCode").textContent, actorA);
  assert.equal(reloaded.node("studentPassEvent").textContent, events[1].name);
  assert.equal(reloaded.node("studentPassCount").textContent, "0/6");
  assert.equal(passStamps(reloaded).length, 0);
});

test("frontend chỉ nhận phiên sau xác minh, tải lại và chặn thao tác chưa xác nhận", async () => {
  const { cloud, btc }=setup();
  const code=studentLogins(cloud,btc,[actorA])[0];
  const browser=mockBrowser(cloud);
  await browserSettled();
  assert.equal(browser.run("currentUser"),null);
  assert.equal(browser.node("studentLoginButton").disabled,false);
  assert.equal(browser.node("studentApp").classList.contains("hidden"),true);
  browser.node("studentCodeInput").value=code.code;
  browser.node("studentAccessInput").value=code.accessCode;
  await browser.run("submitStudentLogin({preventDefault(){}})");
  assert.equal(browser.run("currentUser.code"),actorA);
  assert.equal(browser.node("studentAccessInput").value,"");
  assert.equal(browser.localStorage.values.size,0);
  assert.equal(browser.sessionStorage.values.size,1);
  assert.equal([...browser.sessionStorage.values.values()].some(value=>value.includes(code.accessCode)), false);
  const reloaded=mockBrowser(cloud,browser.sessionStorage,browser.localStorage);
  assert.equal(reloaded.run("currentUser"),null);
  await browserSettled();
  assert.equal(reloaded.run("currentUser.role"),"student");
  assert.equal(reloaded.requests.includes("LOGIN_STUDENT"),false);
  reloaded.settings.offline=true;
  await reloaded.run('openStudentEvent(activeEvent().id);openBoothModal("robotics");requestExperience()');
  assert.equal(reloaded.run("appState.queue.length"),0);
  assert.equal(reloaded.notices.some(item=>item.includes("Đã nhận STT")),false);
  reloaded.settings.offline=false;
  await reloaded.run("requestExperience()");
  assert.equal(reloaded.run("appState.queue.length"),1);
  assert.equal(reloaded.notices.some(item=>item.includes("Đã nhận STT")),true);
  await reloaded.run("logout()");
  assert.equal(reloaded.run("currentUser"),null);
  assert.equal(reloaded.sessionStorage.values.size,0);
  assert.equal(reloaded.requests.includes("LOGOUT_STUDENT"),true);
});

test("mô hình nhịp poll cho 400 học sinh và 15 nhân sự", t => {
  const studentCount=400, teacherCount=12, btcCount=3;
  const sourceBuckets=(intervals, seconds)=>{
    const count=Array(seconds).fill(0);
    intervals.forEach(([size,period])=>{
      for(let user=0;user<size;user++){
        const offset=(((user+1)*2654435761)>>>0)/2**32*period;
        for(let due=offset;due<seconds;due+=period)count[Math.floor(due)]++;
      }
    });
    return count;
  };
  const old=sourceBuckets([[studentCount+teacherCount+btcCount,3]],120);
  const next=sourceBuckets([[studentCount,30],[teacherCount,8],[btcCount,15]],120);
  const avg=values=>values.reduce((sum,n)=>sum+n,0)/values.length;
  assert.ok(avg(next)<=avg(old)*.12);
  assert.ok(Math.max(...next)<Math.max(...old));
  t.diagnostic("Nhịp định kỳ với lệch pha · cũ "+avg(old).toFixed(1)+" yêu cầu/giây · mới "+avg(next).toFixed(1)+
    " yêu cầu/giây · mô hình chưa tính đợt đăng nhập hoặc hành động tức thời");
});

test("giao diện BTC tải danh sách sau khi backend xác nhận quyền", async () => {
  const { cloud, btc, teacher }=setup();
  const browser=mockBrowser(cloud);
  await browserSettled();
  await browser.run("loginAdmin(" + JSON.stringify(admin) + "," + JSON.stringify(btc.authToken) + ",3600)");
  assert.equal(browser.run('canOpenAdminTab("config")'),true);
  browser.run('showAdminTab("config")');
  await browserSettled();
  assert.equal(browser.requests.includes("LIST_ROSTER"),false);
  browser.run('showConfigSection("students")');
  await browserSettled();
  assert.match(browser.node("rosterTotals").textContent,/3 học sinh/);
  assert.equal(browser.node("studentRosterCard").hidden,false);
  await browser.run("logout()");
  assert.equal(browser.node("rosterTotals").textContent,"");
  await browser.run("loginAdmin(" + JSON.stringify(supervisor) + "," + JSON.stringify(teacher.authToken) + ",3600)");
  assert.equal(browser.run('canOpenAdminTab("queue")'),true);
  assert.equal(browser.run('canOpenAdminTab("config")'),false);
  assert.equal(browser.run('canOpenAdminTab("stage")'),false);
});

test("liên kết sự kiện cũ yêu cầu xác nhận và giữ nguyên dữ liệu gốc", () => {
  const cloud=fakeAppsScript(), btc=cloud.seedTeacher(admin);
  const legacyId="stemday-2026";
  const stamp="2026-11-21T00:00:00Z";
  const workflow=[
    ["type","id","updatedAt","data"],
    ["queue",legacyId+"::robotics::"+actorA,stamp,
      JSON.stringify({eventId:legacyId,boothId:"robotics",studentCode:actorA,status:"completed",ticketNo:1})]
  ];
  cloud.seedRows("WorkflowState",workflow);
  expectOk(cloud.post("MANAGE_YEAR",{...btc,operation:"create",schoolYear:year}));
  expectOk(cloud.post("MANAGE_YEAR",{...btc,operation:"activate",schoolYear:year}));
  const config={activeEventId:legacyId,events:[{id:legacyId,name:"Sự kiện cũ giả",schoolYear:year}]};
  expectDenied(cloud.post("SAVE_EVENT_CONFIG",{...btc,config}),"LEGACY_REVIEW_REQUIRED");
  assert.deepEqual(cloud.sheets.get("WorkflowState").rows,workflow);
  expectOk(cloud.post("SAVE_EVENT_CONFIG",{...btc,config,confirmLegacyYear:true}));
  assert.deepEqual(cloud.sheets.get("WorkflowState").rows.slice(0,2),workflow);
});

test("HTML có đủ ID mà JavaScript tham chiếu và các handler phân tích được", () => {
  const scriptIndex = appHtml.indexOf("  <script>\n    const GOOGLE_SCRIPT_URL=");
  assert.ok(scriptIndex > 0);
  const markup = appHtml.slice(0, scriptIndex);
  const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  const accepted = new Set([...ids, "headerActiveEvent", "newEventName", "newEventDate"]);
  const scripts = appHtml.slice(scriptIndex) + source("event-roster.js") + source("event-admin.js") + source("event-images.js") + source("student-pass.js");
  assert.equal(ids.length, new Set(ids).size);
  const requested = [...scripts.matchAll(/(?:\$|getElementById)\("([^"]+)"\)/g)].map(match => match[1]);
  assert.deepEqual([...new Set(requested.filter(id => !accepted.has(id)))], []);
  for (const [,handler] of markup.matchAll(/\son\w+="([^"]+)"/g)) new vm.Script("(function(event){"+handler+"})");
  assert.ok(!/mode:"no-cors"|loadRemoteJsonp|localStorage.setItem\(STORE_KEY/.test(scripts));
});

test("giáo viên đi qua gửi OTP, mã sai/đúng, tải dashboard, đồng bộ và kiểm tra phiên khi tải lại", async () => {
  const { cloud }=setup();
  const browser=mockBrowser(cloud);
  await browserSettled();
  const start=browser.requests.length;
  browser.node("teacherEmailInput").value=supervisor;
  await browser.run("sendTeacherOtp()");
  assert.equal(cloud.mail.length,1);
  assert.match(browser.node("teacherOtpStatus").textContent,/Đã gửi OTP/);
  const code=cloud.mail[0].body.match(/\b\d{6}\b/)[0];
  browser.node("teacherOtpInput").value=(code[0]==="0"?"1":"0")+code.slice(1);
  await browser.run("verifyTeacherLogin()");
  assert.equal(browser.run("currentUser"),null);
  assert.ok(browser.notices.some(item=>item.includes("Mã OTP không đúng")));
  browser.node("teacherOtpInput").value=code;
  await browser.run("verifyTeacherLogin()");
  assert.equal(browser.run("currentUser.access.role"),"TEACHER");
  assert.equal(browser.node("adminApp").classList.contains("hidden"),false);
  assert.equal(browser.run("activeAdminTab"),"queue");
  assert.deepEqual(browser.requests.slice(start),[
    "GET_EVENT_API_VERSION","SEND_TEACHER_OTP_V3",
    "GET_EVENT_API_VERSION","VERIFY_TEACHER_OTP_V3",
    "GET_EVENT_API_VERSION","VERIFY_TEACHER_OTP_V3","GET_EVENT_VIEW"
  ]);
  await browser.run("pollRemote()");
  assert.equal(browser.requests.at(-1),"GET_EVENT_VIEW");
  assert.match(browser.node("remoteSyncBadge").innerHTML,/Đã đồng bộ/);
  const reloaded=mockBrowser(cloud,browser.sessionStorage,browser.localStorage);
  await browserSettled();
  assert.deepEqual(reloaded.requests,["GET_EVENT_API_VERSION","CHECK_TEACHER_SESSION","GET_EVENT_VIEW"]);
  assert.equal(reloaded.run("currentUser.email"),supervisor);
  cloud.advance(6*3600000);
  const expired=mockBrowser(cloud,browser.sessionStorage,browser.localStorage);
  await browserSettled();
  assert.equal(expired.requests[1],"CHECK_TEACHER_SESSION");
  assert.equal(expired.run("currentUser"),null);
  assert.equal(expired.run("readTeacherSessionToken()"),null);
  assert.ok(expired.notices.some(item=>item.includes("đã hết hạn")));
});

test("lỗi cấu hình dashboard trả mã tham chiếu an toàn và phân biệt từng giai đoạn", () => {
  const { cloud, teacher, nobody }=setup();
  const checkStage=stage=>{
    const result=cloud.post("GET_EVENT_VIEW",teacher);
    expectDenied(result,"TEACHER_VIEW_UNAVAILABLE");
    assert.match(result.requestRef,/^[0-9a-f-]{36}$/i);
    const [entry]=cloud.logs.at(-1);
    assert.deepEqual(JSON.parse(entry),{
      requestRef:result.requestRef,action:"GET_EVENT_VIEW",stage,code:"TEACHER_VIEW_UNAVAILABLE",
      at:new cloud.context.Date().toISOString(),elapsedMs:0,success:false
    });
    assert.ok(!entry.includes(teacher.authToken));
  };
  cloud.setProperty("FS_EVENT_SPREADSHEET_ID",null);
  expectDenied(cloud.post("GET_EVENT_VIEW",{authToken:"invalid"}),"AUTH_REQUIRED");
  assert.equal(JSON.parse(cloud.logs.at(-1)[0]).code,"AUTH_REQUIRED");
  checkStage("SPREADSHEET_CONFIGURATION");
  cloud.setProperty("FS_EVENT_SPREADSHEET_ID","fixture-spreadsheet");
  const open=cloud.context.SpreadsheetApp.openById;
  cloud.context.SpreadsheetApp.openById=()=>{throw new Error("fixture private data");};
  checkStage("SPREADSHEET_OPEN");
  cloud.context.SpreadsheetApp.openById=open;
  cloud.setProperty("FS_EVENT_ADMINS","{");
  checkStage("ADMIN_GRANTS");
  cloud.setProperty("FS_EVENT_ADMINS",null);
  const row=cloud.sheets.get("EventStaff").rows[1], assignment=row[1];
  row[1]="{";
  checkStage("STAFF_ASSIGNMENTS");
  row[1]=assignment;
  assert.equal(expectOk(cloud.post("GET_EVENT_VIEW",teacher)).access.role,"TEACHER");
  expectDenied(cloud.post("GET_EVENT_VIEW",nobody),"FORBIDDEN");
  assert.equal(cloud.logs.length,6);
  assertTeacherDiagnostics(cloud.logs);
});

test("OTP đã xác minh được dùng tải lại dashboard sau lỗi backend, cùng tab và sau tải lại trang", async () => {
  const { cloud }=setup();
  const browser=mockBrowser(cloud);
  await browserSettled();
  browser.node("teacherEmailInput").value=supervisor;
  await browser.run("sendTeacherOtp()");
  const code=cloud.mail[0].body.match(/\b\d{6}\b/)[0];
  cloud.setProperty("FS_EVENT_SPREADSHEET_ID",null);
  browser.node("teacherOtpInput").value=code;
  await browser.run("verifyTeacherLogin()");
  assert.equal(browser.run("currentUser"),null);
  assert.equal(browser.node("adminApp").classList.contains("hidden"),true);
  assert.equal(browser.node("sendOtpButton").disabled,true);
  assert.match(browser.node("verifyOtpButton").textContent,/Thử tải lại/);
  assert.match(browser.node("teacherOtpStatus").textContent,/Chưa mở được Cổng Giáo viên.*Mã tham chiếu/);
  assert.equal(browser.sessionStorage.values.size,1);
  assert.equal(browser.localStorage.values.size,0);
  expectDenied(cloud.post("VERIFY_TEACHER_OTP_V3",{email:supervisor,otp:code}),"OTP_INVALID");
  const start=browser.requests.length;
  await browser.run("sendTeacherOtp()");
  await browser.run("verifyTeacherLogin()");
  assert.deepEqual(browser.requests.slice(start),["GET_EVENT_VIEW"]);
  assert.equal(cloud.mail.length,1);

  cloud.setProperty("FS_EVENT_SPREADSHEET_ID","fixture-spreadsheet");
  const reloaded=mockBrowser(cloud,browser.sessionStorage,browser.localStorage);
  assert.equal(reloaded.run("currentUser"),null);
  await browserSettled();
  assert.deepEqual(reloaded.requests,["GET_EVENT_API_VERSION","CHECK_TEACHER_SESSION","GET_EVENT_VIEW"]);
  assert.equal(reloaded.run("currentUser.access.role"),"TEACHER");
  const token=reloaded.run("readTeacherSessionToken()");
  await reloaded.run("logout()");
  expectDenied(cloud.post("CHECK_TEACHER_SESSION",{authToken:token}),"AUTH_REQUIRED");
  assert.equal(reloaded.run("readTeacherSessionToken()"),null);
});

test("mất mạng hoặc phản hồi dashboard sai quyền không mở giao diện và vẫn có thể thử lại", async () => {
  const { cloud }=setup();
  const browser=mockBrowser(cloud);
  await browserSettled();
  browser.node("teacherEmailInput").value=supervisor;
  browser.settings.offline=true;
  await browser.run("sendTeacherOtp()");
  assert.match(browser.node("teacherOtpStatus").textContent,/Không kết nối được Apps Script/);
  assert.equal(cloud.mail.length,0);
  browser.settings.offline=false;
  await browser.run("sendTeacherOtp()");
  const code=cloud.mail[0].body.match(/\b\d{6}\b/)[0];
  browser.settings.offlineAction="GET_EVENT_VIEW";
  browser.node("teacherOtpInput").value=code;
  await browser.run("verifyTeacherLogin()");
  assert.equal(browser.run("currentUser"),null);
  assert.match(browser.node("teacherOtpStatus").textContent,/Chưa mở được Cổng Giáo viên.*Không kết nối/);
  delete browser.settings.offlineAction;
  browser.settings.reply=payload=>payload.action==="GET_EVENT_VIEW"?cloud.post("GET_EVENT_VIEW"):undefined;
  await browser.run("verifyTeacherLogin()");
  assert.equal(browser.run("currentUser"),null);
  assert.match(browser.node("teacherOtpStatus").textContent,/sai định dạng/);
  delete browser.settings.reply;
  await browser.run("verifyTeacherLogin()");
  assert.equal(browser.run("currentUser.access.role"),"TEACHER");
  assert.equal(browser.requests.filter(action=>action==="VERIFY_TEACHER_OTP_V3").length,1);
  assert.equal(cloud.mail.length,1);
});

test("phiên chờ khi hết hạn, đổi email hoặc đăng xuất không mở nhầm tài khoản", async t=>{
  for(const change of ["expiry","email","logout"]){
    await t.test(change,async()=>{
      const { cloud }=setup();
      const browser=mockBrowser(cloud);
      await browserSettled();
      browser.node("teacherEmailInput").value=supervisor;
      await browser.run("sendTeacherOtp()");
      browser.node("teacherOtpInput").value=cloud.mail[0].body.match(/\b\d{6}\b/)[0];
      browser.settings.offlineAction="GET_EVENT_VIEW";
      await browser.run("verifyTeacherLogin()");
      assert.equal(browser.sessionStorage.values.size,1);
      delete browser.settings.offlineAction;
      const start=browser.requests.length;
      const token=browser.run("readTeacherSessionToken()");
      if(change==="expiry")cloud.advance(6*3600000);
      if(change==="email")browser.node("teacherEmailInput").value=admin;
      if(change==="logout")await browser.run("logout()");
      else await browser.run("verifyTeacherLogin()");
      assert.equal(browser.run("currentUser"),null);
      assert.equal(browser.run("readTeacherSessionToken()"),null);
      if(change==="logout"){
        assert.deepEqual(browser.requests.slice(start),["GET_EVENT_VIEW","LOGOUT_TEACHER"]);
        expectDenied(cloud.post("CHECK_TEACHER_SESSION",{authToken:token}),"AUTH_REQUIRED");
      }else assert.deepEqual(browser.requests.slice(start),[]);
    });
  }
});

test("kiểm tra phiên bản, xác thực, action lạ và dữ liệu ghi thiếu trường đi đúng nhánh", () => {
  const { cloud, teacher, btc }=setup();
  const before={...cloud.metrics};
  const version=expectOk(cloud.post("GET_EVENT_API_VERSION"));
  assert.deepEqual(version,{success:true,apiVersion:"event-pass-scoped-v1",otpVersion:"teacher-otp-v3",teacherPortalVersion:"teacher-portal-v1",studentAccessVersion,eventActivationVersion:"event-activation-v1",eventDeleteVersion:"event-delete-v1",eventAdminVersion:"event-admin-setup-v2",eventImageVersion:"event-images-v3"});
  for(const action of ["GET_EVENT_API_VERSION","SEND_TEACHER_OTP_V3","VERIFY_TEACHER_OTP_V3","CHECK_TEACHER_SESSION"]){
    expectDenied(JSON.parse(cloud.get({action}).value),"METHOD_NOT_ALLOWED");
  }
  assert.deepEqual(cloud.metrics,before);
  assert.equal(cloud.mail.length,0);
  assert.equal(expectOk(cloud.post("CHECK_TEACHER_SESSION",teacher)).email,supervisor);
  expectDenied(cloud.post("CHECK_TEACHER_SESSION"),"AUTH_REQUIRED");
  expectDenied(cloud.post("FIXTURE_UNKNOWN",btc),"METHOD_NOT_ALLOWED");
  expectDenied(cloud.post("SYNC_RECORD",{...btc,record:{type:"queue",id:"fixture"}}),"METHOD_NOT_ALLOWED");
  expectDenied(cloud.post("TEACHER_COMPLETE",{...teacher,eventId,boothId:"robotics"}),"INVALID_INPUT");
  assert.equal(cloud.metrics.writes,before.writes);
});

test("bản triển khai chỉ có Code.gs báo thiếu thành phần API sự kiện", () => {
  const context=vm.createContext({
    ContentService:{
      MimeType:{JSON:"JSON"},
      createTextOutput:value=>({value,setMimeType(){return this;}})
    }
  });
  backend[0].runInContext(context);
  const response=context.doPost({postData:{contents:JSON.stringify({action:"GET_EVENT_API_VERSION"})}});
  expectDenied(JSON.parse(response.value),"API_VERSION_MISMATCH");
});

test("Apps Script cũ được báo lệch phiên bản trước khi gửi hoặc tiêu thụ OTP", async () => {
  const { cloud }=setup();
  const settings={reply:payload=>payload.action==="GET_EVENT_API_VERSION"
    ? {success:false,status:"error",message:"Bản ghi đồng bộ không hợp lệ."} : undefined};
  const browser=mockBrowser(cloud,undefined,undefined,settings);
  await browserSettled();
  browser.node("teacherEmailInput").value=supervisor;
  await browser.run("sendTeacherOtp()");
  assert.equal(browser.requests.includes("SEND_TEACHER_OTP_V3"),false);
  assert.equal(cloud.mail.length,0);
  assert.match(browser.node("teacherOtpStatus").textContent,/GET_EVENT_API_VERSION.*cập nhật bản triển khai/);
  browser.node("teacherOtpInput").value="010101";
  await browser.run("verifyTeacherLogin()");
  assert.equal(browser.requests.includes("VERIFY_TEACHER_OTP_V3"),false);
  assert.equal(browser.run("currentUser"),null);
});

test("kiểm tra phiên bản phân biệt thiếu API, thiếu handler, sai phiên bản, định dạng và phương thức", async t => {
  const expected={success:true,apiVersion:"event-pass-scoped-v1",otpVersion:"teacher-otp-v3",teacherPortalVersion:"teacher-portal-v1",studentAccessVersion};
  const cases=[
    ["thiếu handler",{success:false,code:"METHOD_NOT_ALLOWED"},/chưa hỗ trợ GET_EVENT_API_VERSION/],
    ["thiếu thành phần backend",{success:false,code:"API_VERSION_MISMATCH"},/thiếu thành phần API sự kiện/],
    ["API sự kiện cũ",{...expected,apiVersion:"event-pass-fixture-old"},/không tương thích.*event-pass-scoped-v1/],
    ["API OTP cũ",{...expected,otpVersion:"teacher-otp-v2"},/không tương thích.*teacher-otp-v3/],
    ["bản cũ cùng API sự kiện và OTP",{...expected,teacherPortalVersion:undefined},/chưa hỗ trợ Cổng Giáo viên/],
    ["thiếu trường phiên bản",{success:true,otpVersion:"teacher-otp-v3"},/thiếu trường phiên bản hợp lệ/],
    ["sai cấu trúc",{apiVersion:"event-pass-scoped-v1"},/sai định dạng/],
    ["phản hồi HTML",new SyntaxError("fixture HTML"),/sai định dạng/],
    ["POST bị từ chối",405,/từ chối phương thức POST.*405/],
    ["sai URL",404,/không tìm thấy bản triển khai.*404/]
  ];
  for(const [name,reply,message] of cases){
    await t.test(name,async()=>{
      const cloud=fakeAppsScript();
      const versionResponse=typeof reply==="number"
        ? {ok:false,status:reply}
        : {ok:true,json:async()=>{if(reply instanceof Error)throw reply;return reply;}};
      const browser=mockBrowser(cloud,undefined,undefined,{versionResponse});
      await browserSettled();
      const start=browser.requests.length;
      browser.node("teacherEmailInput").value=supervisor;
      await browser.run("sendTeacherOtp()");
      assert.deepEqual(browser.requests.slice(start),["GET_EVENT_API_VERSION"]);
      assert.match(browser.node("teacherOtpStatus").textContent,message);
      assert.match(browser.node("teacherOtpStatus").textContent,/đối chiếu URL và cập nhật bản triển khai/);
      assert.equal(cloud.mail.length,0);
    });
  }
});

test("lỗi đọc GET_EVENT_VIEW từ bản cũ được báo đúng action, giữ kiểm tra phiên và không lặp poll", async () => {
  const { cloud, teacher }=setup();
  const browser=mockBrowser(cloud);
  await browserSettled();
  await browser.run("loginAdmin("+JSON.stringify(supervisor)+","+JSON.stringify(teacher.authToken)+",3600)");
  const legacyView=payload=>payload.action==="GET_EVENT_VIEW"
    ? {success:false,status:"error",message:"Bản ghi đồng bộ không hợp lệ."} : undefined;
  browser.settings.reply=legacyView;
  await browser.run("pollRemote()");
  assert.equal(browser.run("remoteTimer"),null);
  assert.match(browser.node("remoteSyncBadge").innerHTML,/chưa đúng phiên bản/);
  assert.ok(browser.notices.some(item=>item.includes("GET_EVENT_VIEW")));
  const reloaded=mockBrowser(cloud,browser.sessionStorage,browser.localStorage,{reply:legacyView});
  await browserSettled();
  assert.deepEqual(reloaded.requests.slice(0,3),["GET_EVENT_API_VERSION","CHECK_TEACHER_SESSION","GET_EVENT_VIEW"]);
  assert.equal(reloaded.run("currentUser"),null);
  assert.equal(reloaded.node("adminApp").classList.contains("hidden"),true);
  assert.ok(reloaded.notices.some(item=>item.includes("GET_EVENT_VIEW")));
});

test("dòng phân công trống giữa hai dòng Sheets không chặn giáo viên được phân công", () => {
  const { cloud, teacher, nobody }=setup();
  cloud.sheets.get("EventStaff").rows.splice(1,0,["",""]);
  const before=cloud.metrics.writes;
  assert.equal(expectOk(cloud.post("GET_EVENT_VIEW",teacher)).access.role,"TEACHER");
  expectDenied(cloud.post("GET_EVENT_VIEW",nobody),"FORBIDDEN");
  assert.equal(cloud.metrics.writes,before);
});

test("lỗi JavaScript lúc mở Cổng trả về form, cho thử lại bằng cùng phiên", async () => {
  const { cloud }=setup();
  const browser=mockBrowser(cloud);
  await browserSettled();
  browser.node("teacherEmailInput").value=supervisor;
  await browser.run("sendTeacherOtp()");
  browser.node("teacherOtpInput").value=cloud.mail[0].body.match(/\b\d{6}\b/)[0];
  browser.run('const originalRenderQueue=renderQueue;renderQueue=()=>{throw new Error("fixture private detail");}');
  await browser.run("verifyTeacherLogin()");
  assert.equal(browser.run("!!currentUser"),false);
  assert.equal(browser.node("adminApp").classList.contains("hidden"),true);
  assert.equal(browser.node("loginView").classList.contains("hidden"),false);
  assert.match(browser.node("teacherOtpStatus").textContent,/PORTAL_INIT_FAILED/);
  assert.doesNotMatch(browser.node("teacherOtpStatus").textContent,/fixture private detail/);
  assert.equal(browser.run("remoteTimer"),null);
  browser.run("renderQueue=originalRenderQueue");
  const start=browser.requests.length;
  await browser.run("verifyTeacherLogin()");
  assert.equal(browser.run("currentUser.access.role"),"TEACHER");
  assert.deepEqual(browser.requests.slice(start),["GET_EVENT_VIEW"]);
  assert.equal(cloud.mail.length,1);
});

test("chỉ tiêu thụ OTP sau khi đọc lại được phiên vừa tạo", () => {
  const cloud=fakeAppsScript();
  expectOk(cloud.post("SEND_TEACHER_OTP_V3",{email:admin}));
  const otp=cloud.mail[0].body.match(/\b\d{6}\b/)[0];
  const put=cloud.cache.put;
  cloud.cache.put=()=>{};
  const failed=cloud.post("VERIFY_TEACHER_OTP_V3",{email:admin,otp});
  expectDenied(failed,"SESSION_CREATE_FAILED");
  assert.equal(JSON.parse(cloud.logs.at(-1)[0]).stage,"SESSION_CREATE");
  cloud.cache.put=put;
  const verified=expectOk(cloud.post("VERIFY_TEACHER_OTP_V3",{email:admin,otp}));
  expectOk(cloud.post("CHECK_TEACHER_SESSION",{authToken:verified.token}));
  expectDenied(cloud.post("VERIFY_TEACHER_OTP_V3",{email:admin,otp}),"OTP_INVALID");
  assert.equal(cloud.mail.length,1);
});

test("email FPT chưa được phân công chỉ mở Cổng sau khi BTC cấp đúng gian", async()=>{
  const { cloud,btc }=setup(), browser=mockBrowser(cloud);
  await browserSettled();
  browser.node("teacherEmailInput").value=unassigned;
  await browser.run("sendTeacherOtp()");
  browser.node("teacherOtpInput").value=cloud.mail[0].body.match(/\b\d{6}\b/)[0];
  await browser.run("verifyTeacherLogin()");
  assert.equal(browser.run("currentUser"),null);
  assert.match(browser.node("teacherOtpStatus").textContent,/chưa được BTC phân quyền/);
  assert.equal(browser.node("headerSession").classList.contains("hidden"),false);
  expectOk(cloud.post("SET_EVENT_ASSIGNMENT",{...btc,email:unassigned,eventId,boothId:"robotics",enabled:true}));
  await browser.run("refreshEventNow()");
  assert.equal(browser.run("currentUser.access.role"),"TEACHER");
  assert.deepEqual(Array.from(browser.run('BOOTHS.filter(booth=>canManageFrontBooth(booth.id)).map(booth=>booth.id)')),["robotics"]);
  assert.equal(cloud.mail.length,1);
});

test("khôi phục sau mất mạng hoặc timeout khi kiểm tra phiên mà không xin OTP mới",async t=>{
  for(const failure of ["offline","timeout"]){
    await t.test(failure,async()=>{
      const { cloud,teacher }=setup(), storage=mockStore(), saved=mockStore();
      // The server must check sessionStorage even if localStorage claims an administrator role.
      saved.setItem("fsevent_teacher",JSON.stringify({role:"admin",email:admin}));
      const guest=mockBrowser(cloud,undefined,saved);
      await browserSettled();
      assert.equal(guest.run("currentUser"),null);
      storage.setItem(guest.run("TEACHER_SESSION_KEY"),teacher.authToken);
      const settings=failure==="offline"?{offlineAction:"CHECK_TEACHER_SESSION"}:{reply:payload=>{
        if(payload.action==="CHECK_TEACHER_SESSION"){const error=new Error();error.name="AbortError";throw error;}
      }};
      const browser=mockBrowser(cloud,storage,saved,settings);
      await browserSettled();
      assert.equal(browser.run("currentUser"),null);
      assert.match(browser.node("teacherOtpStatus").textContent,failure==="offline"?/Không kết nối/:/không phản hồi kịp/);
      assert.equal(browser.node("sendOtpButton").disabled,true);
      delete settings.reply;
      delete settings.offlineAction;
      const start=browser.requests.length;
      await browser.run("verifyTeacherLogin()");
      assert.deepEqual(browser.requests.slice(start),["GET_EVENT_API_VERSION","CHECK_TEACHER_SESSION","GET_EVENT_VIEW"]);
      assert.equal(browser.run("currentUser.access.role"),"TEACHER");
      assert.equal(cloud.mail.length,0);
    });
  }
});

test("dashboard thiếu cấu hình hoặc nhận lỗi chung vẫn cho phép thử lại mà không lộ dữ liệu",async()=>{
  const { cloud,teacher }=setup(), browser=mockBrowser(cloud);
  await browserSettled();
  const key=browser.run("TEACHER_SESSION_KEY");
  browser.sessionStorage.setItem(key,teacher.authToken);
  browser.settings.reply=payload=>payload.action==="GET_EVENT_VIEW"&&payload.authToken?
    {...cloud.post("GET_EVENT_VIEW",teacher), records:[]}:undefined;
  await browser.run("restoreAppSession()");
  assert.equal(browser.run("currentUser"),null);
  assert.match(browser.node("teacherOtpStatus").textContent,/PORTAL_DATA_INVALID/);
  browser.settings.reply=payload=>payload.action==="GET_EVENT_VIEW"&&payload.authToken?
    {success:false,code:"EVENT_UNAVAILABLE",message:"Ứng dụng chưa thể xử lý."}:undefined;
  await browser.run("verifyTeacherLogin()");
  assert.match(browser.node("teacherOtpStatus").textContent,/nhật ký GET_EVENT_VIEW/);
  assert.equal(browser.run("remoteTimer"),null);
  delete browser.settings.reply;
  await browser.run("verifyTeacherLogin()");
  assert.equal(browser.run("currentUser.access.role"),"TEACHER");
  assert.equal(cloud.mail.length,0);
});

test("đồng bộ rút gọn vẫn kiểm tra phiên, phạm vi, hàng đợi và quyền vừa thu hồi", () => {
  const {cloud,btc,teacher}=setup();
  const [a,b]=studentLogins(cloud,btc,[actorA,actorB]).map(item=>redeem(cloud,item));
  const secondTeacher=cloud.seedTeacher(unassigned);
  expectOk(cloud.post("SET_EVENT_ASSIGNMENT",{...btc,eventId,boothId:"chemistry",email:unassigned,enabled:true}));
  const read=(actor,knownRevision="")=>cloud.post("GET_EVENT_VIEW",{...actor,knownRevision});
  const latestA=expectOk(read(a));
  assert.equal(expectOk(read(a,latestA.viewRevision)).unchanged,true);
  const latestB=expectOk(read(b,latestA.viewRevision));
  assert.notEqual(latestA.viewRevision,latestB.viewRevision);
  assert.equal(latestB.profile.code,actorB);
  assert.equal(latestB.records.some(record=>record.id===actorA),false);
  const first=expectOk(cloud.post("JOIN_QUEUE",{...a,eventId,boothId:"robotics"})).record;
  const second=expectOk(cloud.post("JOIN_QUEUE",{...b,eventId,boothId:"robotics"})).record;
  const other=expectOk(cloud.post("JOIN_QUEUE",{...b,eventId,boothId:"chemistry"})).record;
  assert.deepEqual([first.data.ticketNo,second.data.ticketNo,other.data.ticketNo],[1,2,1]);
  const miss=cloud.post("TEACHER_COMPLETE",{...teacher,eventId,boothId:"robotics",ids:[second.id]});
  expectDenied(miss,"CONFLICT");
  expectOk(cloud.post("TEACHER_COMPLETE",{...teacher,eventId,boothId:"robotics",ids:[first.id]}));
  expectOk(cloud.post("TEACHER_COMPLETE",{...secondTeacher,eventId,boothId:"chemistry",ids:[other.id]}));
  const nextA=expectOk(read(a,latestA.viewRevision));
  assert.equal(nextA.records.find(record=>record.id===first.id).data.status,"completed");
  assert.equal(nextA.records.some(record=>[second.id,other.id].includes(record.id)),false);
  const beforeRevoke=expectOk(read(teacher));
  expectOk(cloud.post("SET_EVENT_ASSIGNMENT",{...btc,eventId,boothId:"robotics",email:supervisor,enabled:false}));
  expectDenied(read(teacher,beforeRevoke.viewRevision),"FORBIDDEN");
  expectOk(cloud.post("LOGOUT_STUDENT",a));
  expectDenied(read(a,nextA.viewRevision),"AUTH_REQUIRED");
});

test("đồng bộ chậm gộp thao tác làm mới và bỏ phản hồi từ trước lần ghi", async () => {
  const {cloud,btc}=setup();
  const browser=mockBrowser(cloud);
  await activateStudentInBrowser(browser,studentLogins(cloud,btc,[actorA])[0]);
  await browser.run("pollRemote()");
  browser.node("studentPassButton").click();
  browser.run("let fullRenders=0; const originalActiveView=renderActiveView; renderActiveView=(...args)=>{fullRenders++;return originalActiveView(...args);}");
  await browser.run("pollRemote()");
  assert.equal(browser.run("fullRenders"),0);
  browser.run('openStudentEvent(activeEvent().id);openBoothModal("robotics")');
  let release;
  browser.settings.reply=payload=>{
    if(payload.action!=="GET_EVENT_VIEW"||release)return;
    const stale=cloud.post(payload.action,payload);
    return new Promise(resolve=>{release=()=>resolve(stale);});
  };
  const start=browser.requests.length;
  const read=browser.run("pollRemote()");
  await browserSettled();
  await Promise.all([browser.run("refreshEventNow()"),browser.run("refreshEventNow()")]);
  assert.deepEqual(browser.requests.slice(start),["GET_EVENT_VIEW"]);
  await browser.run("requestExperience()");
  assert.equal(browser.run("appState.queue[0].status"),"waiting");
  release();
  await read;
  await browserSettled();
  assert.deepEqual(browser.requests.slice(start),["GET_EVENT_VIEW","JOIN_QUEUE","GET_EVENT_VIEW"]);
  assert.equal(browser.run("appState.queue[0].status"),"waiting");
  assert.equal(passStamps(browser).length,0);
  expectOk(cloud.post("TEACHER_COMPLETE",{...btc,eventId,boothId:"robotics",ids:[browser.run("appState.queue[0].id")]}));
  await browser.run("pollRemote()");
  assert.equal(passStamps(browser).length,1);
});

test("yêu cầu danh sách trùng được gộp, lựa chọn mới thắng phản hồi đến muộn", async () => {
  const {cloud,btc}=setup(395), browser=mockBrowser(cloud);
  await browserSettled();
  await browser.run("loginAdmin("+JSON.stringify(admin)+","+JSON.stringify(btc.authToken)+",3600)");
  let release;
  browser.settings.reply=payload=>{
    if(payload.action!=="LIST_ROSTER"||release)return;
    const snapshot=cloud.post(payload.action,payload);
    return new Promise(resolve=>{release=()=>resolve(snapshot);});
  };
  const start=browser.requests.length;
  const first=browser.run("loadRoster()");
  const repeat=browser.run("loadRoster()");
  assert.equal(first,repeat);
  await browserSettled();
  await browser.run('loadRoster("2027-2028")');
  release();
  await first;
  assert.deepEqual(browser.requests.slice(start),["LIST_ROSTER","LIST_ROSTER"]);
  assert.equal(browser.run("rosterDesk.schoolYear"),"2027-2028");
  assert.equal(browser.run("rosterDesk.roster.length"),0);
  await browser.run("loadRoster()");
  assert.equal(browser.node("rosterRows").children.length,395);
});

const tinyPng = { mime:"image/png", content:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX2QAAAAASUVORK5CYII=" };
const mediaFrom = (view, id) => view.records.find(record => record.id === "event-config").data.events.find(event => event.id === id)?.images;

test("ảnh Drive theo sự kiện, xem trước BTC, phân phối có phê duyệt và khôi phục", () => {
  const {cloud,btc,teacher,events}=setup();
  const b=events[1].id;
  cloud.setProperty("FS_EVENT_IMAGE_FOLDER_ID","fixture-images");
  const upload=(eventId,expectedRevision="",kind="theme",layout={mode:"auto"}) => ({
    ...btc,eventId,kind,expectedRevision,operation:"upload",upload:tinyPng,layout,publishApproved:true
  });
  const publicAsset=(eventId,version,kind="theme") => JSON.parse(cloud.get({action:"GET_EVENT_IMAGE",eventId,kind,version}).value);
  expectDenied(cloud.post("SAVE_EVENT_IMAGE",{...upload(eventId),...teacher}),"FORBIDDEN");
  const student=redeem(cloud,studentLogins(cloud,btc,[actorA])[0]);
  expectDenied(cloud.post("SAVE_EVENT_IMAGE",{eventId,kind:"theme",...student}),"AUTH_REQUIRED");
  expectDenied(cloud.post("SAVE_EVENT_IMAGE",upload("missing-event")),"INVALID_INPUT");
  for (const rejected of [{mime:"image/svg+xml",content:tinyPng.content},
    {mime:"image/png",content:Buffer.from("<svg></svg>").toString("base64")}]) {
    expectDenied(cloud.post("SAVE_EVENT_IMAGE",{...upload(eventId),upload:rejected}),"IMAGE_FORMAT");
  }
  expectDenied(cloud.post("SAVE_EVENT_IMAGE",{...upload(eventId),
    upload:{...tinyPng,content:"A".repeat(4 * Math.ceil(1024 * 1024 / 3) + 4)}}),"IMAGE_SIZE");
  assert.equal(cloud.imageFiles.size,0);

  const aImage=expectOk(cloud.post("SAVE_EVENT_IMAGE",upload(eventId))).images;
  const bImage=expectOk(cloud.post("SAVE_EVENT_IMAGE",upload(b))).images;
  assert.notEqual(aImage.theme.version,bImage.theme.version);
  const aQuery={eventId,kind:"theme",version:aImage.theme.version};
  assert.equal(expectOk(cloud.post("PREVIEW_EVENT_IMAGE",{...btc,...aQuery})).content,tinyPng.content);
  expectDenied(cloud.post("PREVIEW_EVENT_IMAGE",{...teacher,...aQuery}),"FORBIDDEN");
  assert.equal(mediaFrom(expectOk(cloud.post("GET_EVENT_VIEW",student)),eventId),undefined);
  expectDenied(publicAsset(eventId,aImage.theme.version),"IMAGE_UNAVAILABLE");

  cloud.setProperty("FS_EVENT_PUBLIC_IMAGES","true");
  assert.equal(expectOk(publicAsset(eventId,aImage.theme.version)).content,tinyPng.content);
  assert.equal(mediaFrom(expectOk(cloud.post("GET_EVENT_VIEW",student)),eventId).theme.version,aImage.theme.version);
  expectDenied(publicAsset(b,bImage.theme.version),"IMAGE_UNAVAILABLE");
  expectDenied(publicAsset(eventId,bImage.theme.version),"IMAGE_UNAVAILABLE");

  expectOk(cloud.post("SAVE_EVENT_CONFIG",{...btc,config:{activeEventId:b,events}}));
  assert.equal(expectOk(publicAsset(b,bImage.theme.version)).content,tinyPng.content);
  const bReplacement=expectOk(cloud.post("SAVE_EVENT_IMAGE",upload(b,bImage.revision))).images;
  expectDenied(cloud.post("SAVE_EVENT_IMAGE",upload(b,bImage.revision)),"CONFLICT");
  assert.equal(cloud.imageFiles.size,3);
  expectDenied(publicAsset(b,bImage.theme.version),"IMAGE_UNAVAILABLE");
  const restore=(operation,expectedRevision)=>cloud.post("SAVE_EVENT_IMAGE",{...btc,eventId:b,kind:"theme",operation,expectedRevision});
  const earlier=expectOk(restore("restore",bReplacement.revision)).images;
  assert.equal(earlier.theme.version,bImage.theme.version);
  assert.equal(expectOk(publicAsset(b,bImage.theme.version)).content,tinyPng.content);
  const empty=expectOk(restore("default",earlier.revision)).images;
  assert.equal(empty.theme.version,undefined);
  const restored=expectOk(restore("restore",empty.revision)).images;
  assert.equal(restored.theme.version,bImage.theme.version);

  const archived=events.map(event=>event.id===b?{...event,archived:true,published:true}:event);
  expectOk(cloud.post("SAVE_EVENT_CONFIG",{...btc,config:{activeEventId:eventId,events:archived}}));
  assert.equal(expectOk(publicAsset(eventId,aImage.theme.version)).content,tinyPng.content);
  expectDenied(publicAsset(b,restored.theme.version),"IMAGE_UNAVAILABLE");
  assert.equal(expectOk(cloud.post("PREVIEW_EVENT_IMAGE",{...btc,eventId:b,kind:"theme",version:restored.theme.version})).content,tinyPng.content);
  const view=JSON.stringify(expectOk(cloud.post("GET_EVENT_VIEW",btc)));
  assert.ok(!view.includes("private-fixture") && !view.includes(tinyPng.content));
  const imageRows=cloud.sheets.get("WorkflowState").rows.filter(row=>row[1].startsWith("event-images:"));
  assert.equal(imageRows.length,2);
  assert.ok(imageRows.every(row=>!row[3].includes(tinyPng.content)));
  cloud.imageFiles.clear();
  expectDenied(publicAsset(eventId,aImage.theme.version),"IMAGE_UNAVAILABLE");
});

test("bố trí phiếu kiểm tra boothId, dung lượng mẫu, vòng tròn chồng lấn và chế độ mặc định", () => {
  const {cloud,btc}=setup();
  cloud.setProperty("FS_EVENT_IMAGE_FOLDER_ID","fixture-images");
  cloud.setProperty("FS_EVENT_PUBLIC_IMAGES","true");
  const view=expectOk(cloud.post("GET_EVENT_VIEW",btc));
  const booths=view.records.find(record=>record.id==="booth-config").data.boothList;
  const slots=booths.map((booth,i)=>({boothId:booth.id,x:20+i%3*30,y:i<3?25:75,size:18}));
  const input={...btc,eventId,kind:"passport",operation:"upload",expectedRevision:"",upload:tinyPng,publishApproved:true};
  const layout={mode:"template",capacity:11,slots};
  const save=patch=>cloud.post("SAVE_EVENT_IMAGE",{...input,layout:{...layout,...patch}});
  expectDenied(save({capacity:5}),"IMAGE_LAYOUT");
  expectDenied(save({slots:[...slots.slice(0,-1),slots[0]]}),"IMAGE_LAYOUT");
  expectDenied(save({slots:[{...slots[0],x:2},...slots.slice(1)]}),"IMAGE_LAYOUT");
  expectDenied(save({slots:[{...slots[0],x:slots[1].x},...slots.slice(1)]}),"IMAGE_LAYOUT");
  const saved=expectOk(save({})).images;
  const publicView=expectOk(cloud.post("GET_EVENT_VIEW"));
  assert.deepEqual(mediaFrom(publicView,eventId).passport.layout,layout);
  expectOk(cloud.post("SAVE_EVENT_IMAGE",{...input,operation:"layout",layout:{mode:"auto"},expectedRevision:saved.revision}));
  assert.deepEqual(mediaFrom(expectOk(cloud.post("GET_EVENT_VIEW")),eventId).passport.layout,{mode:"auto"});
  assert.equal(cloud.imageFiles.size,1);
});

test("frontend học sinh chặn backend cũ và bỏ phiên kích hoạt cũ khi tải lại", async () => {
  const {cloud,btc}=setup();
  const [student]=studentLogins(cloud,btc,[actorA]);
  const stored=mockStore();
  stored.setItem("fs-event-student-session-v1",JSON.stringify({code:actorA,eventId,token:"0".repeat(64)}));
  const oldView=payload=>{
    if(payload.action!=="GET_EVENT_VIEW")return;
    const result=cloud.post(payload.action,payload);
    delete result.studentAccessVersion;
    return result;
  };
  const browser=mockBrowser(cloud,stored,undefined,{reply:oldView});
  await browserSettled();
  assert.equal(stored.getItem("fs-event-student-session-v1"),null);
  assert.match(browser.node("studentLoginEvent").textContent,/phiên bản mới/);
  assert.equal(browser.node("studentLoginButton").disabled,true);
  browser.node("studentCodeInput").value=student.code;
  browser.node("studentAccessInput").value=student.accessCode;
  await browser.run("submitStudentLogin({preventDefault(){}})");
  assert.equal(browser.requests.includes("LOGIN_STUDENT"),false);

  const session=redeem(cloud,student);
  stored.setItem("fs-event-student-session-v2",JSON.stringify(session.studentSession));
  const reloaded=mockBrowser(cloud,stored,undefined,{reply:oldView});
  await browserSettled();
  assert.equal(reloaded.run("currentUser"),null);
  assert.match(reloaded.node("studentLoginEvent").textContent,/phiên bản mới/);
});

test("xác nhận ghi trả đúng bản chiếu dưới quyền và từ chối sai sự kiện", () => {
  const {cloud,btc,teacher,events}=setup(), boothId="robotics";
  const [student]=studentLogins(cloud,btc,[actorA]).map(item=>redeem(cloud,item));
  const booths=expectOk(cloud.post("GET_EVENT_VIEW",btc)).records.find(r=>r.id==="booth-config").data.boothList;
  for(const [action,payload] of [["SAVE_EVENT_BOOTHS",{booths}],["SAVE_EVENT_CONFIG",{config:{events,activeEventId:eventId}}]]){
    for(const auth of [teacher,student]){
      const denied=cloud.post(action,{...payload,...auth,eventId});
      expectDenied(denied,"FORBIDDEN");
      assert.equal(denied.change,undefined);
    }
    expectDenied(cloud.post(action,{...btc,...payload,eventId:events[1].id}),"CONFLICT");
  }
  const {change}=expectOk(cloud.post("SAVE_EVENT_BOOTHS",{...btc,eventId,booths:booths.map(b=>({...b,name:" "+b.name+" ",privateField:"fixture"}))}));
  assert.deepEqual(change,{eventId,booths});
  const {record}=expectOk(cloud.post("JOIN_QUEUE",{...student,eventId,boothId}));
  const payload={eventId,boothId,ids:[record.id]};
  expectDenied(cloud.post("TEACHER_COMPLETE",{...student,...payload}),"FORBIDDEN");
  const completed=expectOk(cloud.post("TEACHER_COMPLETE",{...teacher,...payload})).change;
  const official=expectOk(cloud.post("GET_EVENT_VIEW",teacher)).records.find(row=>row.id===record.id);
  assert.deepEqual(completed,{eventId,boothId,records:[official]});
  const duplicate=cloud.post("TEACHER_COMPLETE",{...btc,...payload});
  expectDenied(duplicate,"CONFLICT");
  assert.equal(duplicate.change,undefined);
  const switched=expectOk(cloud.post("SAVE_EVENT_CONFIG",{...btc,eventId,config:{activeEventId:events[1].id,events}})).change;
  const config=expectOk(cloud.post("GET_EVENT_VIEW",btc)).records.find(r=>r.id==="event-config").data;
  assert.deepEqual(switched,{eventId:events[1].id,config});
});

test("xác nhận cập nhật hàng chờ ngay, poll cũ và mất mạng không hoàn tác hoặc gửi lại", async () => {
  const {cloud,btc,teacher}=setup(), boothId="robotics";
  const students=studentLogins(cloud,btc,[actorA,actorB]).map(item=>redeem(cloud,item));
  const ids=students.map(session=>expectOk(cloud.post("JOIN_QUEUE",{...session,eventId,boothId})).record.id);
  const browser=mockBrowser(cloud);
  await browserSettled();
  await browser.run("loginAdmin("+JSON.stringify(supervisor)+","+JSON.stringify(teacher.authToken)+",3600)");
  let releaseRead,releaseWrite;
  browser.settings.reply=body=>{
    if(body.action==="GET_EVENT_VIEW"&&!releaseRead){
      const old=cloud.post(body.action,body);
      return new Promise(resolve=>{releaseRead=()=>resolve(old);});
    }
    if(body.action==="TEACHER_COMPLETE")return new Promise(resolve=>{releaseWrite=()=>resolve(cloud.post(body.action,body));});
  };
  const start=browser.requests.length;
  const oldPoll=browser.run("pollRemote()");
  await browserSettled();
  const write=browser.run("handleTeacherQueueAction('TEACHER_COMPLETE','Đã xác nhận.')");
  await browserSettled();
  assert.equal(browser.run("appState.queue[0].status"),"waiting");
  assert.equal(browser.notices.some(text=>text.includes("Đã xác nhận.")),false);
  releaseWrite();
  await write;
  assert.equal(browser.run("mutationBusy"),false);
  assert.equal(browser.run("appState.queue[0].status"),"completed");
  assert.equal(browser.run("currentServingItem(activeEvent().id,'robotics').id"),ids[1]);
  assert.equal(browser.node("teacherBoothCard").innerHTML.includes(actorB),true);
  browser.settings.offlineAction="GET_EVENT_VIEW";
  releaseRead();
  await oldPoll;
  await browserSettled();
  assert.match(browser.node("remoteSyncBadge").innerHTML,/Đã lưu, đang chờ đồng bộ/);
  assert.equal(browser.run("appState.queue[0].status"),"completed");
  delete browser.settings.offlineAction;
  await browser.run("refreshEventNow()");
  assert.match(browser.node("remoteSyncBadge").innerHTML,/Đã đồng bộ/);
  assert.deepEqual(browser.requests.slice(start),["GET_EVENT_VIEW","TEACHER_COMPLETE","GET_EVENT_VIEW","GET_EVENT_VIEW"]);
});

test("lưu gian hàng và đổi sự kiện giải phóng nút trước đối soát, xóa dữ liệu thuộc sự kiện cũ", async () => {
  const {cloud,btc,events}=setup(), browser=mockBrowser(cloud);
  const [student]=studentLogins(cloud,btc,[actorA]).map(item=>redeem(cloud,item));
  expectOk(cloud.post("JOIN_QUEUE",{...student,eventId,boothId:"robotics"}));
  await browserSettled();
  await browser.run("loginAdmin("+JSON.stringify(admin)+","+JSON.stringify(btc.authToken)+",3600)");
  let reads=[];
  browser.settings.reply=p=>{
    if(p.action==="GET_EVENT_VIEW"){
      const response=cloud.post(p.action,p);
      return new Promise(resolve=>reads.push(()=>resolve(response)));
    }
  };
  await browser.run("performEventAction('SAVE_EVENT_BOOTHS',{booths:BOOTHS.map((b,i)=>i?b:{...b,name:'  Gian mới  '})})");
  await browserSettled();
  assert.equal(reads.length,1);
  assert.equal(browser.run("BOOTHS[0].name"),"Gian mới");
  assert.equal(browser.run("mutationBusy"),false);
  await browser.run("performEventAction('SAVE_EVENT_CONFIG',"+JSON.stringify({config:{events,activeEventId:events[1].id}})+")");
  assert.equal(browser.run("activeEvent().id"),events[1].id);
  assert.equal(browser.run("appState.queue.length"),0);
  reads.shift()();
  await browserSettled();
  assert.equal(reads.length,1);
  assert.equal(browser.run("activeEvent().id"),events[1].id);
  assert.equal(browser.run("appState.queue.length"),0);
  reads.shift()();
  await browserSettled();
  assert.match(browser.node("remoteSyncBadge").innerHTML,/Đã đồng bộ/);
});

test("hai giáo viên được phân công xác nhận cùng lượt đồng thời, chỉ một phiên nhận thay đổi", async () => {
  const {cloud,btc,teacher}=setup(), other="fixture.second@fpt.edu.vn", boothId="robotics";
  expectOk(cloud.post("SET_EVENT_ASSIGNMENT",{...btc,email:other,eventId,boothId,enabled:true}));
  const otherSession=cloud.seedTeacher(other);
  const [student]=studentLogins(cloud,btc,[actorA]).map(item=>redeem(cloud,item));
  const {record}=expectOk(cloud.post("JOIN_QUEUE",{...student,eventId,boothId}));
  const clients=[mockBrowser(cloud),mockBrowser(cloud)];
  await browserSettled();
  await Promise.all(clients.map((client,i)=>client.run("loginAdmin("+JSON.stringify(i?other:supervisor)+","+
    JSON.stringify(i?otherSession.authToken:teacher.authToken)+",3600)")));
  const pending=[];
  for(const client of clients){
    client.settings.reply=payload=>payload.action==="TEACHER_COMPLETE"?
      new Promise(resolve=>pending.push(()=>resolve(cloud.post(payload.action,payload)))):undefined;
  }
  const writes=clients.map(client=>client.run("performEventAction('TEACHER_COMPLETE',"+JSON.stringify({boothId,ids:[record.id]})+")"));
  await browserSettled();
  assert.equal(pending.length,2);
  pending.reverse().forEach(finish=>finish());
  assert.deepEqual(await Promise.all(writes),[false,true]);
  await Promise.all(clients.map(client=>client.run("refreshEventNow()")));
  assert.ok(clients.every(client=>client.run("appState.queue.length===1&&appState.queue[0].status==='completed'")));
});

test("chuyển năm giữ 395 hồ sơ và lịch sử, cùng mã ở hai năm được tách theo sự kiện", () => {
  const {cloud,btc,teacher,events}=setup(395);
  const before=view=>expectOk(cloud.post("LIST_ROSTER",{...btc,schoolYear:view})).roster;
  const old=before(year);
  const [oldLogin]=studentLogins(cloud,btc,[actorA]);
  const oldSession=redeem(cloud,oldLogin);
  const joined=expectOk(cloud.post("JOIN_QUEUE",{...oldSession,eventId,boothId:"robotics"})).record;
  expectOk(cloud.post("TEACHER_COMPLETE",{...teacher,eventId,boothId:"robotics",ids:[joined.id]}));
  const oldRows=cloud.sheets.get("WorkflowState").rows.filter(row=>row[0]==="queue").map(row=>JSON.stringify(row));
  const accounts=cloud.sheets.get("EventAccounts").rows.map(row=>JSON.stringify(row));
  const staff=cloud.sheets.get("EventStaff").rows.map(row=>JSON.stringify(row));
  expectOk(cloud.post("MANAGE_YEAR",{...btc,operation:"create",schoolYear:"2029-2030"}));
  let desk=expectOk(cloud.post("LIST_ROSTER",btc));
  assert.equal(desk.schoolYear,year);
  assert.equal(desk.years.find(y=>y.id==="2029-2030").status,"open");
  expectOk(cloud.post("SAVE_ROSTER",{...btc,schoolYear:"2027-2028",mode:"skip",confirmed:true,
    rows:[{code:actorA,name:"Hồ sơ năm mới",className:"10A3"}]}));
  assert.equal(before("2027-2028")[0].name,"Hồ sơ năm mới");
  assert.deepEqual(before(year),old.map((s,i)=>i?s:{...s,lastLoginAt:cloud.context.Date.now(),sessionActive:true}));
  expectDenied(cloud.post("MANAGE_YEAR",{...btc,operation:"close",schoolYear:year,confirmed:true}),"CONFLICT");
  expectOk(cloud.post("MANAGE_YEAR",{...btc,operation:"activate",schoolYear:"2027-2028"}));
  expectDenied(cloud.post("GET_EVENT_VIEW",oldSession),"AUTH_REQUIRED");
  const nextEvent={id:"new-school-event",name:"Sự kiện năm mới",schoolYear:"2027-2028",published:true};
  const nextEvents=[...events,nextEvent];
  expectOk(cloud.post("SAVE_EVENT_CONFIG",{...btc,config:{activeEventId:eventId,events:nextEvents}}));
  expectOk(cloud.post("SAVE_EVENT_CONFIG",{...btc,config:{activeEventId:nextEvent.id,events:nextEvents}}));
  expectDenied(cloud.post("LOGIN_STUDENT",{eventId:nextEvent.id,...oldLogin,studentAccessVersion}),"STUDENT_LOGIN_INVALID");
  const fresh=redeem(cloud,studentLogins(cloud,btc,[actorA],nextEvent.id)[0],nextEvent.id);
  const next=expectOk(cloud.post("GET_EVENT_VIEW",fresh));
  assert.equal(next.profile.name,"Hồ sơ năm mới");
  assert.equal(next.records.some(row=>row.type==="queue"),false);
  expectDenied(cloud.post("TEACHER_COMPLETE",{...teacher,eventId:nextEvent.id,boothId:"robotics",ids:[joined.id]}),"FORBIDDEN");
  expectDenied(cloud.post("MANAGE_YEAR",{...btc,operation:"close",schoolYear:year}),"INVALID_INPUT");
  expectOk(cloud.post("MANAGE_YEAR",{...btc,operation:"close",schoolYear:year,confirmed:true}));
  assert.equal(before(year).length,395);
  assert.deepEqual(cloud.sheets.get("WorkflowState").rows.filter(row=>row[0]==="queue").map(row=>JSON.stringify(row)),oldRows);
  assert.deepEqual(cloud.sheets.get("EventStaff").rows.map(row=>JSON.stringify(row)),staff);
  assert.deepEqual(cloud.sheets.get("EventAccounts").rows.slice(0,accounts.length).map(row=>JSON.stringify(row)),accounts);
});

test("xem trước import ghi rõ năm, thêm/cập nhật và hồ sơ vắng được giữ lại", async () => {
  const {cloud,btc}=setup(), browser=mockBrowser(cloud);
  await browserSettled();
  await browser.run("loginAdmin("+JSON.stringify(admin)+","+JSON.stringify(btc.authToken)+",3600)");
  await browser.run("loadRoster()");
  const content="Mã học sinh,Họ và tên,Lớp\n"+actorA+",Tên cập nhật,11A2\nFA0099,Học sinh mới,10A3";
  const encoded=JSON.stringify([...Buffer.from(content)]);
  await browser.run("previewRosterFile({name:'fixture.csv',size:100,arrayBuffer:async()=>new Uint8Array("+encoded+").buffer})");
  assert.match(browser.node("rosterImportImpact").textContent,/Năm đích 2026-2027 · Thêm 1/);
  assert.match(browser.node("rosterImportImpact").textContent,/2 học sinh vắng khỏi file được giữ lại/);
  browser.node("rosterImportUpdate").checked=true;
  browser.run("renderRosterImportImpact()");
  assert.match(browser.node("rosterImportImpact").textContent,/Cập nhật 1/);
  const desk=expectOk(cloud.post("LIST_ROSTER",btc));
  expectOk(cloud.post("SAVE_ROSTER",{...btc,schoolYear:year,expectedRevision:desk.revision,mode:"update",confirmed:true,
    rows:[{code:actorA,name:"Tên cập nhật",className:"11A2"},{code:"FA0099",name:"Học sinh mới",className:"10A3"}]}));
  assert.equal(expectOk(cloud.post("LIST_ROSTER",btc)).roster.length,4);
});

test("yêu cầu phân công cùng sự kiện được gộp khi mở cấu hình nhanh", async () => {
  const {cloud,btc}=setup(), browser=mockBrowser(cloud);
  await browserSettled();
  await browser.run("loginAdmin("+JSON.stringify(admin)+","+JSON.stringify(btc.authToken)+",3600)");
  let release;
  browser.settings.reply=p=>{
    if(p.action==="LIST_EVENT_ASSIGNMENTS"){
      return new Promise(resolve=>{release=()=>resolve(cloud.post(p.action,p));});
    }
  };
  const start=browser.requests.length;
  const first=browser.run("loadStaffAssignments("+JSON.stringify(eventId)+")");
  const second=browser.run("loadStaffAssignments("+JSON.stringify(eventId)+")");
  assert.equal(first,second);
  await browserSettled();
  assert.deepEqual(browser.requests.slice(start),["LIST_EVENT_ASSIGNMENTS"]);
  release();await first;
});

test("Openday công bố đúng API và trạng thái thật; chẩn đoán chỉ đọc và không lộ bí mật", () => {
  const {cloud,btc,events}=setup(395);
  const configured=events.map(event=>event.id===eventId?{...event,name:"Ngày hội Openday"}:event);
  expectOk(cloud.post("SAVE_EVENT_CONFIG",{...btc,config:{activeEventId:eventId,events:configured}}));
  let view=expectOk(cloud.post("GET_EVENT_VIEW"));
  assert.equal(view.studentAccessVersion,studentAccessVersion);
  assert.equal(view.studentLoginEnabled,false);
  assert.equal(view.studentLoginState,"ACCESS_NOT_CONFIGURED");
  const code="Fixture@Open2026";
  expectOk(cloud.post("CONFIGURE_STUDENT_ACCESS",{...btc,eventId,operation:"set",accessCode:code}));
  assert.equal(cloud.post("GET_EVENT_VIEW").studentLoginState,"ACCESS_DISABLED");
  expectOk(cloud.post("CONFIGURE_STUDENT_ACCESS",{...btc,eventId,operation:"enable"}));
  view=expectOk(cloud.post("GET_EVENT_VIEW"));
  assert.equal(view.studentLoginEnabled,true);
  assert.equal(view.studentLoginState,"READY");
  const writes=cloud.metrics.writes;
  const report=cloud.context.diagnoseStudentLogin();
  assert.equal(cloud.metrics.writes,writes);
  assert.equal(report.apiReady,true);
  assert.equal(report.hasLoginStudent,true);
  assert.equal(report.studentLoginEnabled,true);
  assert.equal(report.activeEvent.name,"Ngày hội Openday");
  assert.equal(report.activeEvent.schoolYear,year);
  assert.equal(report.activeSchoolYear,year);
  assert.equal(report.opendayFound,true);
  assert.equal(report.events[0].rosterPresent,true);
  assert.equal(report.events[0].accessConfigValid,true);
  const serialized=JSON.stringify([view,report,cloud.logs]);
  for(const value of [code,actorA,"Học sinh giả 1",cloud.context.PropertiesService.getScriptProperties().getProperty("FS_EVENT_STUDENT_ACCESS_KEY")]){
    assert.equal(serialized.includes(value),false);
  }
  expectDenied(cloud.post("diagnoseStudentLogin"),"METHOD_NOT_ALLOWED");
  const props=cloud.context.PropertiesService.getScriptProperties();
  const secret=props.getProperty("FS_EVENT_STUDENT_ACCESS_KEY");
  cloud.setProperty("FS_EVENT_STUDENT_ACCESS_KEY",null);
  assert.equal(cloud.post("GET_EVENT_VIEW").studentLoginEnabled,false);
  assert.equal(cloud.post("GET_EVENT_VIEW").studentLoginState,"ACCESS_SECRET_MISSING");
  expectDenied(cloud.post("LOGIN_STUDENT",{eventId,code:actorA,accessCode:code,studentAccessVersion}),"STUDENT_ACCESS_UNAVAILABLE");
  cloud.setProperty("FS_EVENT_STUDENT_ACCESS_KEY",secret);
  const key="student-event-access:"+eventId, access=JSON.parse(props.getProperty(key));
  cloud.setProperty(key,JSON.stringify({...access,digest:"invalid"}));
  assert.equal(cloud.post("GET_EVENT_VIEW").studentLoginState,"ACCESS_CONFIG_INVALID");
  cloud.setProperty(key,"not-json");
  assert.equal(cloud.post("GET_EVENT_VIEW").studentLoginEnabled,false);
  assert.equal(cloud.context.diagnoseStudentLogin().events[0].state,"ACCESS_CONFIG_INVALID");
});

test("Openday không tự mở khi năm học chưa kích hoạt, thiếu liên kết hoặc đã lưu trữ", () => {
  const {cloud,btc,events}=setup();
  studentLogins(cloud,btc,[actorA]);
  // Historical malformed rows cannot be produced by today's SAVE_EVENT_CONFIG,
  // which preserves the previous year. Seed that legacy fixture explicitly.
  const configure=patch=>{
    const row=cloud.sheets.get("WorkflowState").rows.find(row=>row[0]==="config"&&row[1]==="event-config");
    row[3]=JSON.stringify({activeEventId:eventId,
      events:events.map(event=>event.id===eventId?{...event,name:"Ngày hội Openday",...patch}:event)});
    cloud.cache.remove("event-pass-read-v1");
  };
  expectOk(cloud.post("MANAGE_YEAR",{...btc,operation:"activate",schoolYear:"2027-2028"}));
  assert.equal(cloud.post("GET_EVENT_VIEW").studentLoginState,"YEAR_NOT_ACTIVE");
  expectOk(cloud.post("MANAGE_YEAR",{...btc,operation:"activate",schoolYear:year}));
  configure({schoolYear:""});
  assert.equal(cloud.post("GET_EVENT_VIEW").studentLoginState,"EVENT_YEAR_MISSING");
  configure({schoolYear:"2026-2028"});
  assert.equal(cloud.post("GET_EVENT_VIEW").studentLoginState,"EVENT_YEAR_INVALID");
  configure({archived:true});
  assert.equal(cloud.post("GET_EVENT_VIEW").studentLoginState,"EVENT_ARCHIVED");
});

test("metadata không nhận hỗ trợ LOGIN_STUDENT nếu thiếu handler hoặc router học sinh", () => {
  for(const missing of ["loginStudentWithEventAccess_","studentAuthRoutes_"]){
    const {cloud,btc}=setup();studentLogins(cloud,btc,[actorA]);
    vm.runInContext(missing+"=undefined",cloud.context);
    expectDenied(cloud.post("GET_EVENT_API_VERSION"),"API_VERSION_MISMATCH");
    const view=expectOk(cloud.post("GET_EVENT_VIEW"));
    assert.equal(view.studentLoginEnabled,false);
    assert.equal(view.studentLoginState,"API_COMPONENTS_MISSING");
  }
});

test("GET_EVENT_VIEW unchanged giữ metadata, kiểm tra phiên và không cho đổi mã để đọc bạn khác", () => {
  const {cloud,btc}=setup();
  const entries=studentLogins(cloud,btc,[actorA,actorB]);
  const a=redeem(cloud,entries[0]);redeem(cloud,entries[1]);
  const view=expectOk(cloud.post("GET_EVENT_VIEW",{...a,knownRevision:""}));
  const compact=expectOk(cloud.post("GET_EVENT_VIEW",{...a,knownRevision:view.viewRevision}));
  assert.equal(compact.unchanged,true);
  assert.equal(compact.studentAccessVersion,studentAccessVersion);
  assert.equal(compact.studentLoginEnabled,true);
  expectDenied(cloud.post("GET_EVENT_VIEW",{studentSession:{...a.studentSession,code:actorB},knownRevision:view.viewRevision}),"AUTH_REQUIRED");
  assert.equal(view.records.some(record=>record.type==="student"&&record.id===actorB),false);
  expectOk(cloud.post("LOGOUT_STUDENT",a));
  expectDenied(cloud.post("GET_EVENT_VIEW",{...a,knownRevision:view.viewRevision}),"AUTH_REQUIRED");
});

test("frontend loại cache hợp đồng cũ, phân biệt metadata lỗi và tự phục hồi sau backend cập nhật", async () => {
  const {cloud,btc}=setup();studentLogins(cloud,btc,[actorA]);
  const browser=mockBrowser(cloud,undefined,undefined,{reply:payload=>{
    if(payload.action!=="GET_EVENT_VIEW")return;
    const view=cloud.post(payload.action,payload);delete view.studentAccessVersion;return view;
  }});
  await browserSettled();
  assert.equal(browser.node("studentLoginButton").disabled,true);
  assert.match(browser.node("studentLoginEvent").textContent,/GET_EVENT_VIEW.*studentAccessVersion/);
  assert.equal(browser.run("publicEventCacheSnapshot"),null);
  delete browser.settings.reply;
  const start=browser.requests.length;
  await browser.run("loadPublicEvent()");
  assert.deepEqual(browser.requests.slice(start),["GET_EVENT_VIEW"]);
  assert.equal(browser.node("studentLoginButton").disabled,false);
  browser.settings.reply=payload=>payload.action==="GET_EVENT_VIEW"?{...cloud.post(payload.action,payload),unchanged:true,records:undefined}:undefined;
  await browser.run("loadPublicEvent()");
  assert.equal(browser.node("studentLoginButton").disabled,true);
  assert.equal(browser.run("publicEventCacheSnapshot"),null);
});

test("frontend phân biệt 401/403, HTML, mất mạng và sai kiểu enabled; không bật nút giả", async t => {
  const {cloud,btc}=setup();studentLogins(cloud,btc,[actorA]);
  for(const status of [401,403])await t.test("HTTP "+status,async()=>{
    const browser=mockBrowser(cloud,undefined,undefined,{httpResponses:{GET_EVENT_VIEW:{ok:false,status}}});
    await browserSettled();
    assert.equal(browser.node("studentLoginButton").disabled,true);
    assert.match(browser.node("studentLoginEvent").textContent,new RegExp("HTTP "+status+".*quyền truy cập"));
  });
  const html=mockBrowser(cloud,undefined,undefined,{httpResponses:{GET_EVENT_VIEW:{ok:true,json:async()=>{throw new SyntaxError("fixture HTML")}}}});
  await browserSettled();assert.match(html.node("studentLoginEvent").textContent,/JSON hợp lệ/);
  const offline=mockBrowser(cloud,undefined,undefined,{offline:true});
  await browserSettled();assert.match(offline.node("studentLoginEvent").textContent,/Chưa kết nối được Apps Script/);
  const invalid=mockBrowser(cloud,undefined,undefined,{reply:payload=>payload.action==="GET_EVENT_VIEW"?
    {...cloud.post(payload.action,payload),studentLoginEnabled:"true"}:undefined});
  await browserSettled();assert.equal(invalid.node("studentLoginButton").disabled,true);
  assert.match(invalid.node("studentLoginEvent").textContent,/GET_EVENT_VIEW.*studentLoginEnabled/);
  const noEvent=mockBrowser(cloud,undefined,undefined,{reply:payload=>payload.action==="GET_EVENT_VIEW"?
    {...cloud.post(payload.action,payload),records:[]}:undefined});
  await browserSettled();assert.equal(noEvent.node("studentLoginButton").disabled,true);
  assert.equal(noEvent.run("publicEventCacheSnapshot"),null);
});

test("phản hồi public cũ đến muộn không ghi đè phiên bản mới hoặc khóa lại nút", async () => {
  const {cloud,btc}=setup();studentLogins(cloud,btc,[actorA]);
  const browser=mockBrowser(cloud);await browserSettled();
  let release;
  browser.settings.httpResponses={GET_EVENT_VIEW:{ok:true,json:()=>new Promise(resolve=>{release=resolve})}};
  const old=browser.run("loadPublicEvent()");await browserSettled();
  delete browser.settings.httpResponses;
  await browser.run("loadPublicEvent()");
  const current=browser.node("studentLoginEvent").textContent;
  release({...cloud.post("GET_EVENT_VIEW"),studentAccessVersion:"legacy"});await old;
  assert.equal(browser.node("studentLoginButton").disabled,false);
  assert.equal(browser.node("studentLoginEvent").textContent,current);
});

test("BTC sửa cấu hình mã lỗi qua Lưu mã, không mất danh sách hoặc dấu đã xác nhận", () => {
  const {cloud,btc}=setup();
  const entry=studentLogins(cloud,btc,[actorA])[0], session=redeem(cloud,entry);
  const queued=expectOk(cloud.post("JOIN_QUEUE",{...session,eventId,boothId:"robotics"})).record;
  expectOk(cloud.post("TEACHER_COMPLETE",{...btc,eventId,boothId:"robotics",ids:[queued.id]}));
  const roster=JSON.stringify(cloud.sheets.get("StudentRoster").rows);
  cloud.setProperty("FS_EVENT_STUDENT_ACCESS_KEY","invalid-short-key");
  cloud.setProperty("student-event-access:"+eventId,"invalid-json");
  expectDenied(cloud.post("CONFIGURE_STUDENT_ACCESS",{...btc,eventId,operation:"enable"}),"STUDENT_ACCESS_UNAVAILABLE");
  const newer={...entry,accessCode:"Fixture@Repaired"};
  expectOk(cloud.post("CONFIGURE_STUDENT_ACCESS",{...btc,eventId,operation:"set",accessCode:newer.accessCode}));
  assert.equal(cloud.post("GET_EVENT_VIEW").studentLoginEnabled,false);
  expectOk(cloud.post("CONFIGURE_STUDENT_ACCESS",{...btc,eventId,operation:"enable"}));
  assert.equal(cloud.post("GET_EVENT_VIEW").studentLoginEnabled,true);
  const view=expectOk(cloud.post("GET_EVENT_VIEW",redeem(cloud,newer)));
  assert.equal(view.records.find(row=>row.id===queued.id).data.status,"completed");
  assert.equal(JSON.stringify(cloud.sheets.get("StudentRoster").rows),roster);
  assert.equal(JSON.stringify(cloud.context.PropertiesService.getScriptProperties().getProperties()).includes(newer.accessCode),false);
});

test("Drive ảnh: thiếu thư mục, thiếu quyền ghi/đọc không được ghi nhận thành công", () => {
  for(const failure of ["missing","folder","write","readback"]){
    const {cloud,btc}=setup();
    const body={...btc,eventId,kind:"theme",operation:"upload",expectedRevision:"",upload:tinyPng,publishApproved:true};
    const original=cloud.context.DriveApp.getFolderById;
    if(failure!=="missing")cloud.setProperty("FS_EVENT_IMAGE_FOLDER_ID","fixture-images");
    if(failure==="folder")cloud.context.DriveApp.getFolderById=()=>{throw Error("fixture denied")};
    if(failure==="write")cloud.context.DriveApp.getFolderById=id=>({getId:()=>id,createFile(){throw Error("fixture denied")}});
    if(failure==="readback")cloud.context.DriveApp.getFolderById=id=>({getId:()=>id,createFile(blob){const file=original(id).createFile(blob);return {getId:file.getId,getBlob(){throw Error("fixture denied")}}}});
    const writes=cloud.metrics.writes;
    const result=cloud.post("SAVE_EVENT_IMAGE",body);
    expectDenied(result,"IMAGE_UNAVAILABLE");
    assert.equal(cloud.metrics.writes,writes);
    assert.equal(cloud.sheets.get("WorkflowState").rows.some(row=>row[1]==="event-images:"+eventId),false);
    if(failure==="missing")assert.match(result.message,/FS_EVENT_IMAGE_FOLDER_ID/);
    if(failure==="write")assert.match(result.message,/quyền ghi/);
    if(failure==="readback")assert.match(result.message,/chưa đọc lại/);
  }
});

test("artwork cần BTC phê duyệt; ảnh cũ được xem riêng và duyệt lại không đổi nội dung", () => {
  const {cloud,btc}=setup();
  cloud.setProperty("FS_EVENT_IMAGE_FOLDER_ID","fixture-images");cloud.setProperty("FS_EVENT_PUBLIC_IMAGES","true");
  const upload={...btc,eventId,kind:"theme",operation:"upload",expectedRevision:"",upload:tinyPng};
  expectDenied(cloud.post("SAVE_EVENT_IMAGE",upload),"IMAGE_APPROVAL_REQUIRED");assert.equal(cloud.imageFiles.size,0);
  const image=expectOk(cloud.post("SAVE_EVENT_IMAGE",{...upload,publishApproved:true})).images;
  const row=cloud.sheets.get("WorkflowState").rows.find(row=>row[1]==="event-images:"+eventId), stored=JSON.parse(row[3]);
  delete stored.theme.current.publishApproved;row[3]=JSON.stringify(stored);cloud.cache.remove("event-pass-read-v1");
  expectDenied(JSON.parse(cloud.get({action:"GET_EVENT_IMAGE",eventId,kind:"theme",version:image.theme.version}).value),"IMAGE_UNAVAILABLE");
  expectOk(cloud.post("PREVIEW_EVENT_IMAGE",{...btc,eventId,kind:"theme",version:image.theme.version}));
  const count=cloud.imageFiles.size,writes=cloud.metrics.writes;
  const diagnosis=cloud.context.diagnoseEventImageStorage();
  assert.equal(diagnosis.folderReadable,true);assert.equal(diagnosis.images[0].publishApproved,false);
  assert.equal(cloud.metrics.writes,writes);assert.equal(cloud.imageFiles.size,count);
  const approved=expectOk(cloud.post("SAVE_EVENT_IMAGE",{...btc,eventId,kind:"theme",operation:"approve",expectedRevision:image.revision,publishApproved:true}));
  assert.equal(approved.images.theme.version,image.theme.version);assert.equal(cloud.imageFiles.size,count);
  expectOk(JSON.parse(cloud.get({action:"GET_EVENT_IMAGE",eventId,kind:"theme",version:image.theme.version}).value));
});

for(const count of [1,6,10,15,40])test(`cấu hình ${count} gian riêng sự kiện; icon và phân công nhiều gian tách eventId`,()=>{
  const {cloud,btc,teacher,events}=setup(), target=events[1].id;
  const original=expectOk(cloud.post("GET_EVENT_VIEW",btc)).records.find(row=>row.id==="booth-config").data.boothList;
  const setupBefore=expectOk(cloud.post("GET_EVENT_SETUP",{...btc,eventId:target}));
  const booths=Array.from({length:count},(_,i)=>({id:"scope-"+i,name:"Gian riêng "+i,pin:String(7100+i),icon:i%2?"microscope":"brain"}));
  const save=expectOk(cloud.post("SAVE_EVENT_BOOTHS",{...btc,eventId,targetEventId:target,expectedBoothRevision:setupBefore.boothRevision,booths}));
  assert.equal(save.change.targetEventId,target);
  assert.deepEqual(cloud.post("GET_EVENT_VIEW",btc).records.find(row=>row.id==="booth-config").data.boothList,original);
  const next=expectOk(cloud.post("GET_EVENT_SETUP",{...btc,eventId:target}));
  assert.equal(next.booths.length,count);assert.equal(next.booths[0].icon,"brain");
  expectDenied(cloud.post("SAVE_EVENT_BOOTHS",{...btc,eventId,targetEventId:target,expectedBoothRevision:setupBefore.boothRevision,booths}),"CONFLICT");
  expectOk(cloud.post("SET_EVENT_ASSIGNMENT",{...btc,eventId:target,email:supervisor.toUpperCase(),name:"Giáo viên giả",boothIds:booths.map(row=>row.id),enabled:true}));
  const viewA=expectOk(cloud.post("GET_EVENT_VIEW",teacher));
  assert.deepEqual(viewA.records.find(row=>row.id==="booth-config").data.boothList.map(row=>row.id),["robotics"]);
  expectOk(cloud.post("SAVE_EVENT_CONFIG",{...btc,config:{activeEventId:target,events}}));
  const viewB=expectOk(cloud.post("GET_EVENT_VIEW",teacher));
  assert.equal(viewB.records.find(row=>row.id==="booth-config").data.boothList.length,count);
  assert.equal(viewB.access.role,"TEACHER");assert.deepEqual(viewB.access.permissions,[]);
  expectDenied(cloud.post("GET_EVENT_SETUP",{...teacher,eventId:target,role:"ADMIN"}),"FORBIDDEN");
});

test("phân công nhiều gian nguyên tử, hỗ trợ nhiều giáo viên, sửa và thu hồi quyền tức thời",()=>{
  const {cloud,btc,teacher}=setup();
  const [student]=studentLogins(cloud,btc,[actorA]).map(row=>redeem(cloud,row));
  const queue=expectOk(cloud.post("JOIN_QUEUE",{...student,eventId,boothId:"chemistry"})).record;
  const setupBefore=cloud.post("GET_EVENT_SETUP",{...btc,eventId});
  const granted=expectOk(cloud.post("SET_EVENT_ASSIGNMENT",{...btc,eventId,email:supervisor,boothIds:["robotics","chemistry"],enabled:true,replace:true,expectedAssignmentRevision:setupBefore.assignmentRevision}));
  const before=expectOk(cloud.post("GET_EVENT_VIEW",{...teacher,knownRevision:""}));
  const writes=cloud.metrics.writes;
  expectDenied(cloud.post("SET_EVENT_ASSIGNMENT",{...btc,eventId,email:supervisor,boothIds:["robotics","missing"],enabled:true}),"INVALID_INPUT");
  expectDenied(cloud.post("SET_EVENT_ASSIGNMENT",{...btc,eventId,email:"bad@fpt.edu.vn.evil",boothIds:["robotics"],enabled:true}),"INVALID_EMAIL");
  assert.equal(cloud.metrics.writes,writes);
  expectOk(cloud.post("SET_EVENT_ASSIGNMENT",{...btc,eventId,email:"other@fe.edu.vn",boothIds:["robotics"],enabled:true}));
  expectDenied(cloud.post("SET_EVENT_ASSIGNMENT",{...btc,eventId,email:supervisor,boothIds:["robotics"],enabled:true,replace:true,expectedAssignmentRevision:granted.assignmentRevision}),"CONFLICT");
  const latest=cloud.post("GET_EVENT_SETUP",{...btc,eventId});
  expectOk(cloud.post("SET_EVENT_ASSIGNMENT",{...btc,eventId,email:supervisor,boothIds:["robotics"],enabled:true,replace:true,expectedAssignmentRevision:latest.assignmentRevision}));
  const refreshed=expectOk(cloud.post("GET_EVENT_VIEW",{...teacher,knownRevision:before.viewRevision}));
  assert.notEqual(refreshed.unchanged,true);
  assert.equal(refreshed.records.some(row=>row.id===queue.id),false);
  expectDenied(cloud.post("TEACHER_COMPLETE",{...teacher,eventId,boothId:"chemistry",ids:[queue.id],role:"ADMIN"}),"FORBIDDEN");
  const stored=cloud.sheets.get("EventStaff").rows.map(row=>{try{return JSON.parse(row[1])}catch{return null}}).filter(Boolean);
  assert.equal(stored.find(row=>row.email===supervisor&&row.boothId==="chemistry").enabled,false);
  assert.equal(stored.find(row=>row.email==="other@fe.edu.vn"&&row.boothId==="robotics").enabled,true);
});

test("GET_EVENT_SETUP không cấp PIN cho quyền chỉ phân công; giáo viên không tự thành BTC",()=>{
  const {cloud,btc,teacher}=setup();
  const granted=JSON.parse(cloud.context.PropertiesService.getScriptProperties().getProperty("FS_EVENT_ADMINS"));
  const email="assign-only@fpt.edu.vn";granted[email]=["assignments"];cloud.setProperty("FS_EVENT_ADMINS",JSON.stringify(granted));
  const actor=cloud.seedTeacher(email),setupView=expectOk(cloud.post("GET_EVENT_SETUP",{...actor,eventId}));
  assert.equal(setupView.booths.some(booth=>Object.hasOwn(booth,"pin")),false);
  expectDenied(cloud.post("GET_EVENT_SETUP",{...teacher,eventId}),"FORBIDDEN");
  expectDenied(cloud.post("SET_EVENT_ASSIGNMENT",{...teacher,eventId,email:supervisor,boothIds:["robotics"],enabled:true,role:"ADMIN"}),"FORBIDDEN");
  expectDenied(cloud.post("SAVE_EVENT_IMAGE",{...teacher,eventId,kind:"theme",operation:"default",expectedRevision:""}),"FORBIDDEN");
  expectDenied(cloud.post("LIST_ROSTER",teacher),"FORBIDDEN");
  assert.equal(cloud.post("GET_EVENT_VIEW",teacher).access.role,"TEACHER");
});

test("đóng năm hoạt động có xác nhận riêng, tạo năm mới không tự kích hoạt và giữ toàn bộ lịch sử",()=>{
  const {cloud,btc,events}=setup(395);
  const login=studentLogins(cloud,btc,[actorA])[0],student=redeem(cloud,login);
  const joined=expectOk(cloud.post("JOIN_QUEUE",{...student,eventId,boothId:"robotics"})).record;
  expectOk(cloud.post("TEACHER_COMPLETE",{...btc,eventId,boothId:"robotics",ids:[joined.id]}));
  const roster=JSON.stringify(cloud.sheets.get("StudentRoster").rows),staff=JSON.stringify(cloud.sheets.get("EventStaff").rows);
  const workflow=JSON.stringify(cloud.sheets.get("WorkflowState").rows),accounts=JSON.stringify(cloud.sheets.get("EventAccounts").rows);
  expectDenied(cloud.post("MANAGE_YEAR",{...btc,operation:"close",schoolYear:year,confirmed:true}),"CONFLICT");
  expectOk(cloud.post("MANAGE_YEAR",{...btc,operation:"close",schoolYear:year,confirmed:true,closeActiveConfirmed:true}));
  expectDenied(cloud.post("GET_EVENT_VIEW",student),"AUTH_REQUIRED");
  assert.equal(cloud.post("GET_EVENT_VIEW").studentLoginEnabled,false);
  expectOk(cloud.post("MANAGE_YEAR",{...btc,operation:"create",schoolYear:"2029-2030"}));
  assert.equal(cloud.context.activeSchoolYear_(),"");
  assert.equal(JSON.stringify(cloud.sheets.get("StudentRoster").rows),roster);
  assert.equal(JSON.stringify(cloud.sheets.get("WorkflowState").rows),workflow);
  assert.equal(JSON.stringify(cloud.sheets.get("EventStaff").rows),staff);
  assert.equal(JSON.stringify(cloud.sheets.get("EventAccounts").rows),accounts);
  assert.equal(cloud.post("GET_EVENT_ARCHIVE",{...btc,eventId}).stats.booths[0].completed,1);
  assert.equal(cloud.post("LIST_ROSTER",{...btc,schoolYear:year}).roster.length,395);
});

test("hai mục cấu hình không tải roster khi mở sự kiện và giữ bản nháp khi chuyển mục",async()=>{
  const {cloud,btc}=setup(395);const browser=mockBrowser(cloud);await browserSettled();
  await browser.run("loginAdmin("+JSON.stringify(admin)+","+JSON.stringify(btc.authToken)+",3600)");
  browser.run("showAdminTab('config')");await browserSettled();
  assert.equal(browser.requests.includes("GET_EVENT_SETUP"),true);
  assert.equal(browser.requests.includes("LIST_ROSTER"),false);
  browser.node("managedEventName").value="Bản nháp sự kiện";
  browser.run("eventAdminState.eventDrafts.set(managedEventId(),{name:'Bản nháp sự kiện',date:'Ngày thử',description:'Mô tả thử'})");
  browser.run("showConfigSection('students')");await browserSettled();
  browser.node("rosterSearch").value="Tìm kiếm được giữ";
  browser.run("showConfigSection('events');showConfigSection('students')");await browserSettled();
  assert.equal(browser.node("managedEventName").value,"Bản nháp sự kiện");
  assert.equal(browser.node("rosterSearch").value,"Tìm kiếm được giữ");
  assert.equal(browser.requests.filter(action=>action==="LIST_ROSTER").length,1);
  assert.equal(browser.requests.filter(action=>action==="GET_EVENT_SETUP").length,1);
});

const configView=(cloud,btc)=>expectOk(cloud.post("GET_EVENT_VIEW",btc)).records.find(row=>row.id==="event-config").data;
function lifecycleRequest(cloud,btc,id,operation="delete"){
  const config=configView(cloud,btc),item=[...config.events,...(config.deletedEvents||[])].find(row=>row.id===id);
  return {...btc,eventId:id,operation,confirmed:true,expectedRevision:item.eventRevision};
}

test("phiếu không phụ thuộc theme hoặc checkbox; lưu và tải lại đúng eventId, giữ file theme cũ",()=>{
  const {cloud,btc,teacher,events}=setup();cloud.setProperty("FS_EVENT_IMAGE_FOLDER_ID","fixture-images");cloud.setProperty("FS_EVENT_PUBLIC_IMAGES","true");
  const old=expectOk(cloud.post("SAVE_EVENT_IMAGE",{...btc,eventId,kind:"theme",operation:"upload",expectedRevision:"",upload:tinyPng,publishApproved:true}));
  const stored=()=>JSON.parse(cloud.sheets.get("WorkflowState").rows.find(row=>row[1]==="event-images:"+eventId)[3]);
  const oldTheme=JSON.stringify(stored().theme),filesBefore=cloud.imageFiles.size;
  const input={...btc,eventId,kind:"passport",operation:"upload",expectedRevision:old.images.revision,upload:tinyPng,layout:{mode:"auto"}};
  expectDenied(cloud.post("SAVE_EVENT_IMAGE",{...input,...teacher}),"FORBIDDEN");
  expectDenied(cloud.post("SAVE_EVENT_IMAGE",{...input,upload:{mime:"image/png",content:Buffer.from("invalid").toString("base64")}}),"IMAGE_FORMAT");
  const saved=expectOk(cloud.post("SAVE_EVENT_IMAGE",input));
  assert.equal(saved.images.passport.publishApproved,true);assert.equal(JSON.stringify(stored().theme),oldTheme);
  assert.equal(cloud.imageFiles.size,filesBefore+1);
  expectOk(JSON.parse(cloud.get({action:"GET_EVENT_IMAGE",eventId,kind:"passport",version:saved.images.passport.version}).value));
  expectDenied(JSON.parse(cloud.get({action:"GET_EVENT_IMAGE",eventId:events[1].id,kind:"passport",version:saved.images.passport.version}).value),"IMAGE_UNAVAILABLE");
  const next=expectOk(cloud.post("SAVE_EVENT_IMAGE",{...btc,eventId:events[1].id,kind:"passport",operation:"upload",expectedRevision:"",upload:tinyPng}));
  assert.ok(next.images.passport.version);assert.equal(next.images.theme,undefined);
});

test("khôi phục ảnh phiếu cũ kiểm tra file thật và phát hành không cần checkbox; thiếu file không báo thành công",()=>{
  const {cloud,btc}=setup();cloud.setProperty("FS_EVENT_IMAGE_FOLDER_ID","fixture-images");cloud.setProperty("FS_EVENT_PUBLIC_IMAGES","true");
  const upload={...btc,eventId,kind:"passport",operation:"upload",expectedRevision:"",upload:tinyPng};
  const first=expectOk(cloud.post("SAVE_EVENT_IMAGE",upload));
  const second=expectOk(cloud.post("SAVE_EVENT_IMAGE",{...upload,expectedRevision:first.images.revision}));
  const row=cloud.sheets.get("WorkflowState").rows.find(row=>row[1]==="event-images:"+eventId),state=JSON.parse(row[3]);
  delete state.passport.previous.current.publishApproved;row[3]=JSON.stringify(state);cloud.cache.remove("event-pass-read-v1");
  const restored=expectOk(cloud.post("SAVE_EVENT_IMAGE",{...btc,eventId,kind:"passport",operation:"restore",expectedRevision:second.images.revision}));
  assert.equal(restored.images.passport.version,first.images.passport.version);
  expectOk(JSON.parse(cloud.get({action:"GET_EVENT_IMAGE",eventId,kind:"passport",version:first.images.passport.version}).value));
  cloud.imageFiles.clear();const writes=cloud.metrics.writes;
  expectDenied(cloud.post("SAVE_EVENT_IMAGE",{...btc,eventId,kind:"passport",operation:"restore",expectedRevision:restored.images.revision}),"IMAGE_UNAVAILABLE");
  assert.equal(cloud.metrics.writes,writes);
});

test("xóa mềm đúng ID khi trùng tên, khôi phục không tự mở; giữ Sheets, Drive và tombstone qua SAVE_CONFIG",()=>{
  const {cloud,btc,events}=setup(395);events[2].name=events[1].name;
  expectOk(cloud.post("SAVE_EVENT_CONFIG",{...btc,config:{activeEventId:eventId,events}}));
  const target=events[1].id;
  cloud.setProperty("FS_EVENT_IMAGE_FOLDER_ID","fixture-images");
  expectOk(cloud.post("SAVE_EVENT_IMAGE",{...btc,eventId:target,kind:"passport",operation:"upload",expectedRevision:"",upload:tinyPng}));
  const preserved=["SchoolYears","StudentRoster","EventAccounts","EventStaff"].map(name=>JSON.stringify(cloud.sheets.get(name)?.rows));
  const files=[...cloud.imageFiles.keys()],before=configView(cloud,btc),request=lifecycleRequest(cloud,btc,target);
  const removed=expectOk(cloud.post("MANAGE_EVENT",request));
  assert.equal(removed.config.events.some(row=>row.id===target),false);
  assert.equal(removed.config.events.some(row=>row.id===events[2].id),true);
  assert.equal(removed.config.deletedEvents.some(row=>row.id===target),true);
  assert.equal(configView(cloud,{}).deletedEvents,undefined);
  expectDenied(cloud.post("GET_EVENT_SETUP",{...btc,eventId:target}),"INVALID_INPUT");
  expectDenied(cloud.post("SAVE_EVENT_CONFIG",{...btc,config:before}),"EVENT_DELETED");
  expectOk(cloud.post("SAVE_EVENT_CONFIG",{...btc,config:{activeEventId:eventId,events:removed.config.events}}));
  assert.equal(configView(cloud,btc).deletedEvents.length,1);
  const restored=expectOk(cloud.post("MANAGE_EVENT",lifecycleRequest(cloud,btc,target,"restore")));
  assert.equal(restored.config.activeEventId,eventId);assert.equal(restored.config.deletedEvents.length,0);
  assert.equal(restored.config.events.find(row=>row.id===target).published,false);
  assert.deepEqual(preserved,["SchoolYears","StudentRoster","EventAccounts","EventStaff"].map(name=>JSON.stringify(cloud.sheets.get(name)?.rows)));
  assert.deepEqual([...cloud.imageFiles.keys()],files);
  const event=JSON.parse(cloud.sheets.get("WorkflowState").rows.find(row=>row[1]==="event-config")[3]).events.find(row=>row.id===target);
  assert.deepEqual(event.lifecycleAudit.map(row=>row.operation),["delete","restore"]);
});

for(const dependency of ["queue","draw","drawHistory","eventStudent","legacy-student","account","staff"]){
  test("không xóa sự kiện có dữ liệu cần giữ: "+dependency,()=>{
    const {cloud,btc,events}=setup(),target=events[1].id;
    if(dependency==="account")cloud.context.withTeacherAuthLock_(()=>cloud.context.ledgerWrite_("accounts",target+"::"+actorA,{eventId:target,code:actorA}));
    else if(dependency==="staff")expectOk(cloud.post("SET_EVENT_ASSIGNMENT",{...btc,eventId:target,email:supervisor,boothId:"robotics",enabled:false}));
    else {
      const data=dependency==="legacy-student"?{code:actorA,luckyNumbers:{[target]:"0001"}}:{eventId:target,studentCode:actorA,status:"completed"};
      cloud.seedRows("WorkflowState",[[dependency==="legacy-student"?"student":dependency,target+"::fixture",new Date().toISOString(),JSON.stringify(data)]]);
    }
    const request=lifecycleRequest(cloud,btc,target),writes=cloud.metrics.writes;
    expectDenied(cloud.post("MANAGE_EVENT",request),"EVENT_HAS_DEPENDENCIES");assert.equal(cloud.metrics.writes,writes);
  });
}

test("xóa sự kiện kiểm tra phiên, quyền, active và revision; hai yêu cầu cùng phiên bản chỉ một lần ghi",async()=>{
  const {cloud,btc,teacher,events}=setup(),target=events[1].id;
  expectDenied(cloud.post("MANAGE_EVENT",lifecycleRequest(cloud,btc,eventId)),"EVENT_ACTIVE");
  const request=lifecycleRequest(cloud,btc,target),student=redeem(cloud,studentLogins(cloud,btc,[actorA])[0]);
  expectDenied(cloud.post("MANAGE_EVENT",{...request,...teacher,role:"ADMIN"}),"FORBIDDEN");
  const {authToken,...unauthed}=request;expectDenied(cloud.post("MANAGE_EVENT",unauthed),"AUTH_REQUIRED");
  expectDenied(cloud.post("MANAGE_EVENT",{...unauthed,...student}),"AUTH_REQUIRED");
  const pair=await Promise.all([Promise.resolve().then(()=>cloud.post("MANAGE_EVENT",request)),Promise.resolve().then(()=>cloud.post("MANAGE_EVENT",request))]);
  assert.equal(pair.filter(row=>row.success).length,1);expectDenied(pair.find(row=>!row.success),"CONFLICT");
  assert.equal(configView(cloud,btc).deletedEvents.filter(row=>row.id===target).length,1);
  expectDenied(JSON.parse(cloud.get({action:"MANAGE_EVENT",eventId:target}).value),"METHOD_NOT_ALLOWED");
});

test("chỉ xóa một phân công đã thu hồi; quyền các gian/sự kiện khác và lịch sử hoàn thành giữ nguyên",()=>{
  const {cloud,btc,teacher,events}=setup(),student=redeem(cloud,studentLogins(cloud,btc,[actorA])[0]);
  expectOk(cloud.post("SET_EVENT_ASSIGNMENT",{...btc,eventId,email:supervisor,boothId:"chemistry",enabled:true}));
  expectOk(cloud.post("SET_EVENT_ASSIGNMENT",{...btc,eventId:events[1].id,email:supervisor,boothId:"robotics",enabled:true}));
  const joined=expectOk(cloud.post("JOIN_QUEUE",{...student,eventId,boothId:"robotics"})).record;
  expectOk(cloud.post("TEACHER_COMPLETE",{...teacher,eventId,boothId:"robotics",ids:[joined.id]}));
  const setupBefore=cloud.post("GET_EVENT_SETUP",{...btc,eventId});
  const request={...btc,eventId,email:supervisor,boothId:"robotics",confirmed:true,expectedAssignmentRevision:setupBefore.assignmentRevision};
  expectDenied(cloud.post("DELETE_EVENT_ASSIGNMENT",request),"ASSIGNMENT_ACTIVE");
  const revoked=expectOk(cloud.post("SET_EVENT_ASSIGNMENT",{...btc,eventId,email:supervisor,boothId:"robotics",enabled:false}));
  expectDenied(cloud.post("TEACHER_COMPLETE",{...teacher,eventId,boothId:"robotics",ids:[joined.id]}),"FORBIDDEN");
  expectDenied(cloud.post("DELETE_EVENT_ASSIGNMENT",request),"CONFLICT");
  const fresh={...request,expectedAssignmentRevision:revoked.assignmentRevision};
  expectDenied(cloud.post("DELETE_EVENT_ASSIGNMENT",{...fresh,...teacher,role:"ADMIN"}),"FORBIDDEN");
  const deleted=expectOk(cloud.post("DELETE_EVENT_ASSIGNMENT",fresh));
  assert.deepEqual(deleted.assignments.map(row=>row.boothId),["chemistry"]);
  assert.equal(cloud.post("GET_EVENT_VIEW",teacher).records.find(row=>row.id==="booth-config").data.boothList[0].id,"chemistry");
  assert.equal(cloud.post("LIST_EVENT_ASSIGNMENTS",{...btc,eventId:events[1].id}).assignments.length,1);
  assert.equal(cloud.post("GET_EVENT_VIEW",student).records.find(row=>row.id===joined.id).data.status,"completed");
  const ledger=cloud.sheets.get("EventStaff"),targetRow=ledger.rows.find(row=>row[0]===eventId+"::robotics::"+supervisor),stored=JSON.parse(targetRow[1]);
  assert.ok(stored.deletedAt);assert.equal(stored.enabled,false);assert.equal(stored.audit.at(-1).operation,"delete");
  const count=ledger.rows.length;
  expectOk(cloud.post("SET_EVENT_ASSIGNMENT",{...btc,eventId,email:supervisor,boothId:"robotics",enabled:true,expectedAssignmentRevision:deleted.assignmentRevision}));
  assert.equal(ledger.rows.length,count);assert.equal(cloud.post("GET_EVENT_SETUP",{...btc,eventId}).assignments.length,2);
  assert.equal(JSON.parse(targetRow[1]).audit.at(-2).operation,"delete");
});

test("frontend chặn bộ ảnh cũ; xóa chỉ dựa vào hợp đồng xóa riêng đã xác thực",async()=>{
  const {cloud,btc}=setup(),browser=mockBrowser(cloud);
  browser.settings.reply=payload=>payload.action==="GET_EVENT_SETUP"?
    {...cloud.post(payload.action,payload),adminSetupVersion:"event-admin-setup-v1",imageApiVersion:"event-images-v2"}:undefined;
  await browserSettled();await browser.run("loginAdmin("+JSON.stringify(admin)+","+JSON.stringify(btc.authToken)+",3600)");
  browser.run("showAdminTab('config')");await browserSettled();
  assert.equal(browser.run("!!managedEventSetup()"),false);
  assert.equal(browser.node("eventImagesForm").disabled,true);
  assert.match(browser.node("managedEventStatus").textContent,/backend|Apps Script/);
  assert.equal(browser.run("eventDeleteEligibility(EVENTS.find(e=>e.id==='fixture-event-b')).canDelete"),true);
  assert.equal(browser.requests.some(action=>["SAVE_EVENT_IMAGE","MANAGE_EVENT","DELETE_EVENT_ASSIGNMENT"].includes(action)),false);
});

test("deployment thiếu hàm mới không công bố hỗ trợ giả, không làm đổi hợp đồng đăng nhập",()=>{
  for(const missing of ["deleteEventAssignment_","checkedStoredEventImage_"]){
    const {cloud,btc}=setup();cloud.context[missing]=undefined;
    const version=expectOk(cloud.post("GET_EVENT_API_VERSION"));
    assert.equal(version.studentAccessVersion,studentAccessVersion);assert.equal(version.otpVersion,"teacher-otp-v3");
    assert.equal(missing==="deleteEventAssignment_"?version.eventAdminVersion:version.eventImageVersion,undefined);
    expectDenied(cloud.post("GET_EVENT_SETUP",{...btc,eventId}),"API_VERSION_MISMATCH");
  }
});

test("kiểm tra xóa riêng cho sự kiện lưu trữ, thiếu năm/ảnh vẫn xóa được nếu không có nghiệp vụ",()=>{
  const {cloud,btc,events}=setup(),target=events[1].id;
  expectOk(cloud.post("SAVE_EVENT_CONFIG",{...btc,config:{activeEventId:eventId,events:events.map(event=>event.id===target?{...event,archived:true}:event)}}));
  const writes=cloud.metrics.writes,files=cloud.imageFiles.size;
  const result=expectOk(cloud.post("GET_EVENT_DELETE_STATE",btc));
  assert.equal(result.eventDeleteVersion,"event-delete-v1");assert.equal(result.events.find(event=>event.eventId===target).canDelete,true);
  const legacy=result.events.find(event=>event.eventId==="spring-2027");
  assert.equal(legacy.archived,true);assert.equal(legacy.schoolYear,"");assert.equal(legacy.canDelete,true);
  const active=result.events.find(event=>event.eventId===eventId);
  assert.equal(active.canDelete,false);assert.equal(active.reason,"Vui lòng ngừng kích hoạt sự kiện trước khi xóa");
  assert.equal(cloud.metrics.writes,writes);assert.equal(cloud.imageFiles.size,files);
  assert.equal(JSON.stringify(result).includes('"pin"'),false);assert.equal(JSON.stringify(result).includes(actorA),false);
  expectOk(cloud.post("MANAGE_EVENT",{...btc,eventId:legacy.eventId,operation:"delete",confirmed:true,expectedRevision:legacy.eventRevision}));
  const deleted=cloud.post("GET_EVENT_DELETE_STATE",btc).events.find(event=>event.eventId===legacy.eventId);
  assert.equal(deleted.canDelete,false);assert.equal(deleted.canRestore,true);
});

test("kiểm tra xóa chặn giáo viên/học sinh và nêu lý do dữ liệu; ID bị thay vẫn bị kiểm tra lại",()=>{
  const {cloud,btc,teacher,events}=setup(),target=events[1].id;
  const student=redeem(cloud,studentLogins(cloud,btc,[actorA])[0]);
  expectDenied(cloud.post("GET_EVENT_DELETE_STATE",teacher),"FORBIDDEN");
  expectDenied(cloud.post("GET_EVENT_DELETE_STATE",student),"AUTH_REQUIRED");
  expectDenied(cloud.post("GET_EVENT_DELETE_STATE"),"AUTH_REQUIRED");
  expectDenied(JSON.parse(cloud.get({action:"GET_EVENT_DELETE_STATE"}).value),"METHOD_NOT_ALLOWED");
  const state=cloud.post("GET_EVENT_DELETE_STATE",btc),proof=state.events.find(event=>event.eventId===target);
  expectDenied(cloud.post("MANAGE_EVENT",{...btc,eventId:events[2].id,operation:"delete",confirmed:true,expectedRevision:proof.eventRevision}),"CONFLICT");
  // A new dependent record arrives after the read: the write must check canonical rows again.
  cloud.seedRows("WorkflowState",[["drawHistory",target+"::fixture",new Date().toISOString(),JSON.stringify({eventId:target,winnerCode:actorA})]]);
  expectDenied(cloud.post("MANAGE_EVENT",{...btc,eventId:target,operation:"delete",confirmed:true,expectedRevision:proof.eventRevision}),"EVENT_HAS_DEPENDENCIES");
  const refreshed=cloud.post("GET_EVENT_DELETE_STATE",btc).events.find(event=>event.eventId===target);
  assert.equal(refreshed.canDelete,false);assert.equal(refreshed.reasonCode,"EVENT_HAS_DEPENDENCIES");assert.match(refreshed.reason,/lịch sử|kết quả/);
});

test("nút xóa lấy revision riêng, không phụ thuộc setup/ảnh hoặc revision cũ từ GET_EVENT_VIEW",async()=>{
  const {cloud,btc,events}=setup(),browser=mockBrowser(cloud);
  browser.settings.reply=payload=>{
    if(payload.action==="GET_EVENT_SETUP")return {...cloud.post(payload.action,payload),adminSetupVersion:"event-admin-setup-v1",imageApiVersion:"event-images-v2"};
    if(payload.action==="GET_EVENT_VIEW"){
      const value=cloud.post(payload.action,payload);
      for(const record of value.records||[])if(record.id==="event-config")for(const event of record.data.events)delete event.eventRevision;
      return value;
    }
  };
  await browserSettled();await browser.run("loginAdmin("+JSON.stringify(admin)+","+JSON.stringify(btc.authToken)+",3600)");
  browser.run("showAdminTab('config');renderManagedEventCards(managedEventId());renderManagedEventCards(managedEventId())");await browserSettled();
  assert.equal(browser.run("!!managedEventSetup()"),false);
  assert.equal(browser.run("eventDeleteEligibility(EVENTS.find(e=>e.id==='fixture-event-b')).canDelete"),true);
  assert.equal(browser.run("!!currentEventDeleteState().events.find(e=>e.eventId==='fixture-event-b').eventRevision"),true);
  assert.equal(browser.requests.filter(action=>action==="GET_EVENT_DELETE_STATE").length,1);
  assert.equal(browser.run("eventDeleteEligibility(EVENTS.find(e=>e.id==='fixture-event-a')).reason"),"Vui lòng ngừng kích hoạt sự kiện trước khi xóa");
  const diagnostic=JSON.parse(browser.run("JSON.stringify(diagnoseEventDelete())"));
  assert.equal(diagnostic.hasEventsPermission,true);assert.equal(diagnostic.eventDeleteVersion,"event-delete-v1");
  assert.equal(JSON.stringify(diagnostic).includes(btc.authToken),false);assert.equal(JSON.stringify(diagnostic).includes(admin),false);
});

test("backend thiếu/sai API kiểm tra xóa giữ nút khóa có lý do, không gọi write hoặc lặp request",async()=>{
  for(const variant of ["missing","malformed"]){
    const {cloud,btc}=setup(),browser=mockBrowser(cloud);
    browser.settings.reply=payload=>payload.action==="GET_EVENT_DELETE_STATE"?
      variant==="missing"?{success:false,code:"METHOD_NOT_ALLOWED",message:"fixture missing"}:{success:true,eventDeleteVersion:"event-delete-v1",events:[{eventId:"fixture-event-b",canDelete:true}]}:undefined;
    await browserSettled();await browser.run("loginAdmin("+JSON.stringify(admin)+","+JSON.stringify(btc.authToken)+",3600)");
    browser.run("showAdminTab('config')");await browserSettled();
    assert.equal(browser.run("eventDeleteEligibility(EVENTS.find(e=>e.id==='fixture-event-b')).canDelete"),false);
    assert.match(browser.run("eventDeleteEligibility(EVENTS.find(e=>e.id==='fixture-event-b')).reason"),/GET_EVENT_DELETE_STATE|event-delete-v1/);
    browser.run("renderManagedEventCards(managedEventId());renderManagedEventCards(managedEventId())");await browserSettled();
    assert.equal(browser.requests.filter(action=>action==="GET_EVENT_DELETE_STATE").length,1);
    await browser.run("manageEventRemoval('fixture-event-b','delete')");assert.equal(browser.requests.includes("MANAGE_EVENT"),false);
  }
});

function activationRequest(cloud,btc,id,operation="activate",schoolYearId=year){
  const setup=expectOk(cloud.post("GET_EVENT_SETUP",{...btc,eventId:id}));
  return {...btc,eventId:id,schoolYearId,operation,eventActivationVersion:"event-activation-v1",
    expectedRevision:setup.event.eventRevision,expectedYearsRevision:setup.schoolYearsRevision,
    expectedActiveEventId:configView(cloud,btc).activeEventId,confirmedSwitch:true};
}
function legacyActivationEvent(cloud,btc,id){
  cloud.context.withTeacherAuthLock_(()=>{
    const rows=cloud.sheets.get("WorkflowState").rows,row=rows.find(row=>row[1]==="event-config"),data=JSON.parse(row[3]);
    delete data.events.find(event=>event.id===id).schoolYear;row[3]=JSON.stringify(data);
    cloud.context.invalidateEventView_();
  });
}
test("liên kết và kích hoạt cùng một ghi config, ACK đúng sự kiện/năm học, không chờ GET_EVENT_VIEW",()=>{
  const {cloud,btc,events}=setup(395),target=events[1].id;legacyActivationEvent(cloud,btc,target);
  const payload=activationRequest(cloud,btc,target),before=cloud.metrics.writes;
  const protectedRows=["SchoolYears","StudentRoster","EventAccounts","EventStaff"].map(name=>JSON.stringify(cloud.sheets.get(name)?.rows));
  const result=expectOk(cloud.post("CONFIGURE_EVENT_ACTIVATION",payload));
  assert.equal(cloud.metrics.writes,before+1);
  assert.equal(result.change.eventId,target);assert.equal(result.change.targetEventId,target);
  assert.equal(result.change.config.activeEventId,target);
  assert.equal(result.change.config.events.find(event=>event.id===target).schoolYear,year);
  assert.equal(result.change.eventActivationVersion,"event-activation-v1");
  assert.equal(result.change.schoolYearsRevision,payload.expectedYearsRevision);
  assert.deepEqual(["SchoolYears","StudentRoster","EventAccounts","EventStaff"].map(name=>JSON.stringify(cloud.sheets.get(name)?.rows)),protectedRows);
  assert.equal(configView(cloud,btc).activeEventId,target);
  assert.equal(cloud.mail.length,0);
});
test("liên kết năm mở tương lai giữ nguyên sự kiện và năm đang hoạt động",()=>{
  const {cloud,btc,events}=setup(),target=events[2].id;legacyActivationEvent(cloud,btc,target);
  const result=expectOk(cloud.post("CONFIGURE_EVENT_ACTIVATION",activationRequest(cloud,btc,target,"link","2027-2028")));
  assert.equal(result.change.config.activeEventId,eventId);
  assert.equal(result.change.config.events.find(event=>event.id===target).schoolYear,"2027-2028");
  assert.equal(expectOk(cloud.post("LIST_ROSTER",btc)).years.find(y=>y.status==="active").id,year);
  const before=cloud.metrics.writes;
  expectDenied(cloud.post("CONFIGURE_EVENT_ACTIVATION",activationRequest(cloud,btc,target,"activate","2027-2028")),"YEAR_UNAVAILABLE");
  assert.equal(cloud.metrics.writes,before);
});
test("backend từ chối ID/năm sai, năm chưa tạo/đã đóng, không để liên kết một phần",()=>{
  const {cloud,btc,events}=setup(),target=events[1].id;legacyActivationEvent(cloud,btc,target);
  expectOk(cloud.post("MANAGE_YEAR",{...btc,operation:"close",schoolYear:"2028-2029",confirmed:true}));
  const base=activationRequest(cloud,btc,target),before=cloud.metrics.writes;
  for(const schoolYearId of ["", "2026-2028", "2026/2027", "2029-2030", "2028-2029", "2027-2028"])
    expectDenied(cloud.post("CONFIGURE_EVENT_ACTIVATION",{...base,schoolYearId}));
  for(const eventId of ["bad/id", "missing-event", null])expectDenied(cloud.post("CONFIGURE_EVENT_ACTIVATION",{...base,eventId}));
  assert.equal(cloud.metrics.writes,before);
  const stored=configView(cloud,btc);assert.equal(stored.activeEventId,eventId);
  assert.equal(stored.events.find(event=>event.id===target).schoolYear,"");
});
test("đổi sự kiện cần xác nhận, nhiều sự kiện cùng năm được phép, không được chuyển năm đã liên kết",()=>{
  const {cloud,btc,events}=setup(),target=events[1].id,base=activationRequest(cloud,btc,target),before=cloud.metrics.writes;
  expectDenied(cloud.post("CONFIGURE_EVENT_ACTIVATION",{...base,confirmedSwitch:false}),"CONFIRM_REQUIRED");
  expectDenied(cloud.post("CONFIGURE_EVENT_ACTIVATION",{...base,schoolYearId:"2027-2028",operation:"link"}),"YEAR_MISMATCH");
  assert.equal(cloud.metrics.writes,before);
  expectOk(cloud.post("CONFIGURE_EVENT_ACTIVATION",base));
  expectOk(cloud.post("CONFIGURE_EVENT_ACTIVATION",activationRequest(cloud,btc,events[2].id)));
  assert.equal(configView(cloud,btc).activeEventId,events[2].id);
});
test("kích hoạt kiểm tra phiên/quyền BTC hiện tại; không tin role và quyền từ request",()=>{
  const {cloud,btc,teacher,events}=setup(),base=activationRequest(cloud,btc,events[1].id),before=cloud.metrics.writes;
  expectDenied(cloud.post("CONFIGURE_EVENT_ACTIVATION",{...base,authToken:"invalid"}),"AUTH_REQUIRED");
  expectDenied(cloud.post("CONFIGURE_EVENT_ACTIVATION",{...base,...teacher,role:"BTC",permissions:["events"]}),"FORBIDDEN");
  const stats=cloud.seedTeacher("fixture.stats@fpt.edu.vn");
  expectDenied(cloud.post("CONFIGURE_EVENT_ACTIVATION",{...base,...stats}),"FORBIDDEN");
  cloud.setProperty("FS_EVENT_ADMINS",JSON.stringify({[admin]:["stats"]}));
  expectDenied(cloud.post("CONFIGURE_EVENT_ACTIVATION",base),"FORBIDDEN");
  assert.equal(cloud.metrics.writes,before);
});
test("sự kiện lưu trữ chỉ mở lại qua thao tác riêng có xác nhận; mở lại không kích hoạt",()=>{
  const {cloud,btc,events}=setup(),target=events[1].id;
  expectOk(cloud.post("SAVE_EVENT_CONFIG",{...btc,config:{activeEventId:eventId,events:events.map(event=>event.id===target?{...event,archived:true}:event)}}));
  const base=activationRequest(cloud,btc,target),before=cloud.metrics.writes;
  expectDenied(cloud.post("CONFIGURE_EVENT_ACTIVATION",base),"EVENT_ARCHIVED");
  expectDenied(cloud.post("CONFIGURE_EVENT_ACTIVATION",{...base,operation:"link"}),"EVENT_ARCHIVED");
  expectDenied(cloud.post("CONFIGURE_EVENT_ACTIVATION",{...base,operation:"reopen"}),"EVENT_ARCHIVED");
  expectDenied(cloud.post("SAVE_EVENT_CONFIG",{...btc,config:{activeEventId:eventId,events}}),"EVENT_ARCHIVED");
  assert.equal(cloud.metrics.writes,before);
  const result=expectOk(cloud.post("CONFIGURE_EVENT_ACTIVATION",{...base,operation:"reopen",confirmedReopen:true}));
  const reopened=result.change.config.events.find(event=>event.id===target);
  assert.equal(reopened.archived,false);assert.equal(reopened.published,false);assert.equal(result.change.eventId,eventId);
  expectOk(cloud.post("CONFIGURE_EVENT_ACTIVATION",activationRequest(cloud,btc,target)));
  assert.equal(configView(cloud,btc).activeEventId,target);
});
test("liên kết sự kiện cũ có nghiệp vụ cần đối chiếu, giữ nguyên hàng chờ và dấu",()=>{
  const {cloud,btc}=setup(),stamp=["queue",eventId+"::robotics::"+actorA,"",JSON.stringify({id:eventId+"::robotics::"+actorA,eventId,boothId:"robotics",studentCode:actorA,status:"completed",ticketNo:1})];
  cloud.seedRows("WorkflowState",[stamp]);legacyActivationEvent(cloud,btc,eventId);
  const base=activationRequest(cloud,btc,eventId),before=cloud.metrics.writes;
  expectDenied(cloud.post("CONFIGURE_EVENT_ACTIVATION",base),"LEGACY_REVIEW_REQUIRED");
  assert.equal(cloud.metrics.writes,before);
  expectOk(cloud.post("CONFIGURE_EVENT_ACTIVATION",{...base,confirmLegacyYear:true}));
  assert.deepEqual(cloud.sheets.get("WorkflowState").rows.find(row=>row[1]===stamp[1]),stamp);
});
test("hai yêu cầu kích hoạt cùng revision chỉ một lần ghi; đổi trạng thái năm làm request cũ hết hiệu lực",async()=>{
  const {cloud,btc,events}=setup(),base=activationRequest(cloud,btc,events[1].id);
  const replies=await Promise.all([Promise.resolve().then(()=>cloud.post("CONFIGURE_EVENT_ACTIVATION",base)),Promise.resolve().then(()=>cloud.post("CONFIGURE_EVENT_ACTIVATION",base))]);
  assert.equal(replies.filter(reply=>reply.success).length,1);expectDenied(replies.find(reply=>!reply.success),"CONFLICT");
  const stale=activationRequest(cloud,btc,events[2].id),beforeConfig=JSON.stringify(configView(cloud,btc));
  expectOk(cloud.post("MANAGE_YEAR",{...btc,operation:"create",schoolYear:"2029-2030"}));
  const before=cloud.metrics.writes;
  expectDenied(cloud.post("CONFIGURE_EVENT_ACTIVATION",stale),"CONFLICT");
  assert.equal(cloud.metrics.writes,before);assert.equal(JSON.stringify(configView(cloud,btc)),beforeConfig);
});
test("lỗi trước ghi không lưu riêng năm học; backend cũ/sai giao thức không được giả lập thành công",()=>{
  const {cloud,btc,events}=setup(),target=events[1].id;legacyActivationEvent(cloud,btc,target);
  const base=activationRequest(cloud,btc,target),before=cloud.metrics.writes;
  expectDenied(cloud.post("CONFIGURE_EVENT_ACTIVATION",{...base,eventActivationVersion:undefined}),"API_VERSION_MISMATCH");
  expectDenied(cloud.post("CONFIGURE_EVENT_ACTIVATION",{...base,operation:"unknown"}),"INVALID_INPUT");
  expectDenied(JSON.parse(cloud.get({action:"CONFIGURE_EVENT_ACTIVATION",...base}).value),"METHOD_NOT_ALLOWED");
  const original=cloud.context.workflowUpsert_;
  cloud.context.workflowUpsert_=()=>{throw Error("fixture write failure");};
  expectDenied(cloud.post("CONFIGURE_EVENT_ACTIVATION",base));cloud.context.workflowUpsert_=original;
  assert.equal(cloud.metrics.writes,before);const result=configView(cloud,btc);
  assert.equal(result.activeEventId,eventId);assert.equal(result.events.find(event=>event.id===target).schoolYear,"");
});
test("frontend chọn năm học từ SchoolYears, hủy xác nhận không ghi, ACK cập nhật ngay dù đối soát nền mất mạng",async()=>{
  const {cloud,btc,events}=setup(),browser=mockBrowser(cloud);await browserSettled();
  await browser.run("loginAdmin("+JSON.stringify(admin)+","+JSON.stringify(btc.authToken)+",3600)");
  browser.run("showAdminTab('config');selectManagedEvent('fixture-event-b')");await browserSettled();
  assert.deepEqual(browser.node("configEventYear").options.filter(o=>o.value).map(o=>[o.value,o.textContent]),[year,"2027-2028","2028-2029"].map(y=>[y,y]));
  assert.equal(browser.node("managedEventActivate").disabled,false);
  browser.run("globalThis.confirm=()=>false");const before=cloud.metrics.writes;
  await browser.run("saveEventConfig()");assert.equal(cloud.metrics.writes,before);
  browser.settings.offlineAction="GET_EVENT_VIEW";browser.run("globalThis.confirm=()=>true");
  assert.equal(await browser.run("saveEventConfig()"),true);await browserSettled();
  assert.equal(browser.run("activeEvent().id"),events[1].id);
  assert.equal(browser.node("configEventYear").value,year);
  assert.match(browser.node("configYearStatus").textContent,/2026-2027/);
  assert.equal(browser.requests.filter(action=>action==="CONFIGURE_EVENT_ACTIVATION").length,1);
  assert.equal(browser.run("awaitingWriteReconciliation"),true);
});
test("backend chưa cập nhật khóa liên kết/kích hoạt/mở lại có hướng dẫn, không gọi API ghi",async()=>{
  const {cloud,btc}=setup(),browser=mockBrowser(cloud);browser.settings.reply=payload=>{
    if(payload.action==="GET_EVENT_SETUP"){const result=cloud.post(payload.action,payload);delete result.eventActivationVersion;return result;}
  };await browserSettled();await browser.run("loginAdmin("+JSON.stringify(admin)+","+JSON.stringify(btc.authToken)+",3600)");
  browser.run("showAdminTab('config');selectManagedEvent('fixture-event-b')");await browserSettled();
  for(const id of ["managedEventActivate","managedEventLink","managedEventReopen"])assert.equal(browser.node(id).disabled,true);
  assert.match(browser.node("configYearStatus").textContent,/event-activation-v1/);
  const before=cloud.metrics.writes;await browser.run("saveEventConfig()");assert.equal(cloud.metrics.writes,before);
  assert.equal(browser.requests.includes("CONFIGURE_EVENT_ACTIVATION"),false);
});

test("ảnh Desktop/Mobile lưu độc lập theo eventId; default/restore Mobile không đổi Desktop hay tiến độ",()=>{
  const {cloud,btc,events}=setup();cloud.setProperty("FS_EVENT_IMAGE_FOLDER_ID","fixture-images");cloud.setProperty("FS_EVENT_PUBLIC_IMAGES","true");
  const upload=(kind,expectedRevision="")=>({...btc,eventId,kind,operation:"upload",expectedRevision,upload:tinyPng,layout:{mode:"auto"}});
  const desktop=expectOk(cloud.post("SAVE_EVENT_IMAGE",upload("passport"))).images;
  const mobile=expectOk(cloud.post("SAVE_EVENT_IMAGE",upload("passportMobile",desktop.revision))).images;
  assert.equal(mobile.passportVariantsVersion,"passport-responsive-v1");
  assert.equal(mobile.passport.version,desktop.passport.version);assert.notEqual(mobile.passportMobile.version,mobile.passport.version);
  const query={action:"GET_EVENT_IMAGE",eventId,kind:"passportMobile",version:mobile.passportMobile.version};
  assert.equal(expectOk(JSON.parse(cloud.get(query).value)).content,tinyPng.content);
  expectDenied(JSON.parse(cloud.get({...query,eventId:events[1].id}).value),"IMAGE_UNAVAILABLE");
  expectDenied(JSON.parse(cloud.get({...query,version:desktop.passport.version}).value),"IMAGE_UNAVAILABLE");
  const pub=mediaFrom(expectOk(cloud.post("GET_EVENT_VIEW")),eventId);
  assert.equal(pub.passportMobile.version,mobile.passportMobile.version);assert.equal(pub.passportVariantsVersion,undefined);
  const publicText=JSON.stringify(pub);for(const word of ["fileId","content","mime","previous"])assert.equal(publicText.includes('"'+word+'"'),false);
  const rows=cloud.sheets.get("WorkflowState").rows.filter(row=>row[1].startsWith("event-images:"));assert.equal(rows.length,1);
  assert.equal(rows[0][3].includes(tinyPng.content),false);
  const beforeWorkflow=JSON.stringify(cloud.sheets.get("WorkflowState").rows.filter(row=>row[0]!=="config"));
  const reset=expectOk(cloud.post("SAVE_EVENT_IMAGE",{...btc,eventId,kind:"passportMobile",operation:"default",expectedRevision:mobile.revision})).images;
  assert.equal(reset.passportMobile.version,undefined);assert.equal(reset.passportMobile.canRestore,true);assert.equal(reset.passport.version,desktop.passport.version);
  const restored=expectOk(cloud.post("SAVE_EVENT_IMAGE",{...btc,eventId,kind:"passportMobile",operation:"restore",expectedRevision:reset.revision})).images;
  assert.equal(restored.passportMobile.version,mobile.passportMobile.version);assert.equal(restored.passport.version,desktop.passport.version);
  assert.equal(JSON.stringify(cloud.sheets.get("WorkflowState").rows.filter(row=>row[0]!=="config")),beforeWorkflow);
  assert.equal(cloud.imageFiles.size,2);assert.equal(cloud.mail.length,0);
});
test("ảnh Mobile dùng cùng kiểm tra quyền, MIME, revision và tách sự kiện; cập nhật Desktop cũ giữ Mobile",()=>{
  const {cloud,btc,teacher,events}=setup();cloud.setProperty("FS_EVENT_IMAGE_FOLDER_ID","fixture-images");
  const body={...btc,eventId,kind:"passportMobile",operation:"upload",expectedRevision:"",upload:tinyPng};
  expectDenied(cloud.post("SAVE_EVENT_IMAGE",{...body,...teacher}),"FORBIDDEN");
  expectDenied(cloud.post("SAVE_EVENT_IMAGE",{...body,authToken:undefined}),"AUTH_REQUIRED");
  expectDenied(cloud.post("SAVE_EVENT_IMAGE",{...body,upload:{...tinyPng,mime:"image/jpeg"}}),"IMAGE_FORMAT");
  expectDenied(cloud.post("SAVE_EVENT_IMAGE",{...body,kind:"passportOther"}),"INVALID_INPUT");
  assert.equal(cloud.imageFiles.size,0);
  const first=expectOk(cloud.post("SAVE_EVENT_IMAGE",body)).images;
  expectDenied(cloud.post("SAVE_EVENT_IMAGE",body),"CONFLICT");assert.equal(cloud.imageFiles.size,1);
  const desktop=expectOk(cloud.post("SAVE_EVENT_IMAGE",{...body,kind:"passport",expectedRevision:first.revision})).images;
  assert.equal(desktop.passportMobile.version,first.passportMobile.version);
  const next=expectOk(cloud.post("SAVE_EVENT_IMAGE",{...body,eventId:events[1].id})).images;
  assert.notEqual(next.passportMobile.version,first.passportMobile.version);
  assert.equal(next.passport?.version,undefined);
  cloud.setProperty("FS_EVENT_PUBLIC_IMAGES","true");
  const config=configView(cloud,btc);config.events.find(event=>event.id===events[1].id).published=true;
  expectOk(cloud.post("SAVE_EVENT_CONFIG",{...btc,config}));
  const publicOther=mediaFrom(expectOk(cloud.post("GET_EVENT_VIEW")),events[1].id);
  assert.equal(publicOther?.passportMobile,undefined);
});
test("phiếu chọn ảnh Mobile theo viewport, dự phòng Desktop, dữ liệu cá nhân và dấu vẫn từ snapshot chính thức",async()=>{
  const {cloud,btc}=setup(),browser=mockBrowser(cloud);await browserSettled();
  await activateStudentInBrowser(browser,studentLogins(cloud,btc,[actorA])[0]);
  const auth=browser.run("eventAuth()"),snapshot=expectOk(cloud.post("GET_EVENT_VIEW",auth));
  const event=snapshot.records.find(record=>record.id==="event-config").data.events[0];
  event.images={passport:{version:"fake-desktop",width:1200,height:700},passportMobile:{version:"fake-mobile",width:900,height:1500}};
  browser.node("studentPassCanvas").clientWidth=1100;
  browser.run("window.matchMedia=query=>({matches:query.includes('max-width:767')});globalThis.passBackdropCalls=[];globalThis.previewPass=window.createStudentExperiencePass($,()=>{},(node,eventId,kind,version,done)=>{passBackdropCalls.push({id:node.id,eventId,kind,version});if(done)done(!!version)})");
  browser.run("previewPass.acceptSnapshot("+JSON.stringify(snapshot)+","+JSON.stringify(auth.studentSession)+")");browser.node("studentPassButton").click();
  assert.equal(browser.run("passBackdropCalls.at(-1).kind"),"passportMobile");
  assert.equal(browser.run("passBackdropCalls.at(-1).id"),"studentPassArtwork");
  assert.equal(browser.node("studentPassName").textContent,rosterRow(1).name);
  assert.equal(passStamps(browser).length,0);
  browser.node("studentPassDialog").close();browser.run("window.matchMedia=query=>({matches:query.includes('min-width:1024')})");browser.node("studentPassButton").click();
  assert.equal(browser.run("passBackdropCalls.at(-1).kind"),"passport");
  delete event.images.passportMobile;
  browser.run("window.matchMedia=query=>({matches:query.includes('max-width:767')});previewPass.acceptSnapshot("+JSON.stringify(snapshot)+","+JSON.stringify(auth.studentSession)+")");
  assert.equal(browser.run("passBackdropCalls.at(-1).kind"),"passport");assert.equal(browser.run("passBackdropCalls.at(-1).version"),"fake-desktop");
  const invalid={...snapshot,profile:{...snapshot.profile,code:actorB}};
  browser.run("previewPass.acceptSnapshot("+JSON.stringify(invalid)+","+JSON.stringify(auth.studentSession)+")");
  assert.equal(browser.node("studentPassButton").hidden,true);assert.equal(browser.node("studentPassDialog").open,false);
});

test("chọn dấu chỉ mở thông tin riêng; không gửi API, không tự hoàn thành, thông tin cập nhật theo xác nhận backend",async()=>{
  const {cloud,btc}=setup(),browser=mockBrowser(cloud);await browserSettled();
  await activateStudentInBrowser(browser,studentLogins(cloud,btc,[actorA])[0]);
  const student=browser.run("eventAuth()"),joined=expectOk(cloud.post("JOIN_QUEUE",{...student,eventId,boothId:"robotics"})).record;
  await browser.run("pollRemote()");browser.node("studentPassButton").click();
  const circle=()=>browser.node("studentPassBooths").children.find(card=>card.dataset.boothId==="robotics").children[0];
  const beforeRequests=browser.requests.length,beforeQueue=browser.run("JSON.stringify(appState.queue)");
  circle().click();
  assert.equal(browser.requests.length,beforeRequests);assert.equal(browser.run("JSON.stringify(appState.queue)"),beforeQueue);
  assert.equal(circle().children.length,0);assert.equal(passStamps(browser).length,0);
  assert.equal(browser.node("studentPassStampDetails").hidden,false);assert.equal(browser.node("studentPassStampTime").hidden,true);
  assert.equal(browser.node("studentPassStampName").textContent,"Trạm Robotics & Drone");
  assert.match(browser.node("studentPassStampState").textContent,/Chưa được xác nhận/);
  browser.node("studentPassStampDetailsClose").click();assert.equal(browser.node("studentPassStampDetails").hidden,true);
  circle().click();
  expectOk(cloud.post("TEACHER_COMPLETE",{...btc,eventId,boothId:"robotics",ids:[joined.id]}));
  await browser.run("pollRemote()");
  assert.equal(passStamps(browser).length,1);assert.equal(circle().children.length,2);
  assert.equal(circle().children[0].className,"student-pass-stamp-icon");assert.equal(circle().children[1].textContent,"HOÀN THÀNH");
  assert.equal(circle().classList.contains("is-selected"),true);
  assert.equal(browser.node("studentPassStampTime").hidden,false);assert.ok(browser.node("studentPassStampTime").dateTime);
  assert.match(browser.node("studentPassStampState").textContent,/Đã được xác nhận/);
  expectDenied(cloud.post("TEACHER_COMPLETE",{...btc,eventId,boothId:"robotics",ids:[joined.id]}),"CONFLICT");
  await browser.run("pollRemote()");assert.equal(passStamps(browser).length,1);
  browser.node("studentPassClose").click();assert.equal(browser.node("studentPassStampDetails").hidden,true);
  assert.equal(browser.node("studentPassStampName").textContent,"");
});

function profilePng(width,height){
  const zlib=require('node:zlib');
  const crc=bytes=>{let c=0xffffffff;for(const byte of bytes){c^=byte;for(let i=0;i<8;i++)c=(c>>>1)^(c&1?0xedb88320:0);}return(c^0xffffffff)>>>0;};
  const chunk=(tag,data)=>{const t=Buffer.from(tag),length=Buffer.alloc(4),check=Buffer.alloc(4);length.writeUInt32BE(data.length);check.writeUInt32BE(crc(Buffer.concat([t,data])));return Buffer.concat([length,t,data,check]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(Buffer.alloc((width*4+1)*height))),chunk('IEND',Buffer.alloc(0))]);
  return {mime:'image/png',content:png.toString('base64')};
}
test("kiểu họ tên/lớp được lưu riêng từng ảnh, public chỉ nhận cấu hình an toàn và restore giữ kiểu",()=>{
  const {cloud,btc}=setup();cloud.setProperty('FS_EVENT_IMAGE_FOLDER_ID','fixture-images');cloud.setProperty('FS_EVENT_PUBLIC_IMAGES','true');
  const save=(kind,upload,profileTemplate,expectedRevision='')=>expectOk(cloud.post('SAVE_EVENT_IMAGE',{...btc,eventId,kind,operation:'upload',upload,layout:{mode:'auto',profileTemplate,name:'never-store-personal-text',className:'never-store-class'},expectedRevision})).images;
  const desktop=save('passport',profilePng(280,100),'open-stem-landscape-v1');
  const mobile=save('passportMobile',profilePng(184,400),'open-stem-portrait-v1',desktop.revision);
  assert.equal(mobile.passportProfileVersion,'passport-profile-v1');
  assert.equal(mobile.passport.layout.profileTemplate,'open-stem-landscape-v1');assert.equal(mobile.passportMobile.layout.profileTemplate,'open-stem-portrait-v1');
  const publicMeta=mediaFrom(expectOk(cloud.post('GET_EVENT_VIEW')),eventId);
  assert.equal(publicMeta.passport.layout.profileTemplate,'open-stem-landscape-v1');assert.equal(publicMeta.passportProfileVersion,undefined);
  const row=cloud.sheets.get('WorkflowState').rows.find(row=>row[1]==='event-images:'+eventId);
  assert.equal(row[3].includes('never-store-personal-text'),false);assert.equal(row[3].includes('never-store-class'),false);
  const next=expectOk(cloud.post('SAVE_EVENT_IMAGE',{...btc,eventId,kind:'passport',operation:'default',expectedRevision:mobile.revision})).images;
  const restored=expectOk(cloud.post('SAVE_EVENT_IMAGE',{...btc,eventId,kind:'passport',operation:'restore',expectedRevision:next.revision})).images;
  assert.equal(restored.passport.layout.profileTemplate,'open-stem-landscape-v1');assert.equal(restored.passportMobile.version,mobile.passportMobile.version);
});
test("kiểm tra kiểu mẫu và tỷ lệ ảnh trước khi tạo file, không bỏ quyền BTC hoặc thay đổi tiến độ",()=>{
  const {cloud,btc,teacher}=setup();cloud.setProperty('FS_EVENT_IMAGE_FOLDER_ID','fixture-images');
  const body={...btc,eventId,kind:'passport',operation:'upload',upload:profilePng(280,100),expectedRevision:'',layout:{mode:'auto',profileTemplate:'open-stem-landscape-v1'}};
  const before=cloud.metrics.writes;
  expectDenied(cloud.post('SAVE_EVENT_IMAGE',{...body,...teacher}),'FORBIDDEN');
  for(const profileTemplate of ['unknown','__proto__',false,{},'open-stem-portrait-v1'])expectDenied(cloud.post('SAVE_EVENT_IMAGE',{...body,layout:{mode:'auto',profileTemplate}}),'IMAGE_LAYOUT');
  assert.equal(cloud.metrics.writes,before);assert.equal(cloud.imageFiles.size,0);
  const base=expectOk(cloud.post('SAVE_EVENT_IMAGE',body)).images;
  const outside=expectOk(cloud.post('SAVE_EVENT_IMAGE',{...body,operation:'layout',layout:{mode:'auto'},expectedRevision:base.revision})).images;
  assert.deepEqual(outside.passport.layout,{mode:'auto'});
  assert.equal(cloud.mail.length,0);
});
test("tọa độ chỉ áp dụng mẫu đã chọn, khớp ảnh; chữ động không thành ảnh hay trạng thái dấu",()=>{
  const {cloud}=setup(),browser=mockBrowser(cloud);const run=browser.run;
  assert.equal(run("window.FSchoolPassArtwork.uploadTemplate('FPT_Open_STEM_Day_Ngang_HoTen_Lop.png')"),'open-stem-landscape-v1');
  assert.equal(run("window.FSchoolPassArtwork.uploadTemplate('another-image.png')"),'');
  assert.equal(run("!!window.FSchoolPassArtwork.profileTemplate({width:2000,height:714,layout:{profileTemplate:'open-stem-landscape-v1'}})"),true);
  assert.equal(run("!!window.FSchoolPassArtwork.profileTemplate({width:900,height:1500,layout:{profileTemplate:'open-stem-landscape-v1'}})"),false);
  assert.equal(run("!!window.FSchoolPassArtwork.profileTemplate({width:2000,height:714,layout:{mode:'auto'}})"),false);
  const before=browser.requests.length;
  run("globalThis.testArtProfile=window.FSchoolPassArtwork.createArtProfile($('studentPassCanvas'));window.FSchoolPassArtwork.placeArtProfile(testArtProfile,{width:2098,height:749,layout:{profileTemplate:'open-stem-landscape-v1'}},{name:'<img src=x onerror=bad>',className:'10A1'})");
  assert.equal(run('testArtProfile.name.children[0].textContent'),'<img src=x onerror=bad>');
  assert.equal(run('testArtProfile.className.children[0].textContent'),'10A1');
  assert.equal(browser.requests.length,before);assert.equal(passStamps(browser).length,0);
  run('window.FSchoolPassArtwork.placeArtProfile(testArtProfile,null,null)');assert.equal(run('testArtProfile.overlay.hidden'),true);assert.equal(run('testArtProfile.name.children[0].textContent'),'');
});
