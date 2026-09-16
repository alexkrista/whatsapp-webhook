const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const ui = read('brain_finance_ui.py');
const debit = read('brain_finance_direct_debit.py');
const tools = read('brain_finance_op_tools.py');
const runtime = read('brain_finance_runtime.py');

assert(ui.includes('#sepaArchive .archive-row{grid-template-columns:110px'));
assert(ui.includes('#sepaArchive .archive-row>*{min-width:0}'));
assert(debit.includes('<option value="31" selected>1 Monat</option><option value="7">7 Tage</option>'));
assert(debit.includes('range?.value||31'));
assert(tools.includes("directDebitRange')?.value||31"));
assert(tools.includes("x?.paymentMethod==='direct_debit'?Number(x.amount||0)"));
assert(runtime.includes('def _pick_finance_approver('));
assert(runtime.includes('"actorId":verified'));
assert(!runtime.includes('return "admin",wanted_name'));

for (const source of [runtime, ui, debit, tools]) {
  assert(!source.includes('/incoming/direct-pay'), 'must remain read-only');
  assert(!source.includes('payment-batch/excel'), 'must not add Excel payment export');
}

console.log('finance safe integration checks: ok');
