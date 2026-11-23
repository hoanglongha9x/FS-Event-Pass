/* Local roster reader. Files and worksheet contents stay in the browser until approval. */
const ROSTER_MAX_FILE_BYTES = 2 * 1024 * 1024;
const ROSTER_MAX_XML_BYTES = 8 * 1024 * 1024;
const ROSTER_MAX_ROWS = 401;

function rosterFileError(message) { throw new Error(message); }

function rosterCsvRows(source) {
  const text = source.replace(/^\uFEFF/, "");
  const header = text.split(/\r?\n/, 1)[0];
  const outsideQuotes = header.replace(/"(?:""|[^"])*"/g, "");
  const separator = [",", ";", "\t"].sort((a, b) => outsideQuotes.split(b).length - outsideQuotes.split(a).length)[0];
  const rows = [];
  let row = [], cell = "", quoted = false, closedQuote = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text[index + 1] === '"') { cell += '"'; index++; }
      else { quoted = false; closedQuote = true; }
    } else if (char === separator) {
      row.push(cell); cell = ""; closedQuote = false;
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(cell); rows.push(row); row = []; cell = ""; closedQuote = false;
    } else if (char === '"' && !cell && !closedQuote) {
      quoted = true;
    } else if (closedQuote || char === '"') {
      rosterFileError("Dữ liệu CSV có dấu ngoặc kép không hợp lệ.");
    } else cell += char;
    if (rows.length > ROSTER_MAX_ROWS || row.length > 32) rosterFileError("Danh sách vượt quá 400 học sinh hoặc quá nhiều cột.");
  }
  if (quoted) rosterFileError("Tệp CSV có ô chưa đóng dấu ngoặc kép.");
  if (cell || row.length || closedQuote) rows.push([...row, cell]);
  if (rows.length > ROSTER_MAX_ROWS) rosterFileError("Danh sách vượt quá 400 học sinh.");
  return rows;
}

function rosterZipIndex(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let footer = bytes.length - 22;
  const earliest = Math.max(0, footer - 65535);
  while (footer >= earliest && (view.getUint32(footer, true) !== 0x06054b50 ||
      footer + 22 + view.getUint16(footer + 20, true) !== bytes.length)) footer--;
  if (footer < earliest || view.getUint16(footer + 4, true) || view.getUint16(footer + 6, true)) {
    rosterFileError("Tệp XLSX không hợp lệ.");
  }
  const count = view.getUint16(footer + 10, true), size = view.getUint32(footer + 12, true);
  let cursor = view.getUint32(footer + 16, true);
  if (!count || count > 200 || cursor + size > footer) rosterFileError("Tệp XLSX vượt giới hạn hoặc dùng định dạng chưa hỗ trợ.");
  const entries = new Map();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > footer || view.getUint32(cursor, true) !== 0x02014b50) rosterFileError("Mục lục XLSX không hợp lệ.");
    const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true);
    const compressed = view.getUint32(cursor + 20, true), expanded = view.getUint32(cursor + 24, true);
    const nameSize = view.getUint16(cursor + 28, true), extra = view.getUint16(cursor + 30, true);
    const comment = view.getUint16(cursor + 32, true), offset = view.getUint32(cursor + 42, true);
    const nameStart = cursor + 46;
    cursor = nameStart + nameSize + extra + comment;
    if (cursor > footer || offset + 30 > footer || view.getUint32(offset, true) !== 0x04034b50) {
      rosterFileError("Bản ghi nén XLSX không hợp lệ.");
    }
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameSize));
    const dataStart = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    if (entries.has(name) || dataStart + compressed > footer) rosterFileError("Thư mục XLSX không hợp lệ.");
    entries.set(name, { flags, method, compressed, expanded, dataStart });
  }
  return entries;
}

async function rosterXmlPart(bytes, entry) {
  if (!entry) rosterFileError("Tệp thiếu thành phần bảng tính.");
  if (entry.flags & 1 || ![0, 8].includes(entry.method) || entry.expanded > ROSTER_MAX_XML_BYTES) {
    rosterFileError("Tệp có phần nén không hỗ trợ hoặc quá lớn.");
  }
  const part = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressed);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let xml;
  if (entry.method === 0) {
    if (part.length !== entry.expanded) rosterFileError("Kích thước phần XLSX không hợp lệ.");
    xml = decoder.decode(part);
  } else {
    if (typeof DecompressionStream !== "function") rosterFileError("Trình duyệt này chưa đọc được XLSX. Hãy xuất CSV UTF-8.");
    const reader = new Blob([part]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    const pieces = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > entry.expanded || size > ROSTER_MAX_XML_BYTES) rosterFileError("Dữ liệu XLSX nén vượt giới hạn.");
        pieces.push(decoder.decode(value, { stream: true }));
      }
      if (size !== entry.expanded) rosterFileError("Dữ liệu XLSX bị thiếu.");
      xml = pieces.join("") + decoder.decode();
    } finally { await reader.cancel(); }
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) rosterFileError("Thành phần XML không hợp lệ.");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagNameNS("*", "parsererror").length) rosterFileError("Không phân tích được tệp XLSX.");
  return doc;
}

