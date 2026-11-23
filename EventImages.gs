const EVENT_IMAGE_LIMIT = 1024 * 1024;
const EVENT_IMAGE_KINDS = ["theme", "passport", "passportMobile"];
const EVENT_PASSPORT_VARIANTS_VERSION = "passport-responsive-v1";
const EVENT_IMAGE_API_VERSION = "event-images-v3";
const EVENT_PASSPORT_PROFILE_VERSION = "passport-profile-v1";

function eventImageData_(rows, eventId) {
  const row = rows.find(function(entry) { return entry[0] === "config" && entry[1] === "event-images:" + eventId; });
  return row ? parseWorkflowData_(row) : { revision: "", theme: {}, passport: {} };
}

function eventImagesPublic_() {
  return PropertiesService.getScriptProperties().getProperty("FS_EVENT_PUBLIC_IMAGES") === "true";
}

function eventImageMetadata_(data, admin) {
  const result = admin ? { revision: data.revision, passportVariantsVersion: EVENT_PASSPORT_VARIANTS_VERSION,
    passportProfileVersion: typeof eventPassportProfileTemplate_ === "function" ? EVENT_PASSPORT_PROFILE_VERSION : undefined } : {};
  EVENT_IMAGE_KINDS.forEach(function(kind) {
    const slot = data[kind] || {};
    const current = slot.current;
    if (current && (admin || current.publishApproved === true)) {
      result[kind] = { version: current.version, width: current.width, height: current.height };
      if (admin) result[kind].publishApproved = current.publishApproved === true;
      if (kind !== "theme") result[kind].layout = slot.layout || { mode: "auto" };
    }
    if (admin && slot.previous) {
      if (!result[kind]) result[kind] = {};
      result[kind].canRestore = true;
    }
  });
  return result;
}

function eventImageError_(message = "Ảnh sự kiện không khả dụng.") {
  eventError_("IMAGE_UNAVAILABLE", message);
}

function eventImageKind_(kind) {
  if (!EVENT_IMAGE_KINDS.includes(kind)) eventError_("INVALID_INPUT", "Loại ảnh không hợp lệ.");
  return kind;
}

function readEventImage_(body, admin) {
  if (!admin && !eventImagesPublic_()) eventImageError_();
  const eventId = eventId_(body.eventId), kind = eventImageKind_(body.kind), rows = readEventRows_();
  const config = eventConfigFromRows_(rows);
  const event = config.events.find(function(item) { return item?.id === eventId; });
  if (!event || event.deletedAt || (!admin && !eventPublished_(event, config.activeEventId))) eventImageError_();
  const asset = eventImageData_(rows, eventId)[kind]?.current;
  if (!asset || asset.version !== body.version || (!admin && asset.publishApproved !== true)) eventImageError_();
  return checkedStoredEventImage_(asset);
}

// The asset comes only from server-side event metadata, never from a requested file ID.
function checkedStoredEventImage_(asset) {
  try {
    const blob = DriveApp.getFileById(asset.fileId).getBlob();
    const bytes = blob.getBytes();
    const info = eventImageDimensions_(bytes);
    if (!bytes.length || bytes.length > EVENT_IMAGE_LIMIT || !info || info.mime !== asset.mime ||
        info.width !== asset.width || info.height !== asset.height) throw new Error();
    return { success: true, mime: asset.mime, content: Utilities.base64Encode(bytes) };
  } catch {
    eventImageError_("Không đọc được ảnh trong thư mục sự kiện.");
  }
}

