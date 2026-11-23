const EVENT_BOOTH_DEFAULTS = [
      {id:"robotics",name:"Trạm Robotics & Drone",location:"Tầng 1 · Phòng STEM 01",pin:"1024",topic:"Robot, drone, cảm biến và tự động hóa",description:"Lắp ghép robot và khám phá công nghệ bay không người lái.",icon:"bot",color:"blue"},
      {id:"chemistry",name:"Trạm Thí nghiệm Hóa học vui",location:"Tầng 1 · Phòng Lab Hóa",pin:"2048",topic:"Phản ứng hóa học, axit bazơ và chỉ thị màu",description:"Khám phá phản ứng hóa học qua những thí nghiệm an toàn.",icon:"flask-conical",color:"purple"},
      {id:"ai-iot",name:"Trạm Lập trình AI & IoT",location:"Tầng 2 · Phòng Công nghệ",pin:"3060",topic:"AI, IoT, dữ liệu và cảm biến thông minh",description:"Lập trình thiết bị thông minh và tìm hiểu trí tuệ nhân tạo.",icon:"cpu",color:"cyan"},
      {id:"3d-print",name:"Trạm Thiết kế in 3D",location:"Tầng 2 · Maker Space",pin:"4072",topic:"Thiết kế 3D, mô hình và vật liệu sáng tạo",description:"Biến ý tưởng thành mô hình 3D và sản phẩm hữu hình.",icon:"box",color:"orange"},
      {id:"culture",name:"Trạm Gian hàng Văn hóa 20/11",location:"Sảnh chính · Khu trải nghiệm",pin:"5110",topic:"Văn hóa, tri ân thầy cô và sáng tạo",description:"Gửi lời tri ân và lan tỏa nét đẹp văn hóa học đường.",icon:"heart-handshake",color:"rose"},
      {id:"green",name:"Trạm Khởi nghiệp xanh",location:"Sân trường · Khu vườn xanh",pin:"6025",topic:"Khởi nghiệp, môi trường và phát triển bền vững",description:"Phát triển ý tưởng kinh doanh vì cộng đồng và hành tinh xanh.",icon:"leaf",color:"green"}
    ];
const EVENT_PUBLIC_DEFAULTS = [
      {id:"stemday-2026",name:"Ngày hội STEMDAY 2026",date:"14/11/2026",description:"Ngày hội khoa học, công nghệ và sáng tạo tại FSchool Quy Nhơn.",status:"active"},
      {id:"spring-2027",name:"Hội xuân FSchool",date:"Dự kiến · Tháng 01/2027",description:"Sắc xuân, trò chơi dân gian và gian hàng cộng đồng.",status:"upcoming"},
      {id:"teachers-2026",name:"Chào mừng 20/11",date:"Dự kiến · Tháng 11/2026",description:"Tri ân thầy cô qua những trải nghiệm đáng nhớ.",status:"upcoming"}
    ];

const EVENT_VIEW_POINTER = "event-pass-read-v1";
const TEACHER_PORTAL_VERSION = "teacher-portal-v1";
const EVENT_CONFIG_API_VERSION = "event-admin-setup-v2";
const EVENT_DELETE_VERSION = "event-delete-v1";
const EVENT_ACTIVATION_VERSION = "event-activation-v1";
const EVENT_REVIEW_TAGS = ["Rất thú vị", "Dễ hiểu", "Sáng tạo", "Thân thiện", "Muốn trải nghiệm thêm"];
const EVENT_ICONS = ["bot", "flask-conical", "cpu", "box", "heart-handshake", "leaf", "sparkles", "brain", "microscope", "atom", "rocket", "palette", "music", "circuit-board", "globe", "telescope"];
const EVENT_COLORS = ["blue", "purple", "cyan", "orange", "rose", "green"];

function workflowRecord_(row) {
  return { type: String(row[0]), id: String(row[1]), updatedAt: String(row[2] || ""), data: parseWorkflowData_(row) };
}

function canonicalEventRows_(book = workflowSpreadsheet_()) {
  const sheet = book.getSheetByName(WORKFLOW_SHEET_NAME);
  return sheet ? workflowRows_(sheet) : [];
}

function readEventRows_() {
  const cache = CacheService.getScriptCache();
  const found = cachedEventRows_(cache);
  if (found) return found;
  // Coalesce the first read after expiry or invalidation with the same lock as workflow writes.
  return withTeacherAuthLock_(function() {
    return cachedEventRows_(cache) || cacheEventRows_(cache);
  });
}

function cachedEventRows_(cache) {
  const pointer = cache.get(EVENT_VIEW_POINTER);
  if (pointer) {
    const keys = JSON.parse(pointer);
    const chunks = cache.getAll(keys);
    if (keys.every(function(key) { return typeof chunks[key] === "string"; })) {
      return JSON.parse(keys.map(function(key) { return chunks[key]; }).join(""));
    }
  }
  return null;
}

function cacheEventRows_(cache) {
  const rows = canonicalEventRows_();
  const eventId = eventConfigFromRows_(rows).activeEventId;
  const current = rows.filter(function(row) {
    if (!["queue", "draw", "drawHistory", "student", "eventStudent"].includes(String(row[0]))) return row[0] === "config";
    const data = parseWorkflowData_(row);
    return row[0] === "student" ? Boolean(data.luckyNumbers?.[eventId] || data.favoriteBooths?.[eventId]) :
      data.eventId === eventId;
  });
  const encoded = JSON.stringify(current);
  if (encoded.length <= 1920000) {
    const chunks = {}, keys = [], prefix = "event-view:" + Utilities.getUuid() + ":";
    for (let start = 0; start < encoded.length; start += 16000) {
      const key = prefix + keys.length;
      chunks[key] = encoded.slice(start, start + 16000);
      keys.push(key);
    }
    cache.putAll(chunks, 10);
    cache.put(EVENT_VIEW_POINTER, JSON.stringify(keys), 8);
  }
  return current;
}

function invalidateEventView_() {
  CacheService.getScriptCache().remove(EVENT_VIEW_POINTER);
}

function eventConfigFromRows_(rows) {
  const row = rows.find(function(row) { return row[0] === "config" && row[1] === "event-config"; });
  const data = row ? parseWorkflowData_(row) : {};
  const events = Array.isArray(data.events) ? data.events : EVENT_PUBLIC_DEFAULTS;
  return { activeEventId: String(data.activeEventId || EVENT_PUBLIC_DEFAULTS[0].id), events: events };
}

function eventBooths_(rows, eventId = eventConfigFromRows_(rows).activeEventId) {
  const row = rows.find(function(row) { return row[0] === "config" && row[1] === "booth-config:" + eventId; }) ||
    rows.find(function(row) { return row[0] === "config" && row[1] === "booth-config"; });
  const data = row ? parseWorkflowData_(row) : {};
  const booths = Array.isArray(data.boothList) && data.boothList.length ? data.boothList : EVENT_BOOTH_DEFAULTS;
  return booths.filter(function(booth) {
    return booth && typeof booth.id === "string" && /^[a-z0-9][a-z0-9-]{0,119}$/.test(booth.id);
  }).map(function(booth) {
    return { ...booth, ...(data.booths?.[booth.id] || {}), id: booth.id };
  });
}

function eventBoothRevision_(rows, eventId) {
  return teacherAuthDigest_(JSON.stringify(eventBooths_(rows, eventId)));
}

