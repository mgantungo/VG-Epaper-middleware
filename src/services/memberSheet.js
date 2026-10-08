/**
 * apps/middleware/src/services/memberSheet.js            NEW FILE (Phase 3)
 *
 * Reads an Org Admin's member upload (.xlsx or .csv) into plain rows, and
 * builds the downloadable members spreadsheet (UPDATED: pre-filled with
 * current members when there are any; guided headers, notes and input
 * checks either way). Only parsing happens here. Whether a row
 * is valid, new, an extension, or over the seat limit is decided in the CMS
 * (org-members.js planRows), so the rules live in one place.
 *
 * Columns are matched by header name, case-insensitively, in any order:
 *   email (required) · name · phone · start date · end date · months
 * Dates can be real Excel dates, YYYY-MM-DD, or day-first D/M/YYYY
 * (Ugandan convention). Anything unparseable is passed through as typed so
 * the preview can show the row's error instead of silently dropping it.
 *
 * Requires: npm i exceljs   (pure JS, no native build)
 */
import ExcelJS from 'exceljs';

export const MAX_ROWS = 5000;

const HEADER_ALIASES = {
  email: ['email', 'e-mail', 'email address', 'e-mail address', 'mail'],
  displayName: ['name', 'full name', 'display name', 'displayname', 'fullname', 'member', 'member name', 'staff name'],
  phone: ['phone', 'phone number', 'mobile', 'mobile number', 'telephone', 'tel', 'msisdn'],
  coverageStart: ['start', 'start date', 'from', 'coveragestart', 'access from', 'valid from'],
  coverageEnd: ['end', 'end date', 'to', 'until', 'coverageend', 'access until', 'valid until', 'expiry', 'expiry date', 'expires'],
  months: ['months', 'duration', 'duration months', 'period months', 'no of months']
};

const normHeader = (h) => String(h ?? '').toLowerCase().replace(/[()]/g, ' ').replace(/[^a-z0-9@\- ]+/g, ' ').replace(/\s+/g, ' ').trim();

function mapHeaders(headerCells) {
  const map = {};
  headerCells.forEach((raw, idx) => {
    const h = normHeader(raw);
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (map[field] === undefined && aliases.includes(h)) map[field] = idx;
    }
  });
  return map;
}

export class SheetError extends Error {}

// ---- value helpers -----------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
const isoFromUtcDate = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** Excel serial day number (1900 system) -> YYYY-MM-DD. */
function isoFromSerial(n) {
  const ms = Date.UTC(1899, 11, 30) + Math.round(n) * 86400000;
  return isoFromUtcDate(new Date(ms));
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function validYmd(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}

/** Best-effort date normaliser. Returns YYYY-MM-DD, or the original text if unparseable, or null if empty. */
export function normaliseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : isoFromUtcDate(v);
  if (typeof v === 'number') return v > 20000 && v < 80000 ? isoFromSerial(v) : String(v);
  const s = String(v).trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) return validYmd(+m[1], +m[2], +m[3]) || s;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s); // day first: 05/10/2026 = 5 Oct 2026
  if (m) return validYmd(+m[3], +m[2], +m[1]) || s;
  m = /^(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s,-]+(\d{4})$/.exec(s); // 5 Oct 2026, 5-October-2026
  if (m && MONTHS[m[2].slice(0, 4).toLowerCase()] !== undefined) return validYmd(+m[3], MONTHS[m[2].slice(0, 4).toLowerCase()], +m[1]) || s;
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()] !== undefined) return validYmd(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]) || s;
  if (/^\d+(\.\d+)?$/.test(s)) return normaliseDate(Number(s));
  return s;
}

/** ExcelJS cell value -> plain text (handles rich text, hyperlinks, formulas). */
function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return isoFromUtcDate(v);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((p) => p.text).join('');
    if (v.text !== undefined) return cellText(v.text);
    if (v.result !== undefined) return cellText(v.result);
    if (v.hyperlink) return String(v.hyperlink).replace(/^mailto:/i, '');
    return '';
  }
  return String(v);
}
function cellRaw(v) {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if (v.result !== undefined) return v.result;
    return cellText(v);
  }
  return v;
}