function eventImageDimensions_(bytes) {
  const n = bytes.length;
  const byte = i => bytes[i] & 255;
  const word = (i, size, little = false) => {
    let value = 0;
    for (let j = 0; j < size; j++) value = value * 256 + byte(i + (little ? size - j - 1 : j));
    return value;
  };
  const textAt = (i, length) => Array.from({length}, (_, j) => String.fromCharCode(byte(i + j))).join("");
  if (n >= 45 && word(0, 4) === 0x89504e47 && word(4, 4) === 0x0d0a1a0a &&
      word(8, 4) === 13 && textAt(12, 4) === "IHDR") {
    let hasData = false;
    for (let i = 33; i + 12 <= n;) {
      const size = word(i, 4), tag = textAt(i + 4, 4), end = i + size + 12;
      if (end > n) break;
      if (tag === "IDAT" && size) hasData = true;
      if (tag === "IEND" && size === 0 && end === n && hasData) {
        return { mime: "image/png", width: word(16, 4), height: word(20, 4) };
      }
      i = end;
    }
  }
  if (n >= 16 && word(0, 2) === 0xffd8 && word(n - 2, 2) === 0xffd9) {
    let dimensions;
    for (let i = 2; i + 4 <= n && byte(i) === 255;) {
      const tag = byte(i + 1), size = word(i + 2, 2);
      if (tag === 255) { i++; continue; }
      if (size < 2 || i + 2 + size > n - 2) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3].includes(tag) && size >= 8) {
        dimensions = { mime: "image/jpeg", width: word(i + 7, 2), height: word(i + 5, 2) };
      }
      if (tag === 0xda) return dimensions;
      i += size + 2;
    }
  }
  if (n >= 26 && textAt(0, 4) === "RIFF" && word(4, 4, true) + 8 === n && textAt(8, 4) === "WEBP") {
    let dimensions;
    for (let i = 12; i + 8 <= n;) {
      const tag = textAt(i, 4), size = word(i + 4, 4, true), p = i + 8;
      const end = p + size + size % 2;
      if (end > n || tag === "ANIM" || tag === "ANMF") return null;
      if (tag === "VP8 " && size >= 10 && word(p + 3, 3) === 0x9d012a) {
        dimensions = { mime: "image/webp", width: word(p + 6, 2, true) & 16383, height: word(p + 8, 2, true) & 16383 };
      }
      if (tag === "VP8L" && size >= 5 && byte(p) === 0x2f) {
        const value = word(p + 1, 4, true);
        dimensions = { mime: "image/webp", width: (value & 16383) + 1, height: ((value >>> 14) & 16383) + 1 };
      }
      i = end;
      if (end === n) return dimensions;
    }
  }
  return null;
}

function checkedEventImageUpload_(upload) {
  const content = upload?.content;
  if (typeof content !== "string" || !content.length ||
      content.length > 4 * Math.ceil(EVENT_IMAGE_LIMIT / 3)) {
    eventError_("IMAGE_SIZE", "Mỗi ảnh tải lên tối đa 1 MB.");
  }
  if (content.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(content)) {
    eventError_("IMAGE_FORMAT", "Dữ liệu ảnh không hợp lệ.");
  }
  let bytes;
  try { bytes = Utilities.base64Decode(content); }
  catch { eventError_("IMAGE_FORMAT", "Dữ liệu ảnh không hợp lệ."); }
  if (bytes.length > EVENT_IMAGE_LIMIT) eventError_("IMAGE_SIZE", "Mỗi ảnh tải lên tối đa 1 MB.");
  const info = eventImageDimensions_(bytes);
  if (!info || info.mime !== upload.mime || !info.width || !info.height || Math.max(info.width, info.height) > 2200) {
    eventError_("IMAGE_FORMAT", "Chỉ chấp nhận ảnh JPEG, PNG hoặc WebP hợp lệ, cạnh dài tối đa 2.200 px.");
  }
  return { ...info, bytes: bytes };
}

function eventPassportProfileTemplate_(layout, asset) {
  const id = layout?.profileTemplate;
  if (id == null || id === "" || id === "outside") return {};
  const ratios = {"open-stem-landscape-v1": 2098 / 749, "open-stem-portrait-v1": 1179 / 2556};
  const ratio = typeof id === "string" ? ratios[id] : 0;
  if (typeof id !== "string" || !Object.prototype.hasOwnProperty.call(ratios, id) || !asset?.width || !asset?.height ||
      Math.abs(asset.width / asset.height / ratio - 1) > .015) {
    eventError_("IMAGE_LAYOUT", "Kiểu họ tên/lớp chưa khớp tỷ lệ ảnh. Chọn đúng mẫu Open STEM ngang/dọc hoặc hiển thị thông tin riêng.");
  }
  return {profileTemplate: id};
}

