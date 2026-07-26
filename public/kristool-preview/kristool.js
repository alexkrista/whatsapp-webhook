const steps = [...document.querySelectorAll('.step')];
const toast = document.getElementById('toast');
const release = document.getElementById('releaseButton');
const hint = document.getElementById('approvalHint');
let completed = new Set(['gps','office']);

function updateApproval(){
  const needed = ['gps','office','report','material'];
  const left = needed.filter(x => !completed.has(x)).length;
  hint.textContent = left ? `Noch ${left} Schritte offen.` : 'Alle Prüfschritte vollständig.';
  release.disabled = left > 0;
  if (!left) {
    document.querySelector('[data-step="result"] .state').textContent = 'bereit';
    document.querySelector('[data-step="result"] .state').className = 'state done';
  }
}

steps.forEach(step => {
  step.querySelector('.step-title').addEventListener('click', e => {
    if (e.target.closest('select,button:not(.step-title)')) return;
    step.classList.toggle('open');
    step.querySelector('.chevron').textContent = step.classList.contains('open') ? '⌃' : '⌄';
  });
});

document.getElementById('applyCopy').addEventListener('click', () => {
  const sel = document.getElementById('copyFrom');
  if (!sel.value) return;
  document.querySelectorAll('.compare-card.final input')[0].value = '07:00–11:58';
  document.querySelectorAll('.compare-card.final input')[1].value = '12:38–17:01';
  toast.textContent = `✓ Korrektur von ${sel.options[sel.selectedIndex].text.replace(' ⭐','')} übernommen.`;
  toast.classList.add('show');
  setTimeout(()=>toast.classList.remove('show'),2200);
});

document.querySelectorAll('.mark-complete').forEach(btn => {
  btn.addEventListener('click', () => {
    const step = btn.closest('.step');
    const key = step.dataset.step;
    completed.add(key);
    const state = step.querySelector('.state');
    state.textContent = 'geprüft';
    state.className = 'state done';
    updateApproval();
    step.classList.remove('open');
    step.querySelector('.chevron').textContent = '⌄';
    const next = step.nextElementSibling;
    if (next?.classList.contains('step')) {
      next.classList.add('open');
      next.querySelector('.chevron').textContent = '⌃';
    }
  });
});

release.addEventListener('click', () => {
  document.querySelectorAll('.result-list b').forEach(b => {b.textContent='✓'; b.style.color='#2d8f42'});
  toast.textContent = '✓ Arbeitstag freigegeben. Ergebnisse wurden erzeugt.';
  toast.classList.add('show');
  setTimeout(()=>toast.classList.remove('show'),2800);
});

document.getElementById('showDetails').addEventListener('click', () => {
  document.querySelector('[data-step="gps"]').classList.add('open');
  window.scrollTo({top:180, behavior:'smooth'});
});

updateApproval();
