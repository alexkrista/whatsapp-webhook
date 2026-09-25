"use strict";
const { isAlexander } = require('./kristine-user-access');
function personalLoginEnabled() {
  return ['true','alexander'].includes(process.env.KRISTINE_PERSONAL_LOGIN_ENABLED);
}
function personalLoginAllowed(employee) {
  if (!employee || employee.active === false) return false;
  const mode=process.env.KRISTINE_PERSONAL_LOGIN_ENABLED;
  return mode === 'true' || (mode === 'alexander' && isAlexander(employee));
}
module.exports={personalLoginEnabled,personalLoginAllowed};
