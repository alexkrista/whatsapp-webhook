'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  splitPlanAroundDate,
  createKrisplanAbsenceService,
} = require('../lib/krisplan-absence-reconcile');

function nominalMinutesForDate({ date }) {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day === 0 || day === 6 ? 0 : 468;
}

function makeMemoryService({ plans = [], entries = [] } = {}) {
  const state = {
    plans: plans.map((item) => ({ ...item })),
    entries: entries.map((item) => ({ ...item })),
    nextEntry: 100,
    nextPlan: 100,
    deletions: [],
    replacements: [],
  };

  const service = createKrisplanAbsenceService({
    logger: { info() {} },
    async listPlanAbsences({ employeeId, from, to }) {
      return state.plans.filter((plan) => {
        const start = plan.startDate;
        const end = plan.endDate;
        return plan.employeeId === employeeId && start <= to && end >= from;
      });
    },
    async listGeneratedEntries({ employeeId, from, to }) {
      return state.entries.filter((entry) => (
        entry.employeeId === employeeId
        && entry.date >= from
        && entry.date <= to
      ));
    },
    async getNominalWorkMinutes(input) {
      return nominalMinutesForDate(input);
    },
    async upsertGeneratedEntry(input) {
      if (input.id) {
        const index = state.entries.findIndex((entry) => entry.id === input.id);
        assert.notEqual(index, -1);
        state.entries[index] = { ...state.entries[index], ...input };
        return state.entries[index];
      }

      const duplicate = state.entries.find((entry) => (
        entry.employeeId === input.employeeId
        && entry.date === input.date
        && entry.sourceId === input.sourceId
        && entry.source === input.source
      ));
      if (duplicate) {
        Object.assign(duplicate, input);
        return duplicate;
      }

      const created = { ...input, id: `entry-${state.nextEntry++}` };
      state.entries.push(created);
      return created;
    },
    async deleteGeneratedEntry(input) {
      state.deletions.push({ ...input });
      state.entries = state.entries.filter((entry) => entry.id !== input.id);
    },
    async deleteEntry(input) {
      state.deletions.push({ ...input });
      state.entries = state.entries.filter((entry) => entry.id !== input.id);
    },
    async getGeneratedEntryById({ id }) {
      return state.entries.find((entry) => entry.id === id) || null;
    },
    async getPlanAbsenceById({ id }) {
      return state.plans.find((plan) => plan.id === id) || null;
    },
    async replacePlanAbsence({ id, replacements, reason }) {
      state.replacements.push({ id, replacements, reason });
      state.plans = state.plans.filter((plan) => plan.id !== id);
      for (const replacement of replacements) {
        state.plans.push({
          ...replacement,
          id: replacement.id || `plan-${state.nextPlan++}`,
        });
      }
    },
  });

  return { service, state };
}

test('splits a plan range when one middle day is deleted', () => {
  const plan = {
    id: 'plan-1',
    employeeId: 'clemens',
    startDate: '2026-08-17',
    endDate: '2026-08-21',
    type: 'URLAUB',
  };

  const replacements = splitPlanAroundDate(plan, '2026-08-19');
  assert.equal(replacements.length, 2);
  assert.deepEqual(
    replacements.map(({ startDate, endDate }) => ({ startDate, endDate })),
    [
      { startDate: '2026-08-17', endDate: '2026-08-18' },
      { startDate: '2026-08-20', endDate: '2026-08-21' },
    ],
  );
  assert.equal(replacements[1].id, undefined);
});

