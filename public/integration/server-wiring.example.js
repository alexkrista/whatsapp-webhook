'use strict';

/**
 * Integration example for the two KRISTINE hotfixes.
 *
 * Do not copy the method names blindly. Map the existing KRISTINE storage
 * functions to the adapter methods shown below. The important sequence is:
 *
 *   WhatsApp "fertig"
 *     -> persist booking end immediately
 *     -> set status to DAY_CLOSE_OPEN
 *     -> create/update day-close draft
 *     -> only then send the summary/question
 *
 *   Day-close confirmation
 *     -> save details and mark confirmed
 *     -> NEVER update/close the time booking again
 *
 *   KRISPLAN mutation/load
 *     -> reconcile source plans against generated absence rows
 */

const {
  isFinishCommand,
  createFinishNowService,
  createDayCloseConfirmationService,
} = require('../lib/finish-now');
const {
  createKrisplanAbsenceService,
} = require('../lib/krisplan-absence-reconcile');

function requireMethod(object, name) {
  if (!object || typeof object[name] !== 'function') {
    throw new TypeError(`Missing storage adapter: ${name}`);
  }
  return object[name].bind(object);
}

/**
 * storage contract (map these to the current KRISTINE repository functions):
 *
 * Time/day close:
 *   findOpenBooking
 *   closeBooking
 *   findBookingBySourceMessageId (recommended)
 *   getMostRecentBooking (recommended)
 *   setRuntimeStatus
 *   upsertDayCloseDraft
 *   buildDaySummary
 *   getDayCloseDraft
 *   saveDayCloseDetails
 *   markDayCloseConfirmed
 *
 * KRISPLAN/absence:
 *   listPlanAbsences
 *   listGeneratedEntries
 *   getNominalWorkMinutes
 *   upsertGeneratedEntry
 *   deleteGeneratedEntry
 *   deleteEntry
 *   getGeneratedEntryById
 *   getPlanAbsenceById
 *   replacePlanAbsence
 */
