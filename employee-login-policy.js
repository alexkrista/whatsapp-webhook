"use strict";
const { isAlexander } = require('./kristine-user-access');
function normalizeLoginName(value) {
  return String(value || '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function namedLoginAllowed(employee) {
  const name = normalizeLoginName(employee.name || employee.employeeName);
  const listed = String(process.env.KRISTINE_PERSONAL_LOGIN_ADDITIONAL_NAMES || '')
    .split('|').map(normalizeLoginName).filter(Boolean);
  return Boolean(name && listed.includes(name));
}

function personalLoginEnabled() {
  return ['true','alexander'].includes(process.env.KRISTINE_PERSONAL_LOGIN_ENABLED);
}
function personalLoginAllowed(employee) {
  if (!employee || employee.active === false) return false;
  const mode=process.env.KRISTINE_PERSONAL_LOGIN_ENABLED;
  return mode === 'true' || (mode === 'alexander' && (isAlexander(employee) || namedLoginAllowed(employee)));
}
module.exports={personalLoginEnabled,personalLoginAllowed};