function eventPassportLayout_(layout, asset, booths) {
  const profile = eventPassportProfileTemplate_(layout, asset);
  if (!layout || layout.mode === "auto") return { mode: "auto", ...profile };
  const ids = new Set(booths.map(function(booth) { return booth.id; }));
  if (layout.mode !== "template" || !asset || !Number.isInteger(layout.capacity) ||
      layout.capacity < ids.size || layout.capacity > 80 || !Array.isArray(layout.slots) || layout.slots.length !== ids.size) {
    eventError_("IMAGE_LAYOUT", "Ảnh mẫu cần đủ chỗ và mỗi gian hàng phải có một tọa độ. Hoặc chọn vòng tròn tự động.");
  }
  const slots = layout.slots.map(function(slot) {
    if (!slot || !ids.delete(slot.boothId) || ![slot.x, slot.y, slot.size].every(Number.isFinite) || slot.size < 4 || slot.size > 65) {
      eventError_("IMAGE_LAYOUT", "Kiểm tra gian hàng và tọa độ phần trăm của từng dấu.");
    }
    const rx = slot.size / 2, ry = rx * asset.width / asset.height;
    if (slot.x < rx || slot.x > 100 - rx || slot.y < ry || slot.y > 100 - ry) {
      eventError_("IMAGE_LAYOUT", "Vòng tròn đóng dấu phải nằm hoàn toàn trong ảnh.");
    }
    return { boothId: slot.boothId, x: slot.x, y: slot.y, size: slot.size };
  });
  for (let i = 0; i < slots.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = slots[i], b = slots[j];
      if (Math.hypot(a.x - b.x, (a.y - b.y) * asset.height / asset.width) < (a.size + b.size) / 2) {
        eventError_("IMAGE_LAYOUT", "Hai vòng tròn đang chồng lên nhau. Hãy chỉnh vị trí hoặc đường kính.");
      }
    }
  }
  return { mode: "template", capacity: layout.capacity, slots: slots, ...profile };
}

function eventImageDraft_(body, rows, uploaded) {
  const eventId = eventId_(body.eventId), kind = eventImageKind_(body.kind);
  if (!eventConfigFromRows_(rows).events.some(function(event) { return event?.id === eventId && !event.deletedAt; })) {
    eventError_("INVALID_INPUT", "Sự kiện không tồn tại.");
  }
  const data = eventImageData_(rows, eventId), slot = data[kind] || {};
  if (body.expectedRevision !== data.revision) eventError_("CONFLICT", "Ảnh đã được cập nhật. Hãy tải lại cấu hình rồi thử lại.");
  const op = body.operation;
  if (!["upload", "layout", "default", "restore", "approve"].includes(op) ||
      (op === "layout" && (kind === "theme" || !slot.current)) || (op === "approve" && !slot.current)) {
    eventError_("INVALID_INPUT", "Thao tác ảnh không hợp lệ.");
  }
  if (op === "restore" && !slot.previous) eventError_("INVALID_INPUT", "Chưa có phiên bản trước để khôi phục.");
  // A BTC passport upload is the publication action; the old theme API keeps its legacy approval contract.
  if (kind === "theme" && ["upload", "approve"].includes(op) && body.publishApproved !== true) {
    eventError_("IMAGE_APPROVAL_REQUIRED", "BTC cần xác nhận artwork không chứa dữ liệu cá nhân và được phép hiển thị cho học sinh.");
  }
  const next = op === "restore" ? { ...slot.previous, previous: { current: slot.current || null, layout: slot.layout } } :
    op === "default" ? { previous: slot.current ? { current: slot.current, layout: slot.layout } : slot.previous } :
    op === "upload" ? { current: uploaded, previous: slot.current ? { current: slot.current, layout: slot.layout } : slot.previous } :
    { ...slot };
  if (op === "approve") next.current = { ...slot.current, publishApproved: true };
  if (kind !== "theme" && next.current) next.current = {...next.current, publishApproved: true};
  if (kind !== "theme" && ["layout", "upload", "approve"].includes(op)) {
    next.layout = eventPassportLayout_(body.layout, next.current, eventBooths_(rows, eventId));
  }
  if (next.previous && !next.previous.current) delete next.previous;
  return { ...data, [kind]: next };
}