function buildRows(records, map) {
  if (map.email === undefined) {
    throw new SheetError('No "Email" column found. Download the template to see the expected columns.');
  }
  const rows = [];
  for (const { rowNumber, cells } of records) {
    const get = (f) => (map[f] === undefined ? null : cells[map[f]]);
    const email = cellText(get('email')).trim();
    const displayName = cellText(get('displayName')).trim();
    const phone = cellText(get('phone')).trim();
    const start = normaliseDate(cellRaw(get('coverageStart')));
    const end = normaliseDate(cellRaw(get('coverageEnd')));
    const monthsRaw = cellText(get('months')).trim();
    if (!email && !displayName && !phone && !start && !end && !monthsRaw) continue; // blank line
    rows.push({
      row: rowNumber,
      email,
      displayName,
      phone,
      coverageStart: start,
      coverageEnd: end,
      months: monthsRaw === '' ? null : (Number.isFinite(Number(monthsRaw)) ? Number(monthsRaw) : monthsRaw)
    });
    if (rows.length > MAX_ROWS) throw new SheetError(`The file has more than ${MAX_ROWS} rows. Split it into smaller files.`);
  }
  if (!rows.length) throw new SheetError('The file has a header row but no members under it.');
  return rows;
}

// ---- xlsx ----------------------------------------------------------------------

async function parseXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw new SheetError('This file could not be read as an Excel workbook. Save it as .xlsx or .csv and try again.');
  }
  const ws = wb.worksheets.find((w) => w.state !== 'hidden' && w.actualRowCount > 0);
  if (!ws) throw new SheetError('The workbook is empty.');

  // The header is the first of the top 10 rows that has an email column.
  let headerRowNumber = null;
  let map = null;
  for (let r = 1; r <= Math.min(10, ws.rowCount); r++) {
    const row = ws.getRow(r);
    const cells = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => { cells[col - 1] = cellText(cell.value); });
    const candidate = mapHeaders(cells);
    if (candidate.email !== undefined) { headerRowNumber = r; map = candidate; break; }
  }
  if (!map) throw new SheetError('No "Email" column found in the first sheet. Download the template to see the expected columns.');

  const records = [];
  for (let r = headerRowNumber + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const cells = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => { cells[col - 1] = cell.value; });
    records.push({ rowNumber: r, cells });
  }
  return buildRows(records, map);
}

// ---- csv -----------------------------------------------------------------------

function parseCsvText(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delim = [',', ';', '\t'].reduce((best, d) => (firstLine.split(d).length > firstLine.split(best).length ? d : best), ',');
  const out = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); out.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); out.push(row); }
  return out;
}

function parseCsv(buffer) {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  const table = parseCsvText(text);
  const headerIdx = table.slice(0, 10).findIndex((r) => mapHeaders(r).email !== undefined);
  if (headerIdx < 0) throw new SheetError('No "Email" column found. Download the template to see the expected columns.');
  const map = mapHeaders(table[headerIdx]);
  const records = table.slice(headerIdx + 1).map((cells, i) => ({ rowNumber: headerIdx + 2 + i, cells }));
  return buildRows(records, map);
}

// ---- entry points ----------------------------------------------------------------

export async function parseMemberSheet(buffer, filename = '') {
  const name = filename.toLowerCase();
  if (name.endsWith('.xls')) throw new SheetError('Old .xls files are not supported. Open it in Excel and save as .xlsx, or export as .csv.');
  if (name.endsWith('.csv') || name.endsWith('.txt')) return parseCsv(buffer);
  // .xlsx is a zip archive, which starts with "PK".
  if (buffer.length > 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) return parseXlsx(buffer);
  if (name.endsWith('.xlsx')) throw new SheetError('This file is not a valid .xlsx workbook.');
  return parseCsv(buffer);
}

const DATA_START_ROW = 4;            // row 1 title, row 2 instructions, row 3 headers
const LAST_DATA_ROW = DATA_START_ROW + MAX_ROWS - 1;