function createKristineHotfixControllers({ storage, messenger, logger = console }) {
  if (!storage) throw new TypeError('storage is required');
  if (!messenger || typeof messenger.sendDaySummary !== 'function') {
    throw new TypeError('messenger.sendDaySummary is required');
  }

  const finishNow = createFinishNowService({
    findOpenBooking: requireMethod(storage, 'findOpenBooking'),
    closeBooking: requireMethod(storage, 'closeBooking'),
    findBookingBySourceMessageId:
      typeof storage.findBookingBySourceMessageId === 'function'
        ? storage.findBookingBySourceMessageId.bind(storage)
        : undefined,
    getMostRecentBooking:
      typeof storage.getMostRecentBooking === 'function'
        ? storage.getMostRecentBooking.bind(storage)
        : undefined,
    setRuntimeStatus: requireMethod(storage, 'setRuntimeStatus'),
    upsertDayCloseDraft: requireMethod(storage, 'upsertDayCloseDraft'),
    buildDaySummary: requireMethod(storage, 'buildDaySummary'),
    logger,
    timeZone: 'Europe/Vienna',
    // Change these two values only if the current database uses other enums.
    runtimeStatus: 'DAY_CLOSE_OPEN',
    draftStatus: 'OPEN',
  });

  const confirmDayClose = createDayCloseConfirmationService({
    getDayCloseDraft: requireMethod(storage, 'getDayCloseDraft'),
    saveDayCloseDetails: requireMethod(storage, 'saveDayCloseDetails'),
    markDayCloseConfirmed: requireMethod(storage, 'markDayCloseConfirmed'),
    logger,
  });

  const absences = createKrisplanAbsenceService({
    listPlanAbsences: requireMethod(storage, 'listPlanAbsences'),
    listGeneratedEntries: requireMethod(storage, 'listGeneratedEntries'),
    getNominalWorkMinutes: requireMethod(storage, 'getNominalWorkMinutes'),
    upsertGeneratedEntry: requireMethod(storage, 'upsertGeneratedEntry'),
    deleteGeneratedEntry: requireMethod(storage, 'deleteGeneratedEntry'),
    deleteEntry: requireMethod(storage, 'deleteEntry'),
    getGeneratedEntryById: requireMethod(storage, 'getGeneratedEntryById'),
    getPlanAbsenceById: requireMethod(storage, 'getPlanAbsenceById'),
    replacePlanAbsence: requireMethod(storage, 'replacePlanAbsence'),
    logger,
  });

  /**
   * Put this BEFORE the old generic message/day-close handler.
   * Return true so the caller knows the message was fully handled.
   */
  async function handleWhatsAppText({
    employeeId,
    text,
    messageId,
    messageTimestamp,
    receivedAt,
  }) {
    if (!isFinishCommand(text)) return false;

    const result = await finishNow({
      employeeId,
      messageId,
      messageTimestamp,
      receivedAt,
    });

    await messenger.sendDaySummary({
      employeeId,
      date: result.date,
      summary: result.summary,
      finishedAt: result.finishedAt,
      question: 'Passt das so?',
      buttons: ['Ja', 'Nein'],
    });

    return true;
  }

  /**
   * This replaces the old "Ja"/confirmation branch that currently appears to
   * stop the booking. It only confirms the already-open day close.
   */
  async function handleDayCloseConfirmation({
    employeeId,
    date,
    details,
    confirmedAt,
  }) {
    return confirmDayClose({
      employeeId,
      date,
      details,
      confirmedAt,
    });
  }

  /**
   * Call immediately after KRISPLAN create/update/delete. On delete, newPlan is
   * null; on create, oldPlan is null. On update, pass both old and new record.
   */
  async function afterKrisplanMutation({ employeeId, oldPlan, newPlan }) {
    return absences.reconcileAfterPlanMutation({ employeeId, oldPlan, newPlan });
  }

  /**
   * Call before returning Tagesabschluss/Tageskontrolle for a date. This makes
   * already-stale weekend or deleted Urlaub rows disappear on the next load.
   */
  async function beforeDayCloseRead({ employeeId, date }) {
    return absences.reconcile({ employeeId, from: date, to: date });
  }

  /**
   * Use this route/controller when the user deletes an absence row in
   * Tagesabschluss. For KRISPLAN rows the source range is changed as well.
   */
  async function deleteDayCloseEntry({ entryId }) {
    return absences.deleteFromDayClose({ entryId });
  }

  return {
    handleWhatsAppText,
    handleDayCloseConfirmation,
    afterKrisplanMutation,
    beforeDayCloseRead,
    deleteDayCloseEntry,
    finishNow,
    confirmDayClose,
    absences,
  };
}

/*
 * EXPRESS/WEBHOOK SEQUENCE EXAMPLE
 * --------------------------------
 *
 * const hotfix = createKristineHotfixControllers({ storage, messenger });
 *
 * app.post('/webhook/whatsapp', async (req, res, next) => {
 *   try {
 *     const message = parseWhatsAppMessage(req.body);
 *     const handled = await hotfix.handleWhatsAppText({
 *       employeeId: message.employeeId,
 *       text: message.text,
 *       messageId: message.id,
 *       messageTimestamp: message.timestamp,
 *       receivedAt: new Date(),
 *     });
 *     if (handled) return res.sendStatus(200);
 *     return oldWhatsAppHandler(req, res, next);
 *   } catch (error) {
 *     next(error);
 *   }
 * });
 *
 * app.post('/api/day-close/:employeeId/:date/confirm', async (req, res, next) => {
 *   try {
 *     const result = await hotfix.handleDayCloseConfirmation({
 *       employeeId: req.params.employeeId,
 *       date: req.params.date,
 *       details: req.body,
 *       confirmedAt: new Date(),
 *     });
 *     res.json(result);
 *   } catch (error) {
 *     next(error);
 *   }
 * });
 *
 * app.get('/api/day-close/:employeeId/:date', async (req, res, next) => {
 *   try {
 *     await hotfix.beforeDayCloseRead(req.params);
 *     res.json(await storage.readDayClose(req.params));
 *   } catch (error) {
 *     next(error);
 *   }
 * });
 *
 * app.delete('/api/day-close/entry/:entryId', async (req, res, next) => {
 *   try {
 *     res.json(await hotfix.deleteDayCloseEntry({ entryId: req.params.entryId }));
 *   } catch (error) {
 *     next(error);
 *   }
 * });
 */

module.exports = {
  createKristineHotfixControllers,
};
