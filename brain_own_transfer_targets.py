"""Read-only own-account targets for SEPA preparation; never sends a payment."""
import os
import re
from brain_capture_accounts import ACCOUNTS
from brain_finance_sepa import iban_valid


def configured_business_iban():
    value = os.environ.get('KRISTINE_REVOLUT_BUSINESS_OWN_IBAN', '')
    if not value and os.name == 'nt':
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, 'Environment') as key:
                value, _kind = winreg.QueryValueEx(key, 'KRISTINE_REVOLUT_BUSINESS_OWN_IBAN')
        except OSError:
            pass
        if not value:
            try:
                with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r'SYSTEM\CurrentControlSet\Control\Session Manager\Environment') as key:
                    value, _kind = winreg.QueryValueEx(key, 'KRISTINE_REVOLUT_BUSINESS_OWN_IBAN')
            except OSError:
                pass
    return re.sub(r'\s+', '', str(value)).upper()


def transfer_targets(revolut=None):
    targets, warnings = [], []
    # Account 2881 comes from the user's approved chart of accounts.
    account = next((a for a in ACCOUNTS if a['number'] == '2881'), None)
    configured = os.environ.get('KRISTINE_REVOLUT_OWN_IBAN', '')
    match = re.search(r'\b([A-Z]{2}\d{2}[\d ]+)\s*$', account['name']) if account else None
    iban = re.sub(r'\s+', '', configured or (match.group(1) if match else '')).upper()
    if iban_valid(iban):
        targets.append({'id': 'own-revolut-2881', 'name': 'Revolut', 'currency': 'EUR',
                        'iban': iban, 'bic': '', 'beneficiary': os.environ.get('KRISTINE_SEPA_DEBTOR_NAME') or 'Farben Krista GmbH & Co KG',
                        'referenceRequired': '', 'source': 'Sachkonto 2881'})
    else:
        warnings.append('Für Revolut fehlt eine gültige eigene IBAN im Sachkonto 2881.')
    try:
        business = revolut.transfer_accounts() if revolut else []
        for item in business:
            if str(item.get('currency') or 'EUR').upper() != 'EUR' or not iban_valid(item.get('iban')):
                continue
            if any(t['iban'] == re.sub(r'\s+', '', item['iban']).upper() for t in targets):
                continue
            targets.append({**item, 'name': 'Revolut Business · ' + str(item.get('name') or 'EUR')})
        if not business:
            warnings.append('Revolut Business ist momentan nicht verfügbar.')
    except Exception:
        warnings.append('Revolut Business konnte nicht geladen werden. Verbindung prüfen.')
    configured_business = configured_business_iban()
    if configured_business and not iban_valid(configured_business):
        warnings.append('Die hinterlegte Revolut-Business-IBAN ist ungültig.')
    elif configured_business and not any(t['iban'].replace(' ', '').upper() == configured_business for t in targets):
        targets.append({'id': 'own-revolut-business', 'name': 'Revolut Business', 'currency': 'EUR',
                        'iban': configured_business, 'bic': '', 'beneficiary': os.environ.get('KRISTINE_SEPA_DEBTOR_NAME') or 'Farben Krista GmbH & Co KG',
                        'referenceRequired': '', 'source': 'Bestätigtes eigenes Business-Konto'})
    return targets, warnings