const COLUMNS = [
  { key: 'email', header: 'Email', width: 34, note: 'Required. The person\'s email address: their sign-in for the e-paper. One person per row; each email only once.' },
  { key: 'name', header: 'Name', width: 28, note: 'Optional. Their full name. Used when a new account is created for them.' },
  { key: 'phone', header: 'Phone', width: 18, note: 'Optional. e.g. 0772123456. This column is text, so the leading 0 is kept.' },
  { key: 'start', header: 'Start date', width: 14, note: 'Optional. First day of access. Empty = today. Use a real date, or type 2026-10-01 or 01/10/2026 (day first).' },
  { key: 'end', header: 'End date', width: 14, note: 'Optional. Last day of access. Leave empty and use Months instead if you prefer. Never later than your paid period.' },
  { key: 'months', header: 'Months', width: 10, note: 'Optional. Number of months of access (1–60), counted from the Start date. Use either End date or Months.' }
];
const INFO_COLUMNS = [
  { key: 'role', header: 'Current role', width: 14 },
  { key: 'status', header: 'Current status', width: 15 },
  { key: 'accessEnds', header: 'Current access ends', width: 20 },
  { key: 'inviteAccepted', header: 'Invite accepted', width: 15 }
];
const INFO_NOTE = 'For reference only. This column is ignored when you upload the file.';

/**
 * The members spreadsheet that both Org Admins (web) and handle admins
 * download, fill in, and upload again.
 *
 *   data = { organisation: { name }, paidUntil, members: [{ email, displayName, phone, role, status, accessEnds, inviteAccepted }] }
 *
 * - No members yet: a ready-to-fill sheet. Title + one-line instruction, bold
 *   frozen headers with a note on every header cell, input checks, and a
 *   "How to fill this in" tab. Deliberately NO example rows, so nothing fake
 *   can be uploaded by mistake.
 * - Members exist: the same sheet, pre-filled with them, plus grey
 *   "Current …" reference columns that the upload ignores. Their date
 *   columns are left empty, and an existing member's row only changes when
 *   dates or months are filled in, so uploading the file unedited changes
 *   nothing.
 *
 * Input checks (Excel data validation) on rows 4..5003: email must contain
 * "@" and appear once; dates must be real dates; months a whole number
 * 1–60. Phone is a text column so leading zeros survive.
 */
