'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('shared product header is sticky on desktop and mobile, with planning below it', () => {
  const css = read('public/ui/krista-ui.css');
  assert.match(css, /\.krista-shell-topbar\{\s*position:sticky;\s*top:0;/);
  assert.match(css, /@media\(max-width:760px\)[\s\S]*?\.krista-shell-topbar\{position:sticky!important;top:0!important\}/);
  assert.match(css, /\.planning-top\{top:var\(--krista-topbar-height,0px\)!important\}/);
  assert.match(css, /\.planning-calendar-toolbar\{top:calc\(var\(--krista-topbar-height,0px\) \+ var\(--planning-sticky-top,0px\)\)!important\}/);
  assert.match(css, /\.dayhead\{top:var\(--krista-topbar-height,0px\)!important\}/);
});

test('topbar measures expanded mobile menu and exposes the shared sticky offset', () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="kristaTopbar" data-krista-active="kristine"></div></body></html>', {
    url: 'https://protokoll.krista.at/kristine#planning',
    runScripts: 'outside-only'
  });
  try {
    const { window } = dom;
    const mount = window.document.getElementById('kristaTopbar');
    let height = 76;
    mount.getBoundingClientRect = () => ({ height });
    let observer;
    window.ResizeObserver = class {
      constructor(callback) { this.callback = callback; observer = this; }
      observe(element) { this.element = element; }
    };
    window.eval(read('public/ui/topbar.js'));
    window.createKristaTopbar({ active: 'kristine', build: '2.0-test' });

    assert.equal(window.document.documentElement.style.getPropertyValue('--krista-topbar-height'), '76px');
    assert.equal(observer.element, mount);
    assert.equal(mount.querySelectorAll('.krista-world-nav').length, 1);
    assert.equal(mount.querySelectorAll('.krista-world-link.active').length, 1);
    for (const label of ['KRISTOWER', 'KRISZEIT', 'KRISDRIVE', 'THE BRAIN', 'LG', 'KRISTINE', 'KRISADMIN', 'AUFGABEN']) {
      assert.ok(mount.textContent.includes(label), label + ' not reachable from global header');
    }

    const menu = mount.querySelector('.krista-mobile-menu');
    height = 260;
    menu.click();
    assert.equal(menu.getAttribute('aria-expanded'), 'true');
    assert.equal(window.document.documentElement.style.getPropertyValue('--krista-topbar-height'), '260px');

    height = 54;
    menu.click();
    assert.equal(menu.getAttribute('aria-expanded'), 'false');
    assert.equal(window.document.documentElement.style.getPropertyValue('--krista-topbar-height'), '54px');

    height = 88;
    observer.callback();
    assert.equal(window.document.documentElement.style.getPropertyValue('--krista-topbar-height'), '88px');
  } finally {
    dom.window.close();
  }
});

test('Brain uses the same sticky header and includes the Krisdrive destination', () => {
  const brain = read('brain_finance_header.py');
  assert.match(brain, /\.krista-shell-topbar\{position:sticky;top:0;/);
  assert.match(brain, /krisdrive_url = render_url\("\/public\/krisdrive\.html"/);
  assert.match(brain, /href="\{krisdrive_url\}"[^\n]*KRISDRIVE/);
  assert.match(brain, /max-height:min\(65dvh,540px\)/);
});
