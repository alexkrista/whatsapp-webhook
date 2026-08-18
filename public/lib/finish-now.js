'use strict';

/**
 * KRISTINE hotfix: KRISPLAN is the source of truth for generated absences.
 *
 * Rules:
 *   1. A generated absence exists only while the matching KRISPLAN entry exists.
 *   2. Deleted or shortened KRISPLAN absences purge obsolete generated rows.
 *   3. Non-working days (normally Saturday/Sunday) get no generated Urlaub,
 *      unless the plan explicitly sets includeNonWorkingDays=true.
 *   4. Manual rows are never deleted by reconciliation.
 *   5. Deleting a KRISPLAN-generated row in Tagesabschluss removes exactly that
 *      date from the underlying KRISPLAN range, then reconciles all mirrors.
 */

const KRISPLAN_SOURCE = 'KRISPLAN';
const DEFAULT_ABSENCE_STATUS = 'PLANNED_ABSENCE';

function requiredFunction(name, value) {
  if (typeof value !== 'function') {
    throw new TypeError(`krisplan-absence-reconcile: dependency ${name} must be a function`);
  }
  return value;
}

function optionalFunction(value, fallback = null) {
  return typeof value === 'function' ? value : fallback;
}

function assertIsoDate(value, label = 'date') {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new TypeError(`${label} must be YYYY-MM-DD`);
  }

  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new TypeError(`${label} is invalid`);
  }
  return text;
}

