'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const src=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
const morning=fs.readFileSync(path.join(__dirname,'..','morning-status.js'),'utf8');
const vehicle=fs.readFileSync(path.join(__dirname,'..','vehicle-tracking.js'),'utf8');

test('live webhook processes status-only callbacks before messages early return',()=>{
  const first=src.indexOf('app.post("/webhook"');
  const handler=src.slice(first,first+2200);
  assert.ok(first>0);
  const processStatus=handler.indexOf('whatsAppDeliveryAudit.recordStatuses(value.statuses)');
  const returnOnEmpty=handler.indexOf('if (!Array.isArray(msgs) || msgs.length === 0) return;');
  assert.ok(processStatus>0);
  assert.ok(returnOnEmpty>processStatus);
});

test('accepted Meta response is recorded, not treated as proof of delivery',()=>{
  assert.match(src,/WhatsApp API accepted/);
  assert.match(src,/whatsAppDeliveryAudit\.recordAccepted\(/);
  assert.match(src,/id:responseJson\?\.messages\?\.\[0\]\?\.id/);
  assert.match(src,/purpose,/);
  assert.doesNotMatch(src,/await whatsAppDeliveryAudit\.recordAccepted\([\s\S]*?\)\s*;\s*return\s+responseJson/);
});

test('delivery diagnostics require admin and never retry failed messages',()=>{
  const start=src.indexOf('app.get("/admin/api/whatsapp/delivery"');
  assert.ok(start>0);
  const route=src.slice(start,start+600);
  assert.match(route,/if \(!requireAdmin\(req, res\)\) return;/);
  assert.match(route,/whatsAppDeliveryAudit\.latest/);
  assert.doesNotMatch(route,/sendWhatsAppKristineReply|sendToChef/);
});

test('boss reports and planning notifications are independently tagged',()=>{
  assert.match(morning,/sendToChef\(report, "chefReport"\)/);
  assert.match(morning,/sendToChef\(message, schedulerKey\)/);
  assert.match(morning,/async function sendToChef\(reply, purpose = "chef"\)/);
  assert.match(vehicle,/writeVehicleJsonAtomic\(file, value\)/);
  assert.match(vehicle,/KRISDRIVE Buzzer-Timer fehlgeschlagen/);
});
