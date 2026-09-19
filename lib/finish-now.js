'use strict';

/**
 * KRISTINE hotfix for WhatsApp command "fertig".
 *
 * Required behaviour:
 *   1. The running booking is stopped immediately at the WhatsApp message time.
 *   2. The day-close workflow stays open as a separate step.
 *   3. A later confirmation must never move the persisted booking end time.
 *   4. WhatsApp webhook retries must not create a second end event.
 *
 * The module is storage-neutral. Existing database/JSON functions are injected
 * as adapters, so the current KRISTINE data model does not have to be replaced.
 */

const FINISH_COMMAND = 'fertig';
const FINISH_SOURCE = 'whatsapp:fertig';
const DEFAULT_RUNTIME_STATUS = 'DAY_CLOSE_OPEN';
const DEFAULT_DRAFT_STATUS = 'OPEN';
const DEFAULT_CONFIRMED_STATUS = 'CONFIRMED';

function requiredFunction(name, value) {
  if (typeof value !== 'function') {
    throw new TypeError(`finish-now: dependency ${name} must be a function`);
  }
  return value;
}

function optionalFunction(value, fallback = null) {
  return typeof value === 'function' ? value : fallback;
}

/**
 * WhatsApp timestamps normally arrive as Unix seconds encoded as a string.
 * Milliseconds, Date objects and ISO strings are accepted as well.
 */
function parseMessageDate(value, fallback = new Date()) {
  if (value instanceof Date) {
    const copy = new Date(value.getTime());
    if (Number.isNaN(copy.getTime())) throw new TypeError('Invalid Date');
    return copy;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < 100_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    if (Number.isNaN(date.getTime())) throw new TypeError('Invalid timestamp');
    return date;
  }

  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim();
    if (/^\d{10,13}$/.test(trimmed)) {
      return parseMessageDate(Number(trimmed), fallback);
    }

    const date = new Date(trimmed);
    if (!Number.isNaN(date.getTime())) return date;
  }

  const fallbackDate = fallback instanceof Date
    ? new Date(fallback.getTime())
    : new Date(fallback);

  if (Number.isNaN(fallbackDate.getTime())) {
    throw new TypeError('Invalid message timestamp and invalid fallback');
  }

  return fallbackDate;
}

function localIsoDate(date, timeZone = 'Europe/Vienna') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function asIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizedText(value) {
  return String(value || '').trim().toLocaleLowerCase('de-AT');
}

function isFinishCommand(value) {
  return normalizedText(value) === FINISH_COMMAND;
}

function getPersistedEnd(booking) {
  if (!booking) return null;
  return asIso(
    booking.endedAt
      || booking.endAt
      || booking.end
      || booking.finishedAt
      || booking.endTime,
  );
}

/**
 * Creates the service that handles the incoming WhatsApp command "fertig".
 *
 * Required adapters:
 * - findOpenBooking({ employeeId, date, at })
 * - closeBooking({ employeeId, bookingId, endedAt, source, command,
 *                  sourceMessageId, expectedOpen })
 * - setRuntimeStatus({ employeeId, date, status, changedAt, source })
 * - upsertDayCloseDraft({ employeeId, date, status, finishedAt, ... })
 * - buildDaySummary({ employeeId, date, finishedAt })
 *
 * Recommended optional adapter:
 * - findBookingBySourceMessageId({ employeeId, sourceMessageId, source })
 *
 * closeBooking should update only an open row, for example with
 * "WHERE id = ? AND ended_at IS NULL". That protects against two simultaneous
 * webhook deliveries even when they arrive before idempotency lookup completes.
 */
