import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMonthlyAttendanceRows, monthlyAttendanceRowsToCsv, productionRecordsToCsv } from '../attendance-report.js';

test('monthly report counts one status per repair person-day and excludes installation staff', () => {
  const workers = [
    { id: 'repair-1', name: 'Avery Cruz' },
    { id: 'repair-2', name: 'Lee Santos' }
  ];
  const records = [
    { id: 'r1', date: '2026-10-01', workerName: 'Avery Cruz', attendance: 'Present', installs: 2 },
    { id: 'r2', date: '2026-10-01', workerName: 'Avery Cruz', attendance: 'Absent' },
    { id: 'r3', date: '2026-10-02', workerName: 'Avery Cruz', attendance: 'Sick Leave' },
    { id: 'r4', date: '2026-10-03', workerName: 'Avery Cruz', attendance: 'Vacation Leave' },
    { id: 'r5', date: '2026-10-01', workerName: 'Lee Santos', attendance: 'Rest Day' },
    { id: 'r6', date: '2026-10-02', workerName: 'Lee Santos', attendance: 'Absent' },
    { id: 'r7', date: '2026-10-01', workerName: 'Installation Member', attendance: 'Present' },
    { id: 'r8', date: '2026-09-30', workerName: 'Avery Cruz', attendance: 'Present' }
  ];

  const rows = buildMonthlyAttendanceRows(workers, records, '2026-10');
  assert.deepEqual(rows, [
    {
      personName: 'Avery Cruz',
      presentDays: 1,
      absentDays: 0,
      restDays: 0,
      vacationLeaveDays: 1,
      sickLeaveDays: 1,
      totalMarkedDays: 3,
      dutyDays: 1
    },
    {
      personName: 'Lee Santos',
      presentDays: 0,
      absentDays: 1,
      restDays: 1,
      vacationLeaveDays: 0,
      sickLeaveDays: 0,
      totalMarkedDays: 2,
      dutyDays: 0
    }
  ]);
});

test('monthly CSV quotes cells, includes month totals, and guards spreadsheet formulas', () => {
  const csv = monthlyAttendanceRowsToCsv([
    {
      personName: '=HYPERLINK("https://bad.example")',
      presentDays: 2,
      absentDays: 1,
      restDays: 0,
      vacationLeaveDays: 1,
      sickLeaveDays: 0,
      totalMarkedDays: 4
    }
  ]);

  assert.ok(csv.startsWith('\uFEFF"Repair Team Member"'));
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/bad\.example""\)"/);
  assert.match(csv, /"2","1","0","1","0","4"/);
});

test('Production Logs CSV protects every exported field against spreadsheet formulas', () => {
  const csv = productionRecordsToCsv([{
    date: '=2026-11-01',
    workerName: '@SUM(A1:A2)',
    attendance: '+cmd|x',
    installs: -3,
    restored: '=4',
    totalUnits: '+5',
    notes: '-formula, "quoted"\nnext line'
  }]);

  assert.ok(csv.startsWith('\uFEFF"Date","Worker Name"'));
  assert.match(csv, /"'=2026-11-01"/);
  assert.match(csv, /"'@SUM\(A1:A2\)"/);
  assert.match(csv, /"'\+cmd\|x"/);
  assert.match(csv, /"'-3","'=4","'\+5"/);
  assert.match(csv, /"'-formula, ""quoted""\nnext line"/);
});