function saveEventImage_(body) {
  requireEventPermission_(eventStaff_(body), "events");
  const uploaded = body.operation === "upload" ? checkedEventImageUpload_(body.upload) : null;
  eventImageDraft_(body, canonicalEventRows_(), uploaded);
  if (["approve", "layout", "restore"].includes(body.operation)) {
    const slot = eventImageData_(canonicalEventRows_(), body.eventId)[body.kind];
    checkedStoredEventImage_(body.operation === "restore" ? slot?.previous?.current : slot?.current);
  }
  if (uploaded) {
    const folderId = PropertiesService.getScriptProperties().getProperty("FS_EVENT_IMAGE_FOLDER_ID");
    if (!folderId?.trim()) eventImageError_("BTC cần cấu hình FS_EVENT_IMAGE_FOLDER_ID trong Script Properties bằng Folder ID của thư mục chỉ chứa artwork sự kiện.");
    let folder;
    try { folder = DriveApp.getFolderById(folderId.trim()); folder.getId(); }
    catch { eventImageError_("Không mở được thư mục artwork. BTC cần kiểm tra FS_EVENT_IMAGE_FOLDER_ID và quyền của tài khoản thực thi Apps Script."); }
    let file;
    try {
      const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[uploaded.mime];
      uploaded.version = Utilities.getUuid();
      const blob = Utilities.newBlob(uploaded.bytes, uploaded.mime, body.eventId + "-" + body.kind + "-" + uploaded.version + "." + ext);
      file = folder.createFile(blob);
    } catch {
      eventImageError_("Không tạo được file ảnh. BTC cần kiểm tra quyền ghi vào thư mục artwork của tài khoản thực thi Apps Script.");
    }
    try {
      const saved = file.getBlob().getBytes();
      if (saved.length !== uploaded.bytes.length || saved.some((byte, index) => (byte & 255) !== (uploaded.bytes[index] & 255))) throw new Error();
      uploaded.fileId = file.getId();
      uploaded.publishApproved = true;
      delete uploaded.bytes;
    } catch { eventImageError_("File đã được tạo nhưng chưa đọc lại đúng dữ liệu. Chưa ghi nhận ảnh mới; BTC cần kiểm tra quyền đọc Drive."); }
  }
  return eventWrite_(function() {
    requireEventPermission_(eventStaff_(body), "events");
    const rows = canonicalEventRows_(), data = eventImageDraft_(body, rows, uploaded);
    data.revision = Utilities.getUuid();
    workflowUpsert_(workflowSheet_(), rows, "config", "event-images:" + body.eventId, data);
    return { success: true, images: eventImageMetadata_(data, true) };
  }, true);
}

// Editor-only, read-only checks. No folder listing, sharing change or test file creation.
function diagnoseEventImageStorage() {
  const properties = PropertiesService.getScriptProperties(), id = properties.getProperty("FS_EVENT_IMAGE_FOLDER_ID")?.trim();
  const report = {imageApiVersion: EVENT_IMAGE_API_VERSION, folderConfigured: !!id, folderReadable: false, publicDeliveryEnabled: eventImagesPublic_(),
    createFileProbe: "NOT_RUN", images: []};
  if (id) {
    try { report.folderReadable = DriveApp.getFolderById(id).getId() === id; }
    catch { report.storageIssue = "FOLDER_MISSING_OR_NO_ACCESS"; }
  } else report.storageIssue = "FS_EVENT_IMAGE_FOLDER_ID_MISSING";
  try {
    const rows = canonicalEventRows_(), eventId = eventConfigFromRows_(rows).activeEventId;
    report.eventId = eventId;
    for (const kind of EVENT_IMAGE_KINDS) {
      const asset = eventImageData_(rows, eventId)[kind]?.current;
      const item = {kind: kind, configured: !!asset, publishApproved: asset?.publishApproved === true, readable: false};
      if (asset) {
        try { readEventImage_({eventId: eventId, kind: kind, version: asset.version}, true); item.readable = true; }
        catch { item.issue = "IMAGE_MISSING_INVALID_OR_NO_ACCESS"; }
      }
      report.images.push(item);
    }
  } catch { report.configurationIssue = "EVENT_CONFIGURATION_UNAVAILABLE"; }
  console.log(JSON.stringify(report));
  return report;
}
