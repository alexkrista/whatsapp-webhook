# coding: utf-8
"""Printable monthly account sheets from all imported Revolut transactions."""
import csv
import io
import re
from decimal import Decimal
from html import escape
from datetime import datetime
from brain_finance_reconciliation import CATEGORIES


def monthly_rows(statements, account, month):
    if account not in ('personal', 'business'):
        raise ValueError('Bitte ein Revolut-Konto wählen.')
    if not re.fullmatch(r'\d{4}-(?:0[1-9]|1[0-2])', str(month or '')):
        raise ValueError('Bitte einen gültigen Monat wählen.')
    source = 'REVOLUT' if account == 'personal' else 'REVOLUT_BUSINESS'
    rows = {}
    for statement in statements:
        if statement.get('source') != source:
            continue
        for move in statement.get('movements') or []:
            if str(move.get('bookingDate') or '')[:7] != month:
                continue
            key = move.get('id')
            if key is None:
                raise ValueError('Buchung ohne eindeutige Kennung im Bankabgleich.')
            rows[key] = {**move, 'accountIban': statement.get('accountIban') or ''}
    return sorted(rows.values(), key=lambda row: (str(row.get('bookingDate') or ''), str(row.get('id'))))


def signed(row):
    amount = abs(Decimal(str(row.get('amount') or 0)))
    return -amount if row.get('direction') == 'out' else amount


def money(value):
    return format(Decimal(str(value)), ',.2f').replace(',', 'X').replace('.', ',').replace('X', '.')


def csv_sheet(rows):
    target = io.StringIO(newline='')
    writer = csv.writer(target, delimiter=';')
    writer.writerow(['Buchungsdatum', 'Valuta', 'Konto', 'Gegenpartei', 'Verwendungszweck', 'Betrag', 'Währung', 'Status', 'Noch zuzuordnen', 'Zuordnung'])
    for row in rows:
        text = lambda v: "'" + str(v) if str(v).startswith(('=', '+', '-', '@')) else str(v or '')
        allocation = ' | '.join(str(x.get('note') or CATEGORIES.get(x.get('category'),x.get('category') or '')) for x in row.get('allocations') or [])
        writer.writerow([text(row.get('bookingDate')), text(row.get('valueDate')), text(row.get('accountIban')), text(row.get('counterpartyName')), text(row.get('reference')), money(signed(row)), text(row.get('currency') or 'EUR'), 'zugeordnet' if row.get('status') == 'reconciled' else 'offen', money(row.get('remaining') or 0), text(allocation)])
    return '\ufeff' + target.getvalue()


def html_sheet(rows, account, month):
    title = ('Revolut' if account == 'personal' else 'Revolut Business') + ' · Monatskontoblatt ' + month[5:] + '/' + month[:4]
    totals = {}
    for row in rows:
        currency = str(row.get('currency') or 'EUR')
        bucket = totals.setdefault(currency, {'in': Decimal(0), 'out': Decimal(0)})
        bucket['out' if signed(row) < 0 else 'in'] += abs(signed(row))
    summary = ''.join('<p><strong>' + escape(currency) + '</strong> · Eingänge ' + money(total['in']) + ' · Ausgänge ' + money(total['out']) + ' · Veränderung ' + money(total['in'] - total['out']) + '</p>' for currency, total in sorted(totals.items()))
    body = ''
    for row in rows:
        allocation = ' · '.join(str(x.get('note') or CATEGORIES.get(x.get('category'),x.get('category') or '')) for x in row.get('allocations') or [])
        body += '<tr>' + ''.join('<td>' + escape(str(value or '')) + '</td>' for value in [row.get('bookingDate'), row.get('valueDate'), row.get('counterpartyName'), row.get('reference'), money(signed(row)), row.get('currency') or 'EUR', 'zugeordnet' if row.get('status') == 'reconciled' else 'offen', allocation]) + '</tr>'
    ibans = ' · '.join(sorted(set(row.get('accountIban') or '' for row in rows)))
    return '''<!doctype html><html lang="de"><head><meta charset="utf-8"><title>''' + escape(title) + '''</title><style>body{font:14px system-ui,sans-serif;color:#182019;margin:28px}h1{font-size:24px}table{width:100%;border-collapse:collapse}th,td{padding:8px;border-bottom:1px solid #ccc;text-align:left;overflow-wrap:anywhere}th{background:#edf4ef}td:nth-child(5){text-align:right;white-space:nowrap}button,a{display:inline-block;padding:10px 14px;margin:0 10px 15px 0;border:1px solid #aaa;border-radius:8px;color:#182019;text-decoration:none;background:#f3f6f2;cursor:pointer}.sub{color:#666}@media print{@page{size:A4 landscape;margin:12mm}.actions{display:none}body{margin:0;font-size:10px}thead{display:table-header-group}tr{break-inside:avoid}th{background:white}}</style></head><body><div class="actions"><button onclick="window.print()">Drucken / als PDF speichern</button><a href="?account=''' + account + '&month=' + month + '''&format=csv">CSV für Buchhaltung</a></div><h1>''' + escape(title) + '</h1><p>' + escape(ibans) + '</p><p class="sub">Gespeicherte Buchungen · Stand ' + datetime.now().strftime('%d.%m.%Y %H:%M') + ' · ' + str(len(rows)) + ' Buchung(en), einschließlich bereits zugeordneter Zahlungen.</p>' + summary + '<table><thead><tr><th>Datum</th><th>Valuta</th><th>Gegenpartei</th><th>Verwendungszweck</th><th>Betrag</th><th>Währung</th><th>Status</th><th>Zuordnung</th></tr></thead><tbody>' + (body or '<tr><td colspan="8">Keine gespeicherten Buchungen für diesen Monat.</td></tr>') + '</tbody></table></body></html>'


def install(ns):
    app = ns.get('app')
    if app is None or 'brain_revolut_monthly_statement' in app.view_functions:
        return
    from flask import request, Response, jsonify
    allowed = ns.get('MOBILE_ALLOWED_PATHS')
    if isinstance(allowed, set):
        allowed.add('/incoming/revolut/monthly-statement')

    @app.get('/incoming/revolut/monthly-statement')
    def brain_revolut_monthly_statement():
        try:
            handler = app.view_functions.get('brain_reconciliation_statements')
            if handler is None:
                raise ValueError('Bankabgleich ist nicht verfügbar.')
            response = app.make_response(handler())
            data = response.get_json(silent=True) or {}
            if response.status_code >= 400 or not data.get('ok'):
                raise ValueError(data.get('error') or 'Buchungen konnten nicht geladen werden.')
            account, month = request.args.get('account'), request.args.get('month')
            rows = monthly_rows(data.get('statements') or [], account, month)
            if request.args.get('format') == 'csv':
                response = Response(csv_sheet(rows), content_type='text/csv; charset=utf-8', headers={'Content-Disposition': f'attachment; filename="Revolut_{account}_{month}.csv"'})
            else:
                response = Response(html_sheet(rows, account, month), mimetype='text/html')
            response.headers['Cache-Control'] = 'private, no-store'
            return response
        except ValueError as error:
            return jsonify(ok=False, error=str(error)), 400