export async function buildTemplate(data = {}) {
  const orgName = data.organisation?.name || 'Your organisation';
  const members = Array.isArray(data.members) ? data.members : [];
  const hasMembers = members.length > 0;
  const cols = hasMembers ? [...COLUMNS, ...INFO_COLUMNS] : COLUMNS;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'New Vision E-Paper';
  wb.created = new Date();
  const ws = wb.addWorksheet('Members', { views: [{ state: 'frozen', ySplit: 3 }] });
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });
  ws.getColumn(3).numFmt = '@';            // phone as text
  ws.getColumn(4).numFmt = 'yyyy-mm-dd';
  ws.getColumn(5).numFmt = 'yyyy-mm-dd';

  // Row 1: title. Row 2: the one instruction that matters most.
  ws.getCell('A1').value = `${orgName} — e-paper members`;
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A2').value = (hasMembers
    ? 'Add new people on empty rows below. To change someone\'s access, fill in their Start date / End date or Months; rows left without dates are not changed.'
    : 'Fill in one person per row, starting on row 4. Only Email is required. Hover over a heading for help, or see the "How to fill this in" tab.')
    + (data.paidUntil ? ` Your paid period runs until ${data.paidUntil}.` : '');
  ws.getCell('A2').font = { italic: true, color: { argb: 'FF555555' } };
  ws.mergeCells(1, 1, 1, cols.length);
  ws.mergeCells(2, 1, 2, cols.length);
  ws.getRow(2).height = 48; // merged cells don't auto-grow for wrapped text
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  ws.getCell('A2').alignment = { wrapText: true, vertical: 'top' };

  // Row 3: headers with notes.
  const header = ws.getRow(3);
  cols.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    const info = i >= COLUMNS.length;
    cell.value = c.key === 'email' ? 'Email' : c.header;
    cell.font = { bold: true, color: { argb: info ? 'FF666666' : 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: info ? 'FFE5E5E5' : 'FF1A1A1A' } };
    cell.alignment = { vertical: 'middle' };
    cell.note = info ? INFO_NOTE : c.note;
  });
  header.height = 22;

  // Pre-filled members (dates deliberately empty: see above).
  members.forEach((m, idx) => {
    const r = ws.getRow(DATA_START_ROW + idx);
    r.getCell(1).value = m.email || '';
    r.getCell(2).value = m.displayName || '';
    r.getCell(3).value = m.phone ? String(m.phone) : '';
    if (hasMembers) {
      r.getCell(7).value = m.role || '';
      r.getCell(8).value = m.status || '';
      r.getCell(9).value = m.accessEnds || 'none';
      r.getCell(10).value = m.inviteAccepted ? 'yes' : 'not yet';
      for (let c = 7; c <= 10; c++) r.getCell(c).font = { color: { argb: 'FF777777' } };
    }
  });

  // Input checks.
  const range = (col) => `${col}${DATA_START_ROW}:${col}${LAST_DATA_ROW}`;
  ws.dataValidations.add(range('A'), {
    type: 'custom', allowBlank: true,
    formulae: [`AND(ISNUMBER(SEARCH("@",A${DATA_START_ROW})),COUNTIF($A$${DATA_START_ROW}:$A$${LAST_DATA_ROW},A${DATA_START_ROW})=1)`],
    showErrorMessage: true, errorStyle: 'stop', errorTitle: 'Check the email',
    error: 'Enter a valid email address. Each email can appear only once in the sheet.'
  });
  for (const col of ['D', 'E']) {
    ws.dataValidations.add(range(col), {
      type: 'date', operator: 'between', allowBlank: true,
      formulae: [new Date(Date.UTC(2020, 0, 1)), new Date(Date.UTC(2100, 11, 31))],
      showErrorMessage: true, errorStyle: 'stop', errorTitle: 'Check the date',
      error: 'Enter a date, for example 2026-10-01 or 01/10/2026.'
    });
  }
  ws.dataValidations.add(range('F'), {
    type: 'whole', operator: 'between', allowBlank: true, formulae: [1, 60],
    showErrorMessage: true, errorStyle: 'stop', errorTitle: 'Check the months',
    error: 'Enter a whole number of months from 1 to 60.'
  });

  // Help tab.
  const help = wb.addWorksheet('How to fill this in');
  help.getColumn(1).width = 100;
  help.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  [
    [`${orgName}: e-paper members`, { bold: true, size: 14 }],
    [''],
    ['1. One person per row on the "Members" tab, from row 4. Don\'t change the headings in row 3.'],
    ['2. Email is the only required column. It becomes the person\'s sign-in.'],
    ['3. Name and Phone are used when an account is created for someone who doesn\'t have one yet. They get an email to set their password.'],
    ['4. Access period for each row (all optional):'],
    ['     • Start date + End date: exactly that period.'],
    ['     • Months (with or without a Start date): that many months from the start. Start defaults to today.'],
    ['     • Nothing: new people get the default period you choose on the upload screen; existing members are left as they are.'],
    ['5. Access can only fall within your organisation\'s paid period. Longer periods are shortened to fit, and the upload screen tells you.'],
    ['6. People already in the organisation are never duplicated: their access is extended when you give dates or months.'],
    ['7. Grey "Current …" columns (when present) show what is on record today. They are ignored on upload.'],
    ['8. Save as .xlsx (or .csv) and upload. You see a preview of every row before anything changes.'],
    [''],
    [data.paidUntil ? `Paid period: until ${data.paidUntil}.` : 'Paid period: contact New Vision if none is shown on your dashboard.', { italic: true }]
  ].forEach(([text, font]) => {
    const row = help.addRow([text]);
    if (font) row.getCell(1).font = font;
    row.getCell(1).alignment = { wrapText: true };
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Filename like ministry-of-works-members-2026-10-08.xlsx */
export function templateFilename(orgName) {
  const slug = String(orgName || 'organisation').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'organisation';
  return `${slug}-members-${new Date().toISOString().slice(0, 10)}.xlsx`;
}