function createFinishNowService(dependencies) {
  const deps = dependencies || {};

  const findOpenBooking = requiredFunction('findOpenBooking', deps.findOpenBooking);
  const closeBooking = requiredFunction('closeBooking', deps.closeBooking);
  const setRuntimeStatus = requiredFunction('setRuntimeStatus', deps.setRuntimeStatus);
  const upsertDayCloseDraft = requiredFunction(
    'upsertDayCloseDraft',
    deps.upsertDayCloseDraft,
  );
  const buildDaySummary = requiredFunction('buildDaySummary', deps.buildDaySummary);

  const findBookingBySourceMessageId = optionalFunction(
    deps.findBookingBySourceMessageId,
    async () => null,
  );
  const getMostRecentBooking = optionalFunction(deps.getMostRecentBooking, async () => null);

  const logger = deps.logger || console;
  const timeZone = deps.timeZone || 'Europe/Vienna';
  const now = optionalFunction(deps.now, () => new Date());
  const runtimeStatus = deps.runtimeStatus || DEFAULT_RUNTIME_STATUS;
  const draftStatus = deps.draftStatus || DEFAULT_DRAFT_STATUS;

  return async function finishNow(input) {
    const payload = input || {};
    const employeeId = String(payload.employeeId || '').trim();
    if (!employeeId) throw new TypeError('finish-now: employeeId is required');

    const sourceMessageId = payload.messageId ? String(payload.messageId) : null;
    const finishedAtDate = parseMessageDate(
      payload.messageTimestamp ?? payload.receivedAt,
      now(),
    );
    const requestedFinishedAt = finishedAtDate.toISOString();
    const date = payload.date || localIsoDate(finishedAtDate, timeZone);

    // WhatsApp retries the same webhook occasionally. Reuse the end time that
    // was already persisted for this exact message instead of creating a new one.
    let booking = null;
    if (sourceMessageId) {
      booking = await findBookingBySourceMessageId({
        employeeId,
        sourceMessageId,
        source: FINISH_SOURCE,
      });
    }

    let stoppedNow = false;
    let alreadyStopped = Boolean(booking);

    if (!booking) {
      const openBooking = await findOpenBooking({
        employeeId,
        date,
        at: requestedFinishedAt,
      });

      if (openBooking && !getPersistedEnd(openBooking)) {
        const closeResult = await closeBooking({
          employeeId,
          bookingId: openBooking.id,
          endedAt: requestedFinishedAt,
          source: FINISH_SOURCE,
          command: FINISH_COMMAND,
          sourceMessageId,
          expectedOpen: true,
        });

        // The adapter should return the persisted row. If an optimistic update
        // lost a race, use the latest stored row instead of inventing another end.
        booking = closeResult || await getMostRecentBooking({ employeeId, date });
        stoppedNow = Boolean(closeResult);
        alreadyStopped = !stoppedNow;
      } else {
        booking = openBooking || await getMostRecentBooking({ employeeId, date });
        alreadyStopped = true;
      }
    }

    const persistedFinishedAt = getPersistedEnd(booking) || requestedFinishedAt;

    // Critical separation: work is no longer running, but the day close remains open.
    await setRuntimeStatus({
      employeeId,
      date,
      status: runtimeStatus,
      changedAt: persistedFinishedAt,
      source: FINISH_SOURCE,
      isWorking: false,
      dayCloseOpen: true,
    });

    await upsertDayCloseDraft({
      employeeId,
      date,
      status: draftStatus,
      finishedAt: persistedFinishedAt,
      source: FINISH_SOURCE,
      sourceMessageId,
      preserveFinishedAt: true,
      openedAt: persistedFinishedAt,
    });

    const summary = await buildDaySummary({
      employeeId,
      date,
      finishedAt: persistedFinishedAt,
    });

    logger.info?.('KRISTINE fertig: work stopped, day close left open', {
      employeeId,
      date,
      finishedAt: persistedFinishedAt,
      stoppedNow,
      alreadyStopped,
      sourceMessageId,
    });

    return {
      employeeId,
      date,
      finishedAt: persistedFinishedAt,
      stoppedNow,
      alreadyStopped,
      dayCloseStatus: draftStatus,
      runtimeStatus,
      summary,
    };
  };
}

/**
 * Creates the separate confirmation step for the day close.
 *
 * Deliberately absent from this service: closeBooking/updateBookingEnd.
 * The existing finishedAt from the draft is immutable and is merely carried
 * into the confirmed day-close record.
 *
 * Required adapters:
 * - getDayCloseDraft({ employeeId, date })
 * - markDayCloseConfirmed({ employeeId, date, status, finishedAt,
 *                           confirmedAt, details, preserveFinishedAt })
 *
 * Optional adapter:
 * - saveDayCloseDetails({ employeeId, date, details, finishedAt })
 */
function createDayCloseConfirmationService(dependencies) {
  const deps = dependencies || {};

  const getDayCloseDraft = requiredFunction('getDayCloseDraft', deps.getDayCloseDraft);
  const markDayCloseConfirmed = requiredFunction(
    'markDayCloseConfirmed',
    deps.markDayCloseConfirmed,
  );
  const saveDayCloseDetails = optionalFunction(deps.saveDayCloseDetails, async () => null);

  const now = optionalFunction(deps.now, () => new Date());
  const confirmedStatus = deps.confirmedStatus || DEFAULT_CONFIRMED_STATUS;

  return async function confirmDayClose(input) {
    const payload = input || {};
    const employeeId = String(payload.employeeId || '').trim();
    const date = String(payload.date || '').trim();

    if (!employeeId) throw new TypeError('day-close-confirm: employeeId is required');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new TypeError('day-close-confirm: date must be YYYY-MM-DD');
    }

    const draft = await getDayCloseDraft({ employeeId, date });
    if (!draft) {
      const error = new Error('No open day-close draft found');
      error.code = 'DAY_CLOSE_DRAFT_NOT_FOUND';
      throw error;
    }

    const finishedAt = asIso(draft.finishedAt || draft.endedAt || draft.endAt);
    if (!finishedAt) {
      const error = new Error('Day-close draft has no fixed finishedAt');
      error.code = 'DAY_CLOSE_FINISHED_AT_MISSING';
      throw error;
    }

    const confirmedAt = parseMessageDate(payload.confirmedAt, now()).toISOString();
    const details = payload.details || {};

    await saveDayCloseDetails({
      employeeId,
      date,
      details,
      finishedAt,
      preserveFinishedAt: true,
    });

    const confirmed = await markDayCloseConfirmed({
      employeeId,
      date,
      status: confirmedStatus,
      finishedAt,
      confirmedAt,
      details,
      preserveFinishedAt: true,
    });

    return {
      employeeId,
      date,
      status: confirmedStatus,
      finishedAt,
      confirmedAt,
      record: confirmed || null,
    };
  };
}

module.exports = {
  FINISH_COMMAND,
  FINISH_SOURCE,
  DEFAULT_RUNTIME_STATUS,
  DEFAULT_DRAFT_STATUS,
  DEFAULT_CONFIRMED_STATUS,
  parseMessageDate,
  localIsoDate,
  asIso,
  normalizedText,
  isFinishCommand,
  getPersistedEnd,
  createFinishNowService,
  createDayCloseConfirmationService,
};