async function rosterXlsxRows(bytes) {
  const entries = rosterZipIndex(bytes);
  const elements = (doc, name) => [...doc.getElementsByTagNameNS("*", name)];
  const workbook = await rosterXmlPart(bytes, entries.get("xl/workbook.xml"));
  const workbookRels = await rosterXmlPart(bytes, entries.get("xl/_rels/workbook.xml.rels"));
  const first = elements(workbook, "sheet")[0];
  const id = first?.getAttribute("r:id") ||
    first?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
  const rel = id && elements(workbookRels, "Relationship").find(item => item.getAttribute("Id") === id);
  const target = rel?.getAttribute("Target") || "";
  const path = target.startsWith("/") ? target.slice(1) : "xl/" + target;
  if (rel?.getAttribute("TargetMode") === "External" || !/^xl\/[a-zA-Z0-9_./-]+\.xml$/.test(path) || path.includes("..")) {
    rosterFileError("Không tìm thấy trang tính đầu tiên.");
  }
  const strings = entries.has("xl/sharedStrings.xml")
    ? elements(await rosterXmlPart(bytes, entries.get("xl/sharedStrings.xml")), "si")
      .map(cell => elements(cell, "t").map(node => node.textContent).join(""))
    : [];
  const rows = elements(await rosterXmlPart(bytes, entries.get(path)), "row");
  if (rows.length > ROSTER_MAX_ROWS) rosterFileError("Danh sách vượt quá 400 học sinh.");
  return rows.map((row, index) => {
    const values = [];
    values.sourceRow = Number(row.getAttribute("r")) || index + 1;
    for (const cell of elements(row, "c")) {
      const col = /^[A-Z]+/.exec(cell.getAttribute("r") || "")?.[0];
      if (!col || col.length > 2) continue;
      const offset = [...col].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0) - 1;
      if (offset > 31) continue;
      const type = cell.getAttribute("t");
      const value = elements(cell, "v")[0]?.textContent ?? "";
      if (elements(cell, "f").length || type === "e") values[offset] = null;
      else if (type === "inlineStr") values[offset] = elements(cell, "t").map(node => node.textContent).join("");
      else if (type === "s") values[offset] = strings[Number(value)] ?? "";
      else values[offset] = value;
    }
    return values;
  });
}

async function readRosterFile(file) {
  if (!file || file.size > ROSTER_MAX_FILE_BYTES) rosterFileError("Chọn tệp XLSX hoặc CSV tối đa 2 MB.");
  if (/\.csv$/i.test(file.name)) return rosterCsvRows(new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()));
  if (/\.xlsx$/i.test(file.name)) return rosterXlsxRows(new Uint8Array(await file.arrayBuffer()));
  rosterFileError("Chỉ hỗ trợ tệp XLSX hoặc CSV.");
}

function rosterImportPreview(rows, existingCodes) {
  const cleanHeader = value => String(value || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/đ/g, "d").trim();
  const headings = (rows[0] || []).map(cleanHeader);
  const positions = ["ma hoc sinh", "ho va ten", "lop"].map(name => headings.indexOf(name));
  if (positions.some(index => index < 0)) rosterFileError("Dòng đầu cần các cột Mã học sinh, Họ và tên, Lớp.");
  const result = rows.slice(1).map((row, index) => {
    const [rawCode, rawName, rawClass] = positions.map(column => row[column]);
    if ([rawCode, rawName, rawClass].every(value => value !== null && !String(value ?? "").trim())) return null;
    const code = String(rawCode ?? "").normalize("NFKC").trim().toUpperCase();
    const name = String(rawName ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
    const className = String(rawClass ?? "").normalize("NFKC").trim().replace(/\s+/g, "").toUpperCase();
    const error = [rawCode, rawName, rawClass].some(value => value === null) ? "Không dùng công thức trong cột bắt buộc." :
      !/^[A-Z0-9][A-Z0-9._-]{3,19}$/.test(code) ? "Mã học sinh không hợp lệ." :
      !name || name.length > 80 ? "Họ tên không hợp lệ." :
      !/^(?:10|11|12)[A-Z0-9][A-Z0-9._-]{0,15}$/.test(className) ? "Lớp không hợp lệ." : "";
    return { sourceRow: row.sourceRow || index + 2, profile: { code, name, className }, error, duplicate: existingCodes.has(code) };
  }).filter(Boolean);
  const counts = new Map();
  result.forEach(item => { if (item.profile.code) counts.set(item.profile.code, (counts.get(item.profile.code) || 0) + 1); });
  result.forEach(item => { if (counts.get(item.profile.code) > 1) { item.duplicate = true; item.error = "Mã trùng trong tệp."; } });
  return result;
}
