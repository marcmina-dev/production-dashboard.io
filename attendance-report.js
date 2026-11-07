export const ATTENDANCE_REPORT_STATUSES = Object.freeze([
  'Present',
  'Absent',
  'Rest Day',
  'Vacation Leave',
  'Sick Leave'
]);

export function buildMonthlyAttendanceRows(workers, records, month) {
  const workerRows = (Array.isArray(workers) ? workers : []).map(worker => ({
    personName: String(worker?.name || ''),
    presentDays: 0,
    absentDays: 0,
    restDays: 0,
    vacationLeaveDays: 0,
    sickLeaveDays: 0,
    totalMarkedDays: 0,
    dutyDays: 0
  }));
  const rowsByName = new Map(workerRows.map(row => [row.personName, row]));
  const seenPersonDays = new Set();
  const countByStatus = {
    Present: 'presentDays',
    Absent: 'absentDays',
    'Rest Day': 'restDays',
    'Vacation Leave': 'vacationLeaveDays',
    'Sick Leave': 'sickLeaveDays'
  };

  for (const record of Array.isArray(records) ? records : []) {
    const personName = String(record?.workerName || '');
    const date = String(record?.date || '');
    const status = record?.attendance;
    if (!date.startsWith(`${month}-`) || !ATTENDANCE_REPORT_STATUSES.includes(status)) continue;
    const row = rowsByName.get(personName);
    if (!row) continue;

    const personDayKey = JSON.stringify([personName, date]);
    if (seenPersonDays.has(personDayKey)) continue;
    seenPersonDays.add(personDayKey);
    row[countByStatus[status]] += 1;
  }

  for (const row of workerRows) {
    row.dutyDays = row.presentDays;
    row.totalMarkedDays = row.presentDays + row.absentDays + row.restDays + row.vacationLeaveDays + row.sickLeaveDays;
  }
  return workerRows;
}

function protectSpreadsheetFormula(value) {
  const text = String(value ?? '');
  return /^[\s]*[=+@\-]/.test(text) ? `'${text}` : text;
}

function csvCell(value) {
  return `"${protectSpreadsheetFormula(value).replace(/"/g, '""')}"`;
}

export function monthlyAttendanceRowsToCsv(rows) {
  const header = [
    'Repair Team Member',
    'Present / Duty Days',
    'Absent',
    'Rest Day',
    'Vacation Leave',
    'Sick Leave',
    'Total Marked Days'
  ];
  const values = (Array.isArray(rows) ? rows : []).map(row => [
    row.personName,
    row.presentDays,
    row.absentDays,
    row.restDays,
    row.vacationLeaveDays,
    row.sickLeaveDays,
    row.totalMarkedDays
  ]);
  return `\uFEFF${[header, ...values].map(line => line.map(csvCell).join(',')).join('\r\n')}`;
}

export function productionRecordsToCsv(records) {
  const header = ['Date', 'Worker Name', 'Attendance', 'Installs', 'Restored', 'Total Units', 'Notes'];
  const rows = (Array.isArray(records) ? records : []).map(record => [
    record?.date,
    record?.workerName,
    record?.attendance,
    record?.installs || 0,
    record?.restored || 0,
    record?.totalUnits || ((record?.installs || 0) + (record?.restored || 0)),
    record?.notes || ''
  ]);
  return `\uFEFF${[header, ...rows].map(line => line.map(csvCell).join(',')).join('\r\n')}`;
}

if (typeof window !== 'undefined') {
  window.buildMonthlyAttendanceRows = buildMonthlyAttendanceRows;
  window.monthlyAttendanceRowsToCsv = monthlyAttendanceRowsToCsv;
  window.productionRecordsToCsv = productionRecordsToCsv;
}
