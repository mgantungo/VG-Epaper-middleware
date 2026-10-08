/**
 * apps/middleware/src/services/memberSheet.js            NEW FILE (Phase 3)
 *
 * Reads an Org Admin's member upload (.xlsx or .csv) into plain rows, and
 * builds the downloadable template. Only parsing happens here. Whether a row
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

export async function buildTemplate() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'New Vision E-Paper';
  const ws = wb.addWorksheet('Members');
  ws.columns = [
    { header: 'Email', key: 'email', width: 34 },
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Phone', key: 'phone', width: 18 },
    { header: 'Start date', key: 'start', width: 14, style: { numFmt: 'yyyy-mm-dd' } },
    { header: 'End date', key: 'end', width: 14, style: { numFmt: 'yyyy-mm-dd' } },
    { header: 'Months', key: 'months', width: 10 }
  ];
  ws.getRow(1).font = { bold: true };
  ws.addRow({ email: 'jane.doe@example.org', name: 'Jane Doe', phone: '0772000000', start: null, end: null, months: 12 });
  ws.addRow({ email: 'john.okello@example.org', name: 'John Okello', phone: '', start: new Date(Date.UTC(2026, 9, 1)), end: new Date(Date.UTC(2027, 2, 31)), months: null });
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const notes = wb.addWorksheet('How to fill this in');
  notes.getColumn(1).width = 110;
  [
    'One member per row. Only the Email column is required. Delete the two example rows before uploading.',
    'Name and Phone are used when a new account is created for someone who doesn\'t have one yet; they get an email to set their password.',
    'People who are already members get their access extended. Nobody is ever duplicated.',
    'Access period, per row (all optional):',
    '  - Start date + End date: exactly that period.',
    '  - Months (with or without a Start date): that many months from the start.',
    '  - Nothing: uses the default period you choose on the upload screen.',
    'Start date defaults to today. Access can only fall within your organisation\'s paid period; longer periods are shortened to fit.',
    'Dates: use real Excel dates, or type them as 2026-10-01 or 01/10/2026 (day first).'
  ].forEach((line) => notes.addRow([line]));

  return Buffer.from(await wb.xlsx.writeBuffer());
}