test('does not generate Urlaub on Saturday/Sunday and purges stale weekend rows', async () => {
  const { service, state } = makeMemoryService({
    plans: [{
      id: 'plan-urlaub',
      employeeId: 'clemens',
      startDate: '2026-08-14',
      endDate: '2026-08-17',
      type: 'URLAUB',
    }],
    entries: [
      {
        id: 'stale-sat',
        employeeId: 'clemens',
        date: '2026-08-15',
        type: 'URLAUB',
        source: 'KRISPLAN',
        sourceId: 'plan-urlaub',
      },
      {
        id: 'stale-sun',
        employeeId: 'clemens',
        date: '2026-08-16',
        type: 'URLAUB',
        source: 'KRISPLAN',
        sourceId: 'plan-urlaub',
      },
    ],
  });

  const result = await service.reconcile({
    employeeId: 'clemens',
    from: '2026-08-14',
    to: '2026-08-17',
  });

  const dates = state.entries.map((entry) => entry.date).sort();
  assert.deepEqual(dates, ['2026-08-14', '2026-08-17']);
  assert.equal(result.expected, 2);
  assert.equal(result.removed, 2);
  assert.deepEqual(
    state.deletions.map((item) => item.reason),
    [
      'KRISPLAN_SOURCE_REMOVED_OR_NON_WORKING_DAY',
      'KRISPLAN_SOURCE_REMOVED_OR_NON_WORKING_DAY',
    ],
  );
});

test('deleting the KRISPLAN source removes the generated row on reconciliation', async () => {
  const { service, state } = makeMemoryService({
    plans: [],
    entries: [{
      id: 'orphan',
      employeeId: 'clemens',
      date: '2026-08-18',
      type: 'URLAUB',
      source: 'KRISPLAN',
      sourceId: 'deleted-plan',
    }],
  });

  const result = await service.reconcile({
    employeeId: 'clemens',
    from: '2026-08-18',
    to: '2026-08-18',
  });

  assert.equal(result.removed, 1);
  assert.equal(state.entries.length, 0);
});

test('manual rows are not touched by KRISPLAN reconciliation', async () => {
  const { service, state } = makeMemoryService({
    plans: [],
    entries: [{
      id: 'manual-1',
      employeeId: 'clemens',
      date: '2026-08-18',
      type: 'URLAUB',
      source: 'MANUAL',
      sourceId: '',
    }],
  });

  const result = await service.reconcile({
    employeeId: 'clemens',
    from: '2026-08-18',
    to: '2026-08-18',
  });

  assert.equal(result.removed, 0);
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].id, 'manual-1');
});

test('deleting a KRISPLAN row in Tagesabschluss changes the source range', async () => {
  const { service, state } = makeMemoryService({
    plans: [{
      id: 'plan-1',
      employeeId: 'clemens',
      startDate: '2026-08-17',
      endDate: '2026-08-21',
      type: 'URLAUB',
    }],
    entries: [{
      id: 'entry-wed',
      employeeId: 'clemens',
      date: '2026-08-19',
      type: 'URLAUB',
      source: 'KRISPLAN',
      sourceId: 'plan-1',
    }],
  });

  const result = await service.deleteFromDayClose({ entryId: 'entry-wed' });

  assert.equal(result.deleted, true);
  assert.equal(result.sourceChanged, true);
  assert.equal(state.replacements.length, 1);
  assert.deepEqual(
    state.plans
      .map(({ startDate, endDate }) => ({ startDate, endDate }))
      .sort((a, b) => a.startDate.localeCompare(b.startDate)),
    [
      { startDate: '2026-08-17', endDate: '2026-08-18' },
      { startDate: '2026-08-20', endDate: '2026-08-21' },
    ],
  );
  assert.equal(state.entries.some((entry) => entry.date === '2026-08-19'), false);
});

test('reconcileAfterPlanMutation covers both the old and new range', async () => {
  const calls = [];
  const service = createKrisplanAbsenceService({
    logger: { info() {} },
    async listPlanAbsences(input) {
      calls.push(['plans', input]);
      return [];
    },
    async listGeneratedEntries(input) {
      calls.push(['entries', input]);
      return [];
    },
    async getNominalWorkMinutes() { return 468; },
    async upsertGeneratedEntry() {},
    async deleteGeneratedEntry() {},
  });

  await service.reconcileAfterPlanMutation({
    employeeId: 'clemens',
    oldPlan: {
      id: 'plan-1',
      employeeId: 'clemens',
      startDate: '2026-08-10',
      endDate: '2026-08-20',
    },
    newPlan: {
      id: 'plan-1',
      employeeId: 'clemens',
      startDate: '2026-08-12',
      endDate: '2026-08-18',
    },
  });

  assert.equal(calls[0][1].from, '2026-08-10');
  assert.equal(calls[0][1].to, '2026-08-20');
});