function addIsoDays(isoDate, amount) {
  const date = new Date(`${assertIsoDate(isoDate)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function eachIsoDate(from, to) {
  const start = assertIsoDate(from, 'from');
  const end = assertIsoDate(to, 'to');
  if (start > end) throw new RangeError('from must not be after to');

  const dates = [];
  for (let cursor = start; cursor <= end; cursor = addIsoDays(cursor, 1)) {
    dates.push(cursor);
  }
  return dates;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function planId(plan) {
  return String(firstDefined(plan.id, plan.absenceId, plan.sourceId, plan.uid, '')).trim();
}

function planEmployeeId(plan) {
  return String(
    firstDefined(plan.employeeId, plan.staffId, plan.workerId, plan.personId, ''),
  ).trim();
}

function planStartDate(plan) {
  return assertIsoDate(
    firstDefined(plan.startDate, plan.dateFrom, plan.from, plan.start, plan.date),
    'plan start date',
  );
}

function planEndDate(plan) {
  return assertIsoDate(
    firstDefined(plan.endDate, plan.dateTo, plan.to, plan.end, plan.date, planStartDate(plan)),
    'plan end date',
  );
}

function planType(plan) {
  return String(
    firstDefined(plan.type, plan.kind, plan.absenceType, plan.category, 'URLAUB'),
  ).trim();
}

function entrySource(entry) {
  return String(firstDefined(entry.source, entry.origin, entry.generatedBy, '')).toUpperCase();
}

function entrySourceId(entry) {
  return String(firstDefined(entry.sourceId, entry.planId, entry.absenceId, '')).trim();
}

function entryEmployeeId(entry) {
  return String(firstDefined(entry.employeeId, entry.staffId, entry.workerId, '')).trim();
}

function entryDate(entry) {
  return assertIsoDate(firstDefined(entry.date, entry.workDate, entry.day), 'entry date');
}

function sourceKey({ employeeId, date, sourceId }) {
  return `${String(employeeId)}|${assertIsoDate(date)}|${String(sourceId)}`;
}

function overlapsRange(startDate, endDate, from, to) {
  return startDate <= to && endDate >= from;
}

function clampRange(startDate, endDate, from, to) {
  return {
    start: startDate < from ? from : startDate,
    end: endDate > to ? to : endDate,
  };
}

/**
 * Return canonical replacement ranges when one date is removed from an absence.
 * The persistence adapter replaces the original atomically with these records.
 */
function splitPlanAroundDate(plan, dateToRemove) {
  const date = assertIsoDate(dateToRemove, 'dateToRemove');
  const startDate = planStartDate(plan);
  const endDate = planEndDate(plan);

  if (date < startDate || date > endDate) return [{ ...plan }];
  if (startDate === endDate) return [];

  if (date === startDate) {
    return [{ ...plan, startDate: addIsoDays(startDate, 1), endDate }];
  }

  if (date === endDate) {
    return [{ ...plan, startDate, endDate: addIsoDays(endDate, -1) }];
  }

  const left = {
    ...plan,
    startDate,
    endDate: addIsoDays(date, -1),
  };

  const right = {
    ...plan,
    // The adapter must create a new identifier for the split-off range.
    id: undefined,
    absenceId: undefined,
    sourceId: undefined,
    uid: undefined,
    startDate: addIsoDays(date, 1),
    endDate,
  };

  return [left, right];
}

function createKrisplanAbsenceService(dependencies) {
  const deps = dependencies || {};

  const listPlanAbsences = requiredFunction('listPlanAbsences', deps.listPlanAbsences);
  const listGeneratedEntries = requiredFunction(
    'listGeneratedEntries',
    deps.listGeneratedEntries,
  );
  const getNominalWorkMinutes = requiredFunction(
    'getNominalWorkMinutes',
    deps.getNominalWorkMinutes,
  );
  const upsertGeneratedEntry = requiredFunction(
    'upsertGeneratedEntry',
    deps.upsertGeneratedEntry,
  );
  const deleteGeneratedEntry = requiredFunction(
    'deleteGeneratedEntry',
    deps.deleteGeneratedEntry,
  );

  const deleteEntry = optionalFunction(deps.deleteEntry, deleteGeneratedEntry);
  const getGeneratedEntryById = optionalFunction(deps.getGeneratedEntryById);
  const getPlanAbsenceById = optionalFunction(deps.getPlanAbsenceById);
  const replacePlanAbsence = optionalFunction(deps.replacePlanAbsence);

  const logger = deps.logger || console;
  const absenceStatus = deps.absenceStatus || DEFAULT_ABSENCE_STATUS;

  async function reconcile({ employeeId, from, to }) {
    const normalizedEmployeeId = String(employeeId || '').trim();
    if (!normalizedEmployeeId) throw new TypeError('employeeId is required');

    const normalizedFrom = assertIsoDate(from, 'from');
    const normalizedTo = assertIsoDate(to, 'to');
    if (normalizedFrom > normalizedTo) throw new RangeError('from must not be after to');

    const [plansRaw, generatedRaw] = await Promise.all([
      listPlanAbsences({
        employeeId: normalizedEmployeeId,
        from: normalizedFrom,
        to: normalizedTo,
      }),
      listGeneratedEntries({
        employeeId: normalizedEmployeeId,
        from: normalizedFrom,
        to: normalizedTo,
        source: KRISPLAN_SOURCE,
      }),
    ]);

    const plans = Array.isArray(plansRaw) ? plansRaw : [];
    const generatedEntries = (Array.isArray(generatedRaw) ? generatedRaw : []).filter(
      (entry) => entrySource(entry) === KRISPLAN_SOURCE,
    );

    const expected = new Map();

    for (const plan of plans) {
      const id = planId(plan);
      const planEmployee = planEmployeeId(plan) || normalizedEmployeeId;
      if (!id || planEmployee !== normalizedEmployeeId) continue;

      const startDate = planStartDate(plan);
      const endDate = planEndDate(plan);
      if (!overlapsRange(startDate, endDate, normalizedFrom, normalizedTo)) continue;

      const range = clampRange(startDate, endDate, normalizedFrom, normalizedTo);

      for (const date of eachIsoDate(range.start, range.end)) {
        const nominalMinutes = Number(await getNominalWorkMinutes({
          employeeId: normalizedEmployeeId,
          date,
        }));

        const includeNonWorkingDays = plan.includeNonWorkingDays === true;

        // The exact bug seen with Clemens: Saturday/Sunday rows return whenever
        // a plan range is expanded blindly. Zero nominal minutes means no row.
        if ((!Number.isFinite(nominalMinutes) || nominalMinutes <= 0)
          && !includeNonWorkingDays) {
          continue;
        }

        const fallbackMinutes = Number(
          firstDefined(plan.minutes, plan.durationMinutes, plan.nominalMinutes, 0),
        );
        const minutes = includeNonWorkingDays && nominalMinutes <= 0
          ? fallbackMinutes
          : nominalMinutes;

        const key = sourceKey({
          employeeId: normalizedEmployeeId,
          date,
          sourceId: id,
        });

        expected.set(key, {
          employeeId: normalizedEmployeeId,
          date,
          type: planType(plan),
          minutes: Number.isFinite(minutes) ? minutes : 0,
          source: KRISPLAN_SOURCE,
          sourceId: id,
          generated: true,
          status: absenceStatus,
        });
      }
    }

    const existingByKey = new Map();
    for (const entry of generatedEntries) {
      const sourceId = entrySourceId(entry);
      const employee = entryEmployeeId(entry) || normalizedEmployeeId;
      const date = entryDate(entry);
      const key = sourceKey({ employeeId: employee, date, sourceId });
      existingByKey.set(key, entry);
    }

    let inserted = 0;
    let updated = 0;
    let removed = 0;

    for (const [key, desired] of expected) {
      const existing = existingByKey.get(key) || null;
      await upsertGeneratedEntry({
        ...desired,
        id: existing?.id,
      });
      if (existing) updated += 1;
      else inserted += 1;
    }

    // Anything generated by KRISPLAN but no longer expected is stale: deleted
    // source plan, shortened range, changed employee, or non-working day.
    for (const entry of generatedEntries) {
      const sourceId = entrySourceId(entry);
      const employee = entryEmployeeId(entry) || normalizedEmployeeId;
      const date = entryDate(entry);
      const key = sourceKey({ employeeId: employee, date, sourceId });

      if (!expected.has(key)) {
        await deleteGeneratedEntry({
          id: entry.id,
          employeeId: employee,
          date,
          source: KRISPLAN_SOURCE,
          sourceId,
          reason: 'KRISPLAN_SOURCE_REMOVED_OR_NON_WORKING_DAY',
        });
        removed += 1;
      }
    }

    logger.info?.('KRISPLAN absence reconciliation complete', {
      employeeId: normalizedEmployeeId,
      from: normalizedFrom,
      to: normalizedTo,
      expected: expected.size,
      inserted,
      updated,
      removed,
    });

    return {
      employeeId: normalizedEmployeeId,
      from: normalizedFrom,
      to: normalizedTo,
      expected: expected.size,
      inserted,
      updated,
      removed,
    };
  }

  /**
   * Call after every KRISPLAN create/update/delete. Supply the union of the old
   * and new date range so rows that disappeared are included in the cleanup.
   */
  async function reconcileAfterPlanMutation({ employeeId, oldPlan, newPlan }) {
    const candidates = [oldPlan, newPlan].filter(Boolean);
    if (!candidates.length) {
      throw new TypeError('oldPlan or newPlan is required');
    }

    const normalizedEmployeeId = String(
      employeeId || planEmployeeId(newPlan || oldPlan),
    ).trim();
    if (!normalizedEmployeeId) throw new TypeError('employeeId is required');

    const starts = candidates.map(planStartDate).sort();
    const ends = candidates.map(planEndDate).sort();

    return reconcile({
      employeeId: normalizedEmployeeId,
      from: starts[0],
      to: ends[ends.length - 1],
    });
  }

  /**
   * Delete from Tagesabschluss/Tageskontrolle.
   *
   * A KRISPLAN-generated row changes the source plan as well. A range is deleted,
   * shortened, or split so it cannot reappear on the next synchronization.
   */
  async function deleteFromDayClose({ entryId }) {
    if (!getGeneratedEntryById || !getPlanAbsenceById || !replacePlanAbsence) {
      throw new Error(
        'deleteFromDayClose requires getGeneratedEntryById, '
        + 'getPlanAbsenceById and replacePlanAbsence adapters',
      );
    }

    const entry = await getGeneratedEntryById({ id: entryId });
    if (!entry) return { deleted: false, reason: 'NOT_FOUND' };

    const source = entrySource(entry);
    const employeeId = entryEmployeeId(entry);
    const date = entryDate(entry);

    if (source !== KRISPLAN_SOURCE) {
      await deleteEntry({
        id: entry.id,
        employeeId,
        date,
        reason: 'MANUAL_DELETE',
      });
      return {
        deleted: true,
        sourceChanged: false,
        employeeId,
        date,
      };
    }

    const sourceId = entrySourceId(entry);
    const plan = sourceId ? await getPlanAbsenceById({ id: sourceId }) : null;

    if (plan) {
      const replacements = splitPlanAroundDate(plan, date);
      await replacePlanAbsence({
        id: sourceId,
        original: plan,
        replacements,
        reason: 'DELETED_FROM_DAY_CLOSE',
      });
    }

    // Remove immediately for responsive UI, then reconcile to clean any other
    // stale mirrors in this date.
    await deleteGeneratedEntry({
      id: entry.id,
      employeeId,
      date,
      source: KRISPLAN_SOURCE,
      sourceId,
      reason: 'DELETED_FROM_DAY_CLOSE',
    });

    await reconcile({ employeeId, from: date, to: date });

    return {
      deleted: true,
      sourceChanged: Boolean(plan),
      employeeId,
      date,
      sourceId,
    };
  }

  return {
    reconcile,
    reconcileAfterPlanMutation,
    deleteFromDayClose,
  };
}

module.exports = {
  KRISPLAN_SOURCE,
  DEFAULT_ABSENCE_STATUS,
  assertIsoDate,
  addIsoDays,
  eachIsoDate,
  splitPlanAroundDate,
  createKrisplanAbsenceService,
};
