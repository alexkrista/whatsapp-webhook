'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseMessageDate,
  isFinishCommand,
  createFinishNowService,
  createDayCloseConfirmationService,
} = require('../lib/finish-now');

test('recognises only the exact command fertig', () => {
  assert.equal(isFinishCommand('fertig'), true);
  assert.equal(isFinishCommand(' FERTIG '), true);
  assert.equal(isFinishCommand('fertig bitte'), false);
  assert.equal(isFinishCommand('ende'), false);
});

test('parses WhatsApp Unix seconds exactly', () => {
  const date = parseMessageDate('1787034480');
  assert.equal(date.toISOString(), '2026-08-18T06:28:00.000Z');
});

test('fertig stops the booking immediately and leaves day close open', async () => {
  const events = [];
  const bookings = [{
    id: 'booking-1',
    employeeId: 'alex',
    startedAt: '2026-08-18T06:24:00.000Z',
    endedAt: null,
  }];

  const finishNow = createFinishNowService({
    now: () => new Date('2026-08-18T07:00:00.000Z'),
    logger: { info() {} },
    async findOpenBooking() {
      return bookings.find((item) => !item.endedAt) || null;
    },
    async closeBooking(input) {
      const booking = bookings.find((item) => item.id === input.bookingId);
      assert.ok(booking);
      assert.equal(booking.endedAt, null);
      booking.endedAt = input.endedAt;
      booking.source = input.source;
      booking.sourceMessageId = input.sourceMessageId;
      events.push(['close', input]);
      return { ...booking };
    },
    async findBookingBySourceMessageId({ sourceMessageId }) {
      return bookings.find((item) => item.sourceMessageId === sourceMessageId) || null;
    },
    async setRuntimeStatus(input) {
      events.push(['status', input]);
    },
    async upsertDayCloseDraft(input) {
      events.push(['draft', input]);
    },
    async buildDaySummary(input) {
      events.push(['summary', input]);
      return { text: '08:24–08:28 Schwerzler/Halter' };
    },
  });

  const result = await finishNow({
    employeeId: 'alex',
    messageId: 'wamid-123',
    messageTimestamp: '1787034480',
  });

  assert.equal(result.finishedAt, '2026-08-18T06:28:00.000Z');
  assert.equal(result.stoppedNow, true);
  assert.equal(result.runtimeStatus, 'DAY_CLOSE_OPEN');
  assert.equal(result.dayCloseStatus, 'OPEN');
  assert.equal(bookings[0].endedAt, '2026-08-18T06:28:00.000Z');

  assert.deepEqual(events.map(([name]) => name), ['close', 'status', 'draft', 'summary']);
  assert.equal(events[1][1].isWorking, false);
  assert.equal(events[1][1].dayCloseOpen, true);
  assert.equal(events[2][1].preserveFinishedAt, true);
});

test('duplicate WhatsApp webhook does not create another end time', async () => {
  const bookings = [{
    id: 'booking-1',
    employeeId: 'alex',
    startedAt: '2026-08-18T06:24:00.000Z',
    endedAt: null,
    sourceMessageId: null,
  }];
  let closeCount = 0;

  const finishNow = createFinishNowService({
    logger: { info() {} },
    async findOpenBooking() {
      return bookings.find((item) => !item.endedAt) || null;
    },
    async closeBooking(input) {
      closeCount += 1;
      const booking = bookings[0];
      booking.endedAt = input.endedAt;
      booking.sourceMessageId = input.sourceMessageId;
      return { ...booking };
    },
    async findBookingBySourceMessageId({ sourceMessageId }) {
      return bookings.find((item) => item.sourceMessageId === sourceMessageId) || null;
    },
    async setRuntimeStatus() {},
    async upsertDayCloseDraft() {},
    async buildDaySummary() { return {}; },
  });

  const payload = {
    employeeId: 'alex',
    messageId: 'wamid-duplicate',
    messageTimestamp: '1787034480',
  };

  const first = await finishNow(payload);
  const second = await finishNow(payload);

  assert.equal(closeCount, 1);
  assert.equal(first.finishedAt, '2026-08-18T06:28:00.000Z');
  assert.equal(second.finishedAt, '2026-08-18T06:28:00.000Z');
  assert.equal(second.alreadyStopped, true);
});

test('later day-close confirmation preserves the original booking end', async () => {
  const calls = [];
  const confirmDayClose = createDayCloseConfirmationService({
    now: () => new Date('2026-08-18T06:40:00.000Z'),
    async getDayCloseDraft() {
      return {
        employeeId: 'alex',
        date: '2026-08-18',
        status: 'OPEN',
        finishedAt: '2026-08-18T06:28:00.000Z',
      };
    },
    async saveDayCloseDetails(input) {
      calls.push(['details', input]);
    },
    async markDayCloseConfirmed(input) {
      calls.push(['confirm', input]);
      return input;
    },
  });

  const result = await confirmDayClose({
    employeeId: 'alex',
    date: '2026-08-18',
    confirmedAt: '2026-08-18T06:40:00.000Z',
    details: { photosComplete: true },
  });

  assert.equal(result.finishedAt, '2026-08-18T06:28:00.000Z');
  assert.equal(result.confirmedAt, '2026-08-18T06:40:00.000Z');
  assert.equal(calls[0][1].finishedAt, '2026-08-18T06:28:00.000Z');
  assert.equal(calls[1][1].finishedAt, '2026-08-18T06:28:00.000Z');
  assert.equal(calls[1][1].preserveFinishedAt, true);
});