function eventActor_(body, rows, book) {
  if (body.authToken && body.studentSession) eventError_("INVALID_INPUT", "Yêu cầu có nhiều phiên.");
  if (body.authToken) return eventStaff_(body, book);
  if (body.studentSession) return requireEventStudent_(body, rows, book);
  return { role: "PUBLIC", permissions: [], assignments: [] };
}

function eventPublished_(event, activeEventId) {
  return !event.deletedAt && event.archived !== true && (event.id === activeEventId || event.published === true);
}

function eventLifecycleRevision_(config, eventId) {
  return teacherAuthDigest_(JSON.stringify([config.activeEventId, config.events.find(function(event) { return event.id === eventId; })]));
}

function eventDeletionDependency_(rows, eventId, book, ledgers) {
  for (const row of rows) {
    if (row[0] === "config") continue;
    const data = parseWorkflowData_(row);
    if (data.eventId === eventId || String(row[1]).startsWith(eventId + "::") ||
        [data.luckyNumbers, data.favoriteBooths, data.events].some(function(map) {
          return map && typeof map === "object" && Object.prototype.hasOwnProperty.call(map, eventId);
        })) return "Sự kiện có lượt tham gia, kết quả hoặc lịch sử nghiệp vụ; chỉ được lưu trữ, không thể xóa.";
  }
  if ((ledgers?.accounts || ledgerRows_("accounts", book)).some(function(row) { return row.data.eventId === eventId || row.key.startsWith(eventId + "::"); })) {
    return "Sự kiện có tài khoản hoặc lịch sử tham gia của học sinh; không thể xóa.";
  }
  if ((ledgers?.staff || ledgerRows_("staff", book)).some(function(row) { return row.data.eventId === eventId || row.key.startsWith(eventId + "::"); })) {
    return "Sự kiện có lịch sử phân công giáo viên; hãy lưu trữ để giữ dữ liệu đối soát.";
  }
  return "";
}

// Independent of image configuration, selected-event setup and the active school year.
// The write handler still checks all conditions again under the same lock.
function eventDeleteState_(body) {
  return withTeacherAuthLock_(function() {
    const book = workflowSpreadsheet_(), actor = eventStaff_(body, book);
    requireEventPermission_(actor, "events");
    const rows = canonicalEventRows_(book), config = eventConfigFromRows_(rows);
    const ledgers = {accounts: ledgerRows_("accounts", book), staff: ledgerRows_("staff", book)};
    return {success: true, eventDeleteVersion: EVENT_DELETE_VERSION, activeEventId: config.activeEventId,
      events: config.events.map(function(event) {
        const deleted = !!event.deletedAt, active = event.id === config.activeEventId;
        const dependency = !deleted && !active ? eventDeletionDependency_(rows, event.id, book, ledgers) : "";
        const reasonCode = deleted ? "EVENT_DELETED" : active ? "EVENT_ACTIVE" : dependency ? "EVENT_HAS_DEPENDENCIES" : "READY";
        return {eventId: event.id, name: publicField_(event.name, 80), schoolYear: event.schoolYear || "",
          archived: event.archived === true, deleted: deleted, active: active,
          eventRevision: eventLifecycleRevision_(config, event.id), canDelete: reasonCode === "READY", canRestore: deleted && !active,
          reasonCode: reasonCode, reason: deleted ? "Sự kiện đã xóa mềm; có thể khôi phục." : active ?
            "Vui lòng ngừng kích hoạt sự kiện trước khi xóa" : dependency};
      })};
  });
}

function manageEventLifecycle_(body) {
  return eventWrite_(function() {
    const book = workflowSpreadsheet_(), actor = eventStaff_(body, book);
    requireEventPermission_(actor, "events");
    const rows = canonicalEventRows_(book), config = eventConfigFromRows_(rows), id = eventId_(body.eventId);
    const event = config.events.find(function(item) { return item.id === id; });
    if (!event || !["delete", "restore"].includes(body.operation) || body.confirmed !== true) {
      eventError_("INVALID_INPUT", "Chọn sự kiện và xác nhận thao tác hợp lệ.");
    }
    if (body.expectedRevision !== eventLifecycleRevision_(config, id)) eventError_("CONFLICT", "Sự kiện đã thay đổi. Nạp lại danh sách rồi đối chiếu trước khi thao tác.");
    if (body.operation === "delete") {
      if (id === config.activeEventId) eventError_("EVENT_ACTIVE", "Vui lòng ngừng kích hoạt sự kiện trước khi xóa");
      if (event.deletedAt) eventError_("EVENT_DELETED", "Sự kiện đã được xóa mềm.");
      const dependency = eventDeletionDependency_(rows, id, book);
      if (dependency) eventError_("EVENT_HAS_DEPENDENCIES", dependency);
    } else if (!event.deletedAt) eventError_("INVALID_INPUT", "Sự kiện chưa được xóa mềm.");
    const now = new Date().toISOString(), next = {...event, published: false,
      lifecycleAudit: [...(Array.isArray(event.lifecycleAudit) ? event.lifecycleAudit.slice(-9) : []),
        {operation: body.operation, at: now, actor: actor.email}]};
    if (body.operation === "delete") { next.deletedAt = now; next.deletedBy = actor.email; }
    else { delete next.deletedAt; delete next.deletedBy; }
    const updatedConfig = {
      activeEventId: config.activeEventId, events: config.events.map(function(item) { return item.id === id ? next : item; })
    };
    const responseConfig = eventPublicConfig_(updatedConfig, true, rows, true);
    workflowUpsert_(workflowSheet_(book), rows, "config", "event-config", updatedConfig);
    return {success: true, eventId: id, operation: body.operation,
      config: responseConfig};
  }, true);
}

function eventPublicConfig_(config, canConfigure, rows, canEditImages) {
  const hasImages = rows.some(function(row) { return row[0] === "config" && String(row[1]).startsWith("event-images:"); });
  const publicImages = hasImages && eventImagesPublic_();
  return {
    activeEventId: config.activeEventId,
    events: config.events.filter(function(event) {
      return event && typeof event.id === "string" && /^[a-z0-9][a-z0-9-]{0,119}$/.test(event.id) &&
        !event.deletedAt && (canConfigure || eventPublished_(event, config.activeEventId));
    }).map(function(event) {
      const result = { id: event.id, name: publicField_(event.name, 80), date: publicField_(event.date, 100),
        description: publicField_(event.description, 250),
        status: event.id === config.activeEventId ? "active" : "upcoming" };
      if (canConfigure) Object.assign(result, { schoolYear: event.schoolYear || "", archived: event.archived === true,
        published: event.published === true, eventRevision: eventLifecycleRevision_(config, event.id) });
      if (canEditImages || (publicImages && eventPublished_(event, config.activeEventId))) {
        const images = eventImageMetadata_(eventImageData_(rows, event.id), canEditImages);
        if (!canEditImages && event.id !== config.activeEventId) { delete images.passport; delete images.passportMobile; }
        if (canEditImages || Object.keys(images).length) result.images = images;
      }
      return result;
    }),
    ...(canEditImages ? {deletedEvents: config.events.filter(function(event) { return !!event.deletedAt; }).map(function(event) {
      return {id: event.id, name: publicField_(event.name, 80), schoolYear: event.schoolYear || "", deletedAt: event.deletedAt,
        eventRevision: eventLifecycleRevision_(config, event.id)};
    })} : {})
  };
}

