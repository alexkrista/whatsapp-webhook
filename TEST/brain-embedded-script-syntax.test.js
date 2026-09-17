const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
for (const name of ['brain_invoice_intake.py', 'brain_capture_prepayment.py', 'brain_finance_creditor_ui.py']) {
  const source = fs.readFileSync(path.join(root, name), 'utf8');
  const match = source.match(/script\s*=\s*r'''([\s\S]*?)'''/);
  if (!match) throw new Error(`embedded script missing: ${name}`);
  const javascript = match[1].replace(/<script[^>]*>/, ' ').replace(/<\/script>/, ' ');
  new Function(javascript);
}

console.log('embedded Brain scripts parse: ok');
