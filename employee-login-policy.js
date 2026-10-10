"use strict";
const { isAlexander } = require('./kristine-user-access');
function personalLoginEnabled() {
  return ['true','alexander'].includes(process.env.KRISTINE_PERSONAL_LOGIN_ENABLED);
}
function personalLoginAllowed(employee) {
  if (!employee || employee.active === false) return false;
  const mode=process.env.KRISTINE_PERSONAL_LOGIN_ENABLED;
  // Keep PR #142's isolated Alexander path independent of employee grants.
  // General login must fail closed for records without an explicit grant.
  return (mode === 'true' && employee.kristineAccess === true) ||
    (mode === 'alexander' && isAlexander(employee));
}
module.exports={personalLoginEnabled,personalLoginAllowed};