function eventBoothView_(booth, showPin) {
  const result = { id: booth.id, name: publicField_(booth.name, 80), location: publicField_(booth.location, 100),
    topic: publicField_(booth.topic, 120), description: publicField_(booth.description, 250),
    icon: EVENT_ICONS.includes(booth.icon) ? booth.icon : "sparkles",
    color: EVENT_COLORS.includes(booth.color) ? booth.color : "orange" };
  if (showPin && /^\d{4}$/.test(String(booth.pin))) result.pin = String(booth.pin);
  return result;
}

function publicField_(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function eventQueue_(rows, eventId) {
  return rows.filter(function(row) { return row[0] === "queue"; }).map(workflowRecord_)
    .filter(function(record) { return record.data.eventId === eventId; });
}

function queueProjection_(record, own) {
  const item = record.data;
  const data = { id: record.id, eventId: item.eventId, boothId: item.boothId, studentCode: item.studentCode,
    status: item.status === "awaitingRating" ? "completed" : item.status, ticketNo: Number(item.ticketNo),
    createdAt: item.createdAt, updatedAt: record.updatedAt, completedAt: item.completedAt };
  if (own) Object.assign(data, { rating: Number(item.rating) || 0,
    tags: EVENT_REVIEW_TAGS.filter(function(tag) { return Array.isArray(item.tags) && item.tags.includes(tag); }) });
  else Object.assign(data, { studentName: publicField_(item.studentName, 80), className: publicField_(item.className, 18) });
  return { type: "queue", id: record.id, updatedAt: record.updatedAt, data: data };
}

function eventProgress_(rows, eventId, code) {
  const key = eventId + "::" + code;
  const current = rows.find(function(row) { return row[0] === "eventStudent" && String(row[1]) === key; });
  const legacy = current ? null : rows.find(function(row) { return row[0] === "student" && String(row[1]) === code; });
  const data = current ? parseWorkflowData_(current) : legacy ? parseWorkflowData_(legacy) : {};
  return {
    eventId: eventId, code: code,
    luckyNumber: current ? String(data.luckyNumber || "") : String(data.luckyNumbers?.[eventId] || ""),
    favoriteBooth: current ? String(data.favoriteBooth || "") : String(data.favoriteBooths?.[eventId] || "")
  };
}

function eventProgressMap_(rows, eventId) {
  const result = new Map();
  rows.forEach(function(row) {
    if (row[0] !== "student" && row[0] !== "eventStudent") return;
    const data = parseWorkflowData_(row);
    if (row[0] === "eventStudent" && data.eventId === eventId) {
      result.set(String(data.code), data);
    } else if (row[0] === "student" && !result.has(String(row[1]))) {
      result.set(String(row[1]), { luckyNumber: data.luckyNumbers?.[eventId], favoriteBooth: data.favoriteBooths?.[eventId] });
    }
  });
  return result;
}

function eventQueueSummary_(queue, booths) {
  const summary = Object.fromEntries(booths.map(function(booth) {
    return [booth.id, { first: null, waiting: 0, completed: 0, ratingCount: 0, ratingSum: 0, votes: 0 }];
  }));
  queue.forEach(function(record) {
    const item = record.data, counters = summary[item.boothId];
    if (!counters || !Object.prototype.hasOwnProperty.call(summary, item.boothId)) return;
    if (item.status === "waiting") {
      counters.waiting++;
      const number = Number(item.ticketNo);
      if (Number.isFinite(number) && (counters.first === null || number < counters.first)) counters.first = number;
    } else if (item.status === "completed" || item.status === "awaitingRating") {
      counters.completed++;
      const rating = Number(item.rating);
      if (Number.isInteger(rating) && rating >= 1 && rating <= 5) {
        counters.ratingCount++;
        counters.ratingSum += rating;
      }
    }
  });
  return summary;
}

function completedCodes_(queue, booths) {
  const allowed = new Set(booths.map(function(booth) { return booth.id; }));
  const completed = new Map();
  queue.forEach(function(record) {
    const item = record.data;
    if (!allowed.has(item.boothId) || !["completed", "awaitingRating"].includes(item.status)) return;
    if (!completed.has(item.studentCode)) completed.set(item.studentCode, new Set());
    completed.get(item.studentCode).add(item.boothId);
  });
  return new Set([...completed].filter(function(entry) { return allowed.size && entry[1].size === allowed.size; })
    .map(function(entry) { return entry[0]; }));
}

function visibleDraws_(rows, eventId) {
  const reset = drawHistoryResetAt_(rows, eventId);
  const matches = rows.filter(function(row) { return row[0] === "draw" || (row[0] === "drawHistory" && row[1] !== "reset:" + eventId); })
    .map(workflowRecord_).filter(function(record) {
      return record.data.eventId === eventId && record.data.winnerCode &&
        (Date.parse(record.data.drawAt || record.updatedAt) || 0) > reset;
    });
  const ids = new Set(matches.filter(function(record) { return record.type === "drawHistory"; })
    .map(function(record) { return record.data.drawId || record.id; }));
  return matches.filter(function(record) { return record.type === "drawHistory" || !ids.has(record.data.drawId); });
}

function eventView_(body, cachedRows, staff) {
  const rows = cachedRows || readEventRows_();
  const actor = staff || eventActor_(body, rows), config = eventConfigFromRows_(rows), eventId = config.activeEventId;
  const booths = eventBooths_(rows), canConfigure = actor.permissions?.includes("events");
  const records = [
    { type: "config", id: "event-config", data: eventPublicConfig_(config, canConfigure || actor.permissions?.some(function(permission) { return ["assignments", "stats", "draw"].includes(permission); }), rows, canConfigure) },
    { type: "config", id: "booth-config", data: { eventId: eventId, booths: {}, boothList: booths.filter(function(booth) {
      return actor.role !== "TEACHER" || canManageBooth_(actor, eventId, booth.id);
    }).map(function(booth) {
      return eventBoothView_(booth, canConfigure || (actor.role !== "PUBLIC" && actor.role !== "STUDENT" && canManageBooth_(actor, eventId, booth.id)));
    }) } }
  ];
  const access = { role: actor.role, permissions: actor.permissions || [], assignments: (actor.assignments || []).map(function(row) {
    return { eventId: row.eventId, boothId: row.boothId };
  }) };
  const login = studentLoginAvailability_(config, actor.book, actor.activeSchoolYear);
  const response = { success: true, apiVersion: EVENT_PASS_VERSION, records: records, access: access,
    studentAccessVersion: STUDENT_ACCESS_VERSION, studentLoginEnabled: login.enabled, studentLoginState: login.code };
  if (actor.role === "PUBLIC") {
    return response;
  }
  const student = actor.role === "STUDENT";
  const canDraw = actor.permissions?.includes("draw"), canStats = actor.permissions?.includes("stats");
  const queue = eventQueue_(rows, eventId);
  const summaries = eventQueueSummary_(queue, booths);
  response.queueSummary = Object.fromEntries(Object.entries(summaries).filter(function(entry) {
    return student || canStats || canManageBooth_(actor, eventId, entry[0]);
  }).map(function(entry) {
    const [boothId, value] = entry;
    return [boothId, { first: value.first, waiting: value.waiting }];
  }));
  queue.forEach(function(record) {
    if (student ? record.data.studentCode === actor.code : canManageBooth_(actor, eventId, record.data.boothId)) {
      records.push(queueProjection_(record, student));
    }
  });
  if (student) {
    response.studentAccessVersion = STUDENT_ACCESS_VERSION;
    const ownWaiting = new Map(queue.filter(function(record) {
      return record.data.studentCode === actor.code && record.data.status === "waiting";
    }).map(function(record) { return [record.data.boothId, Number(record.data.ticketNo)]; }));
    queue.forEach(function(record) {
      const item = record.data, booth = response.queueSummary[item.boothId];
      if (booth && item.status === "waiting" && Number(item.ticketNo) < ownWaiting.get(item.boothId)) {
        booth.ahead = (booth.ahead || 0) + 1;
      }
    });
    const progress = eventProgress_(rows, eventId, actor.code);
    response.profile = actor.profile;
    response.sessionExpiresAt = actor.entry.data.sessionExpiresAt;
    records.push({ type: "student", id: actor.code, data: { ...actor.profile,
      luckyNumbers: progress.luckyNumber ? { [eventId]: progress.luckyNumber } : {},
      favoriteBooths: progress.favoriteBooth ? { [eventId]: progress.favoriteBooth } : {} } });
  }
  if (canDraw || student) {
    const history = visibleDraws_(rows, eventId);
    history.forEach(function(record) {
      const draw = record.data;
      if (student && (draw.winnerCode !== actor.code || Number(draw.showAfter || 0) > Date.now())) return;
      const data = { eventId: eventId, winnerCode: draw.winnerCode, winningNumber: draw.winningNumber,
        drawAt: draw.drawAt, drawId: draw.drawId || record.id, drawGroupId: draw.drawGroupId };
      if (canDraw) Object.assign(data, { winnerName: draw.winnerName, className: draw.className });
      records.push({ type: record.type, id: record.id, data: data });
    });
    if (canDraw) {
      const winners = new Set(history.map(function(record) { return record.data.winnerCode; }));
      const schoolYear = config.events.find(function(event) { return event.id === eventId; })?.schoolYear;
      const completed = completedCodes_(queue, booths);
      winners.forEach(function(code) { completed.delete(code); });
      response.eligibleCount = schoolYear && completed.size ? ledgerRows_("roster").filter(function(entry) {
        return entry.key.startsWith(schoolYear + "::") && completed.has(entry.data.code);
      }).length : 0;
    }
  }
  if (canStats) {
    const progress = eventProgressMap_(rows, eventId), completed = completedCodes_(queue, booths);
    progress.forEach(function(profile, code) {
      if (completed.has(code) && Object.prototype.hasOwnProperty.call(summaries, profile.favoriteBooth)) {
        summaries[profile.favoriteBooth].votes++;
      }
    });
    response.stats = {
      participants: new Set(queue.map(function(record) { return record.data.studentCode; })).size,
      total: queue.length, eligible: completed.size, booths: summaries
    };
  }
  return response;
}

function eventArchive_(actor, value) {
  if (!actor.permissions.includes("stats") && !actor.permissions.includes("draw")) {
    eventError_("FORBIDDEN", "Bạn chưa có quyền xem lịch sử sự kiện.");
  }
  const eventId = eventId_(value);
  const rows = canonicalEventRows_();
  const event = eventConfigFromRows_(rows).events.find(function(item) { return item.id === eventId; });
  if (!event) eventError_("EVENT_UNAVAILABLE", "Không tìm thấy sự kiện.");
  const response = { success: true, name: publicField_(event.name, 80), schoolYear: event.schoolYear || "" };
  if (actor.permissions.includes("stats")) {
    const queue = eventQueue_(rows, eventId);
    const current = new Map(eventBooths_(rows, eventId).map(function(booth) { return [booth.id, booth]; }));
    const boothIds = [...new Set(queue.map(function(record) { return record.data.boothId; }))];
    const booths = boothIds.map(function(id) { return current.get(id) || { id: id, name: id }; });
    const summary = eventQueueSummary_(queue, booths);
    eventProgressMap_(rows, eventId).forEach(function(progress) {
      if (Object.prototype.hasOwnProperty.call(summary, progress.favoriteBooth)) summary[progress.favoriteBooth].votes++;
    });
    response.stats = { participants: new Set(queue.map(function(record) { return record.data.studentCode; })).size,
      total: queue.length, booths: booths.map(function(booth) {
        const data = summary[booth.id];
        return { name: publicField_(booth.name, 80), completed: data.completed, votes: data.votes,
          ratingCount: data.ratingCount, ratingAverage: data.ratingCount ? data.ratingSum / data.ratingCount : null };
      }) };
  }
  if (actor.permissions.includes("draw")) {
    const unique = new Map();
    rows.forEach(function(row) {
      if (row[0] !== "draw" && row[0] !== "drawHistory") return;
      const draw = parseWorkflowData_(row);
      if (draw.eventId !== eventId || !draw.winnerCode) return;
      unique.set(draw.drawId || row[1], {
        winningNumber: publicField_(draw.winningNumber, 4), winnerName: publicField_(draw.winnerName, 80),
        className: publicField_(draw.className, 18), drawAt: publicField_(draw.drawAt, 35)
      });
    });
    response.draws = [...unique.values()].sort(function(a, b) { return b.drawAt.localeCompare(a.drawAt); });
  }
  return response;
}

function workflowUpsert_(sheet, rows, type, id, data) {
  const key = String(id), updatedAt = new Date().toISOString();
  const value = [type, key, updatedAt, JSON.stringify({ ...data, updatedAt: updatedAt })];
  if (value[3].length > 40000) eventError_("LIMIT", "Bản ghi vượt quá giới hạn lưu trữ.");
  const index = rows.findIndex(function(row) { return row[0] === type && String(row[1]) === key; });
  if (index < 0) {
    sheet.appendRow(value);
    rows.push(value);
  } else {
    sheet.getRange(index + 2, 1, 1, 4).setValues([value]);
    rows[index] = value;
  }
  return workflowRecord_(value);
}

function looseText_(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function eventSchoolYearsRevision_(years) {
  return teacherAuthDigest_(JSON.stringify(years.map(function(year) { return {id: year.id, status: year.status}; })));
}

function configureEventActivation_(body) {
  if (body.eventActivationVersion !== EVENT_ACTIVATION_VERSION) eventError_("API_VERSION_MISMATCH", "Cần cập nhật giao diện kích hoạt sự kiện.");
  return eventWrite_(function() {
    const book = workflowSpreadsheet_(), actor = eventStaff_(body, book);
    requireEventPermission_(actor, "events");
    const rows = canonicalEventRows_(book), config = eventConfigFromRows_(rows), id = eventId_(body.eventId);
    const event = config.events.find(function(item) { return item.id === id && !item.deletedAt; });
    const operation = body.operation, schoolYearId = eventYear_(body.schoolYearId);
    if (!event || !["activate", "link", "reopen"].includes(operation)) eventError_("INVALID_INPUT", "Chọn sự kiện và thao tác hợp lệ.");
    if (body.expectedActiveEventId !== config.activeEventId || body.expectedRevision !== eventLifecycleRevision_(config, id)) {
      eventError_("CONFLICT", "Sự kiện đã thay đổi. Nạp lại cấu hình trước khi thực hiện.");
    }
    const years = ledgerRows_("years", book).map(function(row) { return {id: row.key, status: row.data.status}; });
    if (body.expectedYearsRevision !== eventSchoolYearsRevision_(years)) eventError_("CONFLICT", "Danh sách hoặc trạng thái năm học đã thay đổi. Nạp lại cấu hình.");
    const year = years.find(function(item) { return item.id === schoolYearId; });
    if (!year || !["open", "active"].includes(year.status)) eventError_("YEAR_UNAVAILABLE", "Năm học chưa được tạo hoặc đã đóng.");
    if (event.schoolYear && event.schoolYear !== schoolYearId) eventError_("YEAR_MISMATCH", "Sự kiện đã liên kết với năm học khác; không chuyển lịch sử sang năm mới.");
    if (!event.schoolYear && eventDeletionDependency_(rows, id, book) && body.confirmLegacyYear !== true) {
      eventError_("LEGACY_REVIEW_REQUIRED", "BTC cần đối chiếu và xác nhận năm học của sự kiện có lịch sử trước khi liên kết.");
    }
    if (operation === "reopen") {
      if (!event.archived || body.confirmedReopen !== true || id === config.activeEventId) eventError_("EVENT_ARCHIVED", "Mở lại cần xác nhận riêng và không được tự thay thế sự kiện hoạt động.");
    } else if (event.archived) eventError_("EVENT_ARCHIVED", "Sự kiện đã lưu trữ. Thực hiện Mở lại trước khi liên kết hoặc kích hoạt.");
    if ((operation === "activate" || id === config.activeEventId) && schoolYearId !== years.find(function(item) { return item.status === "active"; })?.id) {
      eventError_("YEAR_UNAVAILABLE", "Chỉ kích hoạt sự kiện thuộc năm học đang hoạt động. Quản lý năm học tại Quản lý học sinh.");
    }
    if (operation === "activate" && id !== config.activeEventId && body.confirmedSwitch !== true) {
      eventError_("CONFIRM_REQUIRED", "BTC cần xác nhận thay thế sự kiện đang hoạt động.");
    }
    const now = new Date().toISOString(), next = {...event, schoolYear: schoolYearId,
      ...(operation === "activate" ? {published: true} : {}),
      ...(operation === "reopen" ? {archived: false, published: false} : {}),
      lifecycleAudit: [...(Array.isArray(event.lifecycleAudit) ? event.lifecycleAudit.slice(-9) : []), {operation: operation, at: now, actor: actor.email}]};
    const updated = {activeEventId: operation === "activate" ? id : config.activeEventId,
      events: config.events.map(function(item) { return item.id === id ? next : item; })};
    const change = {eventId: updated.activeEventId, targetEventId: id, config: eventPublicConfig_(updated, true, rows, true),
      booths: eventBooths_(rows, updated.activeEventId).map(function(booth) { return eventBoothView_(booth, true); }),
      years: years, schoolYearsRevision: eventSchoolYearsRevision_(years), eventActivationVersion: EVENT_ACTIVATION_VERSION};
    // Link and activation are committed in one existing config row, after all validation/projection.
    workflowUpsert_(workflowSheet_(book), rows, "config", "event-config", updated);
    return {success: true, change: change};
  }, true);
}

function saveEventConfig_(actor, body, sheet, rows) {
  requireEventPermission_(actor, "events");
  const previous = eventConfigFromRows_(rows), input = body.config || {};
  const activeEventId = eventId_(input.activeEventId);
  if (!Array.isArray(input.events) || input.events.length > 70) eventError_("INVALID_INPUT", "Danh sách sự kiện không hợp lệ.");
  const byId = new Map(previous.events.map(function(event) { return [event.id, event]; }));
  const events = [], seen = new Set();
  let historical;
  input.events.forEach(function(event) {
    const id = eventId_(event.id), old = byId.get(id), name = looseText_(event.name, 80);
    if (old?.deletedAt) eventError_("EVENT_DELETED", "Sự kiện đã xóa mềm. Nạp lại danh sách; chỉ chức năng Khôi phục mới được khôi phục sự kiện.");
    if (old?.archived && event.archived !== true) eventError_("EVENT_ARCHIVED", "Sự kiện đã lưu trữ; cần thao tác Mở lại có xác nhận riêng.");
    const schoolYear = event.schoolYear ? eventYear_(event.schoolYear) : old?.schoolYear || "";
    if (!name || seen.has(id) || (old?.schoolYear && old.schoolYear !== schoolYear) || (!old && !schoolYear)) {
      eventError_("INVALID_INPUT", "Tên, năm học hoặc mã sự kiện không hợp lệ.");
    }
    if (old && !old.schoolYear && schoolYear && body.confirmLegacyYear !== true) {
      if (!historical) historical = new Set(rows.filter(function(row) {
        return ["queue", "draw", "drawHistory", "eventStudent"].includes(row[0]);
      }).map(function(row) { return parseWorkflowData_(row).eventId; }));
      if (historical.has(id)) {
        eventError_("LEGACY_REVIEW_REQUIRED", "Hãy đối chiếu hồ sơ gốc và xác nhận năm học trước khi liên kết sự kiện cũ.");
      }
    }
    if (schoolYear && !old?.schoolYear) requireSchoolYear_(schoolYear);
    seen.add(id);
    events.push({ id: id, name: name, date: looseText_(event.date, 100), description: looseText_(event.description, 250),
      schoolYear: schoolYear, published: event.published === true, archived: event.archived === true,
      ...(old?.lifecycleAudit ? {lifecycleAudit: old.lifecycleAudit} : {}),
      status: id === activeEventId ? "active" : "upcoming" });
  });
  previous.events.forEach(function(event) {
    if (!seen.has(event.id)) events.push(event.deletedAt ? event : { ...event, archived: true });
  });
  if (events.length > 70) eventError_("LIMIT", "Danh sách gồm cả sự kiện đã xóa mềm vượt giới hạn lưu trữ.");
  const active = events.find(function(event) { return event.id === activeEventId && !event.archived && !event.deletedAt; });
  if (!active) eventError_("INVALID_INPUT", "Chọn sự kiện đang mở hợp lệ.");
  const previousActive = byId.get(previous.activeEventId);
  const opening = activeEventId !== previous.activeEventId || active.schoolYear !== (previousActive?.schoolYear || "");
  if (opening && active.schoolYear && active.schoolYear !== activeSchoolYear_()) {
    eventError_("YEAR_UNAVAILABLE", "Chỉ có thể mở sự kiện thuộc năm học đang hoạt động.");
  }
  workflowUpsert_(sheet, rows, "config", "event-config", { events: events, activeEventId: activeEventId });
  return { change: { eventId: activeEventId, config: eventPublicConfig_(eventConfigFromRows_(rows), true, rows, true),
    ...(body.managedEventId ? {booths: eventBooths_(rows, activeEventId).map(function(booth) { return eventBoothView_(booth, true); })} : {}) } };
}

function saveEventBooths_(actor, body, sheet, rows) {
  requireEventPermission_(actor, "events");
  const eventId = eventId_(body.targetEventId || eventConfigFromRows_(rows).activeEventId);
  const context = eventAccountContext_(eventId, rows);
  if (context.event.archived) eventError_("EVENT_UNAVAILABLE", "Sự kiện đã lưu trữ; cấu hình chỉ đọc.");
  if (body.expectedBoothRevision !== undefined && body.expectedBoothRevision !== eventBoothRevision_(rows, eventId)) {
    eventError_("CONFLICT", "Cấu hình gian hàng đã thay đổi. Nạp lại sự kiện trước khi lưu; bản nháp hiện tại được giữ lại.");
  }
  const input = body.booths;
  if (!Array.isArray(input) || !input.length || input.length > 40) eventError_("INVALID_INPUT", "Danh sách gian hàng không hợp lệ.");
  const ids = new Set(), pins = new Set();
  const boothList = input.map(function(booth) {
    const id = eventId_(booth.id), pin = String(booth.pin || ""), name = looseText_(booth.name, 80);
    if (ids.has(id) || pins.has(pin) || !name || !/^\d{4}$/.test(pin)) eventError_("INVALID_INPUT", "Tên hoặc PIN gian hàng không hợp lệ.");
    ids.add(id);
    pins.add(pin);
    return { id: id, name: name, pin: pin, location: looseText_(booth.location, 100), topic: looseText_(booth.topic, 120),
      description: looseText_(booth.description, 250), icon: EVENT_ICONS.includes(booth.icon) ? booth.icon : "sparkles",
      color: EVENT_COLORS.includes(booth.color) ? booth.color : "orange" };
  });
  workflowUpsert_(sheet, rows, "config", "booth-config:" + eventId, { boothList: boothList, booths: {} });
  return { change: { eventId: eventConfigFromRows_(rows).activeEventId,
    ...(body.targetEventId ? {targetEventId: eventId, boothRevision: eventBoothRevision_(rows, eventId)} : {}),
    booths: boothList.map(function(booth) { return eventBoothView_(booth, true); }) } };
}

function eventAdminSetup_(body) {
  const actor = eventStaff_(body);
  if (!actor.permissions.some(function(permission) { return ["events", "assignments"].includes(permission); })) {
    eventError_("FORBIDDEN", "Bạn không có quyền cấu hình sự kiện.");
  }
  if (typeof deleteEventAssignment_ !== "function" || typeof manageEventLifecycle_ !== "function" ||
      (actor.permissions.includes("events") && typeof checkedStoredEventImage_ !== "function")) {
    eventError_("API_VERSION_MISMATCH", "Bản triển khai thiếu hàm quản trị hoặc ảnh phiếu. BTC cần cập nhật đồng bộ đủ bốn file Apps Script.");
  }
  const rows = canonicalEventRows_(), config = eventConfigFromRows_(rows), eventId = eventId_(body.eventId || config.activeEventId);
  const event = config.events.find(function(item) { return item.id === eventId; });
  if (!event || event.deletedAt) eventError_("INVALID_INPUT", "Sự kiện không tồn tại hoặc đã xóa mềm.");
  const staff = actor.permissions.includes("assignments") ? ledgerRows_("staff").map(function(row) { return row.data; }) : [];
  const teachers = new Map();
  staff.forEach(function(row) { if (typeof row.email === "string") teachers.set(row.email, {email: row.email, name: row.name || ""}); });
  const properties = PropertiesService.getScriptProperties();
  const result = {success: true, adminSetupVersion: EVENT_CONFIG_API_VERSION,
    eventActivationVersion: typeof configureEventActivation_ === "function" ? EVENT_ACTIVATION_VERSION : "",
    imageApiVersion: typeof EVENT_IMAGE_API_VERSION === "string" ? EVENT_IMAGE_API_VERSION : "", eventId: eventId,
    event: eventPublicConfig_(config, true, rows, actor.permissions.includes("events")).events.find(function(item) { return item.id === eventId; }),
    booths: eventBooths_(rows, eventId).map(function(booth) { return eventBoothView_(booth, actor.permissions.includes("events")); }),
    boothRevision: eventBoothRevision_(rows, eventId), icons: EVENT_ICONS,
    assignments: staff.filter(function(row) { return row.eventId === eventId && !row.deletedAt; }), teachers: [...teachers.values()],
    years: ledgerRows_("years").map(function(row) { return {id: row.key, status: row.data.status}; })};
  result.schoolYearsRevision = eventSchoolYearsRevision_(result.years);
  if (actor.permissions.includes("assignments")) result.assignmentRevision = assignmentRevision_(result.assignments);
  if (actor.permissions.includes("events")) result.imageStorage = {
    folderConfigured: !!properties.getProperty("FS_EVENT_IMAGE_FOLDER_ID")?.trim(), publicDeliveryEnabled: eventImagesPublic_()};
  return result;
}

function studentEventWrite_(actor, action, body, sheet, rows, booths, queue) {
  const eventId = actor.eventId, code = actor.code;
  if (action === "ISSUE_LUCKY_NUMBER" || action === "SUBMIT_VOTE") {
    if (!completedCodes_(queue, booths).has(code)) eventError_("INVALID_INPUT", "Hãy hoàn thành đủ gian hàng trước.");
    const progress = eventProgress_(rows, eventId, code);
    if (action === "SUBMIT_VOTE") {
      const boothId = eventId_(body.boothId);
      if (!booths.some(function(booth) { return booth.id === boothId; }) ||
          (progress.favoriteBooth && progress.favoriteBooth !== boothId)) {
        eventError_("INVALID_INPUT", "Phiếu bình chọn không hợp lệ hoặc đã ghi nhận.");
      }
      progress.favoriteBooth = boothId;
    }
    ensureLuckyTicket_(progress, eventProgressMap_(rows, eventId), sheet, rows);
    return { luckyNumber: progress.luckyNumber };
  }
  const boothId = eventId_(body.boothId);
  if (!booths.some(function(booth) { return booth.id === boothId; })) eventError_("INVALID_INPUT", "Gian hàng không hợp lệ.");
  const id = eventId + "::" + boothId + "::" + code;
  const prior = queue.find(function(record) {
    return record.data.studentCode === code && record.data.boothId === boothId;
  });
  const now = new Date().toISOString();
  if (action === "JOIN_QUEUE") {
    if (prior && prior.data.status !== "cancelled") return { record: queueProjection_(prior, true), duplicate: true };
    const ticketNo = nextBoothTicket_(queue, boothId);
    const record = workflowUpsert_(sheet, rows, "queue", prior?.id || id, { eventId: eventId, boothId: boothId,
      studentCode: code, studentName: actor.profile.name, className: actor.profile.className,
      ticketNo: ticketNo, status: "waiting", createdAt: now });
    return { record: queueProjection_(record, true) };
  }
  if (!prior) eventError_("INVALID_INPUT", "Chưa có lượt trải nghiệm.");
  if (action === "CANCEL_QUEUE" && prior.data.status === "waiting") {
    prior.data.status = "cancelled";
    prior.data.cancelledAt = now;
  } else if (action === "SUBMIT_RATING" && ["completed", "awaitingRating"].includes(prior.data.status) &&
      Number.isInteger(body.rating) && body.rating >= 1 && body.rating <= 5 && !prior.data.rating) {
    prior.data.status = "completed";
    prior.data.rating = body.rating;
    prior.data.tags = EVENT_REVIEW_TAGS.filter(function(tag) { return Array.isArray(body.tags) && body.tags.includes(tag); });
    prior.data.ratingUpdatedAt = now;
  } else {
    eventError_("CONFLICT", "Lượt đã thay đổi hoặc đánh giá đã được ghi.");
  }
  return { record: queueProjection_(workflowUpsert_(sheet, rows, "queue", prior.id, prior.data), true) };
}

function nextBoothTicket_(queue, boothId) {
  return 1 + queue.reduce(function(max, record) {
    return record.data.boothId === boothId ? Math.max(max, Number(record.data.ticketNo) || 0) : max;
  }, 0);
}

function ensureLuckyTicket_(progress, assigned, sheet, rows) {
  if (!/^\d{4}$/.test(progress.luckyNumber)) {
    const used = new Set([...assigned.values()].map(function(entry) { return String(entry.luckyNumber || ""); }));
    let hash = 2166136261;
    const source = progress.eventId + ":" + progress.code;
    for (let index = 0; index < source.length; index++) hash = Math.imul(hash ^ source.charCodeAt(index), 16777619) >>> 0;
    for (let offset = 0; offset < 9000; offset++) {
      const number = String(1000 + ((hash + offset) % 9000));
      if (!used.has(number)) {
        progress.luckyNumber = number;
        break;
      }
    }
    if (!/^\d{4}$/.test(progress.luckyNumber)) eventError_("LIMIT", "Đã hết số vé may mắn.");
  }
  assigned.set(progress.code, progress);
  workflowUpsert_(sheet, rows, "eventStudent", progress.eventId + "::" + progress.code, progress);
}

function teacherEventQueueWrite_(actor, action, body, eventId, sheet, rows, queue) {
  const boothId = eventId_(body.boothId);
  if (!canManageBooth_(actor, eventId, boothId)) eventError_("FORBIDDEN", "Bạn chưa được phân công gian hàng này.");
  const ids = Array.isArray(body.ids) ? body.ids : [];
  const waiting = queue.filter(function(item) { return item.data.boothId === boothId && item.data.status === "waiting"; })
    .sort(function(a, b) { return Number(a.data.ticketNo) - Number(b.data.ticketNo); });
  const now = new Date().toISOString();
  let selected;
  if (action === "TEACHER_RECALL") {
    const missed = queue.find(function(item) { return item.id === ids[0] && item.data.boothId === boothId && item.data.status === "missed"; });
    if (ids.length !== 1 || !missed) eventError_("CONFLICT", "Lượt này không còn ở trạng thái nhỡ.");
    missed.data.ticketNo = nextBoothTicket_(queue, boothId);
    missed.data.status = "waiting";
    missed.data.recalledAt = now;
    selected = [missed];
  } else {
    if (ids.length !== 1 && !(action === "TEACHER_COMPLETE" && ids.length >= 3 && ids.length <= 5)) {
      eventError_("INVALID_INPUT", "Chọn một lượt hoặc nhóm 3–5 lượt.");
    }
    selected = waiting.slice(0, ids.length);
    if (selected.length !== ids.length || !selected.every(function(item, index) { return item.id === ids[index]; })) {
      eventError_("CONFLICT", "Hàng đợi đã thay đổi. Hãy tải lại trước khi xử lý.");
    }
    selected.forEach(function(item) {
      item.data.status = action === "TEACHER_COMPLETE" ? "completed" : "missed";
      item.data[action === "TEACHER_COMPLETE" ? "completedAt" : "missedAt"] = now;
    });
  }
  const written = selected.map(function(item) { return workflowUpsert_(sheet, rows, "queue", item.id, item.data); });
  if (action === "TEACHER_COMPLETE") {
    return { change: { eventId: eventId, boothId: boothId,
      records: written.map(function(record) { return queueProjection_(record, false); }) } };
  }
  return {};
}

function drawEventWinners_(actor, body, event, booths, sheet, rows, queue) {
  requireEventPermission_(actor, "draw");
  const eventId = event.id, size = body.count;
  if (!Number.isInteger(size) || size < 1 || size > STUDENT_ROSTER_MAX) eventError_("INVALID_INPUT", "Số người nhận giải không hợp lệ.");
  const completed = completedCodes_(queue, booths);
  const won = new Set(visibleDraws_(rows, eventId).map(function(record) { return record.data.winnerCode; }));
  const candidates = ledgerRows_("roster").filter(function(row) {
    return row.key.startsWith(event.schoolYear + "::") && completed.has(row.data.code) && !won.has(row.data.code);
  }).map(function(row) { return row.data; });
  if (candidates.length < size) eventError_("CONFLICT", "Danh sách đủ điều kiện đã thay đổi. Hãy làm mới.");
  const assigned = eventProgressMap_(rows, eventId), drawAt = new Date(Math.max(Date.now(), drawHistoryResetAt_(rows, eventId) + 1)).toISOString();
  const groupId = eventId + "::" + Utilities.getUuid();
  const winners = [];
  for (let index = 0; index < size; index++) {
    const offset = index + Math.floor(Math.random() * (candidates.length - index));
    [candidates[index], candidates[offset]] = [candidates[offset], candidates[index]];
    const winner = candidates[index], progress = eventProgress_(rows, eventId, winner.code);
    if (!/^\d{4}$/.test(progress.luckyNumber)) ensureLuckyTicket_(progress, assigned, sheet, rows);
    winners.push({
      eventId: eventId, winningNumber: progress.luckyNumber, winnerCode: winner.code, winnerName: winner.name,
      className: winner.className, drawAt: drawAt, showAfter: Date.now() + 3000,
      drawGroupId: groupId, drawId: groupId + "::" + (index + 1)
    });
  }
  // One append range publishes the complete round together.
  const values = winners.map(function(winner) { return ["drawHistory", winner.drawId, drawAt, JSON.stringify(winner)]; });
  const first = sheet.getLastRow() + 1, deficit = first + values.length - 1 - sheet.getMaxRows();
  if (deficit > 0) sheet.insertRowsAfter(sheet.getMaxRows(), deficit);
  sheet.getRange(first, 1, values.length, 4).setValues(values);
  return { winners: winners };
}

const EVENT_STUDENT_WRITES = ["JOIN_QUEUE", "CANCEL_QUEUE", "SUBMIT_RATING", "SUBMIT_VOTE", "ISSUE_LUCKY_NUMBER"];
const EVENT_QUEUE_WRITES = ["TEACHER_COMPLETE", "TEACHER_SKIP", "TEACHER_RECALL"];
const EVENT_ADMIN_WRITES = ["SAVE_EVENT_CONFIG", "SAVE_EVENT_BOOTHS", "START_DRAW", "RESET_DRAW_HISTORY"];

function writeEventWorkflow_(action, body) {
  if (!body.authToken && !body.studentSession) eventError_("FORBIDDEN", "Bạn không có quyền thực hiện thao tác này.");
  return eventWrite_(function() {
    const book = workflowSpreadsheet_();
    const rows = canonicalEventRows_(book);
    const actor = eventActor_(body, rows, book);
    const studentWrite = EVENT_STUDENT_WRITES.includes(action);
    if (studentWrite ? actor.role !== "STUDENT" : ["STUDENT", "PUBLIC"].includes(actor.role)) {
      eventError_("FORBIDDEN", "Bạn không có quyền thực hiện thao tác này.");
    }
    const sheet = workflowSheet_(book), config = eventConfigFromRows_(rows), eventId = config.activeEventId;
    let result = {};
    if (action === "SAVE_EVENT_CONFIG" || action === "SAVE_EVENT_BOOTHS") {
      if (body.eventId !== undefined && body.eventId !== eventId) eventError_("CONFLICT", "Sự kiện đang mở đã thay đổi.");
      result = action === "SAVE_EVENT_CONFIG" ? saveEventConfig_(actor, body, sheet, rows) : saveEventBooths_(actor, body, sheet, rows);
    } else if (action === "RESET_DRAW_HISTORY") {
      requireEventPermission_(actor, "draw");
      if (body.eventId !== eventId) eventError_("CONFLICT", "Sự kiện đang mở đã thay đổi.");
      const latest = visibleDraws_(rows, eventId).reduce(function(max, record) {
        return Math.max(max, Date.parse(record.data.drawAt || record.updatedAt) || 0);
      }, 0);
      const resetAt = new Date(Math.max(Date.now(), latest)).toISOString();
      workflowUpsert_(sheet, rows, "drawHistory", "reset:" + eventId, { eventId: eventId, reset: true, resetAt: resetAt });
    } else {
      const { event } = eventAccountContext_(eventId, rows, book);
      if (body.eventId !== eventId || event.schoolYear !== activeSchoolYear_(book)) {
        eventError_("CONFLICT", "Sự kiện hoặc năm học đang mở đã thay đổi.");
      }
      const queue = eventQueue_(rows, eventId), booths = eventBooths_(rows);
      if (studentWrite) result = studentEventWrite_(actor, action, body, sheet, rows, booths, queue);
      else if (action === "START_DRAW") result = drawEventWinners_(actor, body, event, booths, sheet, rows, queue);
      else result = teacherEventQueueWrite_(actor, action, body, eventId, sheet, rows, queue);
    }
    return { success: true, ...result };
  }, true);
}

function resolveEventBooth_(body) {
  const rows = readEventRows_(), actor = requireEventStudent_(body, rows);
  if (body.eventId && body.eventId !== actor.eventId) eventError_("INVALID_INPUT", "Mã QR thuộc sự kiện khác.");
  const booths = eventBooths_(rows), id = String(body.boothId || ""), pin = String(body.pin || "");
  if (pin && !/^\d{4}$/.test(pin)) eventError_("INVALID_INPUT", "PIN không hợp lệ.");
  const booth = booths.find(function(entry) {
    return pin ? String(entry.pin) === pin && (!id || entry.id === id) : id && entry.id === id;
  });
  if (!booth) eventError_("INVALID_INPUT", "Không tìm thấy gian hàng cho mã này.");
  return { success: true, boothId: booth.id, eventId: actor.eventId };
}

function teacherEventView_(body) {
  let stage = "TEACHER_ACCESS";
  try {
    const staff = eventStaff_(body);
    stage = "EVENT_DATA";
    const view = eventView_(body, undefined, staff);
    view.teacherPortalVersion = TEACHER_PORTAL_VERSION;
    return view;
  } catch (error) {
    if (error.authCode) {
      error.teacherViewStage = stage;
      throw error;
    }
    const messages = {
      SPREADSHEET_CONFIGURATION: "BTC cần cấu hình FS_EVENT_SPREADSHEET_ID cho bản triển khai.",
      SPREADSHEET_OPEN: "BTC cần kiểm tra ID bảng tính và quyền mở tệp của tài khoản triển khai.",
      ADMIN_GRANTS: "BTC cần kiểm tra định dạng cấu hình FS_EVENT_ADMINS.",
      STAFF_ASSIGNMENTS: "BTC cần kiểm tra dữ liệu phân công trong EventStaff.",
      TEACHER_ACCESS: "Chưa đọc được quyền truy cập Cổng Giáo viên.",
      EVENT_DATA: "Chưa đọc được dữ liệu sự kiện. Hãy báo BTC kiểm tra bảng dữ liệu."
    };
    const failedStage = error.teacherViewStage || stage;
    const failure = teacherAuthError_("TEACHER_VIEW_UNAVAILABLE", messages[failedStage]);
    failure.teacherViewStage = failedStage;
    throw failure;
  }
}

function studentAuthRoutes_() {
  return {LOGIN_STUDENT: loginStudentWithEventAccess_, LOGOUT_STUDENT: revokeStudent_};
}

function dispatchEventPass_(action, body) {
  if (action === "CONFIGURE_EVENT_ACTIVATION") return configureEventActivation_(body);
  if (action === "GET_EVENT_DELETE_STATE") return eventDeleteState_(body);
  if (action === "MANAGE_EVENT") return manageEventLifecycle_(body);
  if (action === "DELETE_EVENT_ASSIGNMENT") return deleteEventAssignment_(body);
  if (action === "GET_EVENT_SETUP") return eventAdminSetup_(body);
  if (action === "GET_EVENT_VIEW") {
    const view = body.authToken && !body.studentSession ? teacherEventView_(body) : eventView_(body);
    if (view.access.role === "PUBLIC" || typeof body.knownRevision !== "string") return view;
    // Compare only the current, authorized projection. Authorization and time-dependent
    // results (for example delayed draw announcements) are evaluated on every request.
    const viewRevision = teacherAuthDigest_(JSON.stringify(view));
    if (body.knownRevision === viewRevision) {
      return { success: true, apiVersion: view.apiVersion, teacherPortalVersion: view.teacherPortalVersion,
        studentAccessVersion: view.studentAccessVersion, studentLoginEnabled: view.studentLoginEnabled,
        studentLoginState: view.studentLoginState, unchanged: true, viewRevision: viewRevision };
    }
    view.viewRevision = viewRevision;
    return view;
  }
  if (action === "LOGIN_STUDENT" || action === "LOGOUT_STUDENT") {
    const handler = studentAuthRoutes_()[action];
    if (typeof handler !== "function") eventError_("API_VERSION_MISMATCH", "Bản triển khai thiếu action xác thực học sinh.");
    return handler(body);
  }
  if (action === "CONFIGURE_STUDENT_ACCESS") return configureStudentAccess_(body);
  if (action === "REDEEM_STUDENT" || action === "MANAGE_ACTIVATION") {
    eventError_("API_VERSION_MISMATCH", "Trang đang dùng luồng kích hoạt cũ. Hãy tải lại phiên bản mới.");
  }
  if (action === "RESOLVE_BOOTH") return resolveEventBooth_(body);
  if (action === "SAVE_EVENT_IMAGE") return saveEventImage_(body);
  if (action === "PREVIEW_EVENT_IMAGE") {
    requireEventPermission_(eventStaff_(body), "events");
    return readEventImage_(body, true);
  }
  if (action === "GET_EVENT_ARCHIVE") return eventArchive_(eventStaff_(body), body.eventId);
  if (EVENT_STUDENT_WRITES.includes(action) || EVENT_QUEUE_WRITES.includes(action) || EVENT_ADMIN_WRITES.includes(action)) {
    return writeEventWorkflow_(action, body);
  }
  if (["LIST_ROSTER", "SAVE_ROSTER", "MANAGE_YEAR", "MANAGE_STUDENT_ACCOUNTS", "SET_EVENT_ASSIGNMENT", "LIST_EVENT_ASSIGNMENTS"].includes(action)) {
    const actor = eventStaff_(body);
    if (action === "LIST_ROSTER") return listRoster_(actor, body);
    if (action === "SAVE_ROSTER") return importRoster_(actor, body);
    if (action === "MANAGE_YEAR") return manageSchoolYear_(actor, body);
    if (action === "MANAGE_STUDENT_ACCOUNTS") return manageStudentAccounts_(actor, body);
    if (action === "SET_EVENT_ASSIGNMENT") return setEventAssignment_(actor, body);
    requireEventPermission_(actor, "assignments");
    const eventId = eventId_(body.eventId);
    return { success: true, assignments: ledgerRows_("staff").map(function(row) { return row.data; })
      .filter(function(row) { return row.eventId === eventId && row.enabled === true && !row.deletedAt; }) };
  }
  eventError_("METHOD_NOT_ALLOWED", "Thao tác không được hỗ trợ.");
}
