'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{stampDecision}=require('../camper-project');
test('form and table answers record decision date, time and actor independently',()=>{
 const now='2026-10-28T23:30:00Z',value={answerEgon:'Fenster schwarz',answerElio:'',decisionStatusEgon:'offen',decidedEgon:''};
 stampDecision('tasks',value,{answerEgon:'',answerElio:''},{name:'Egon'},now);assert.equal(value.decidedEgon,'2026-10-29');assert.equal(value.answeredAtEgon,now);assert.equal(value.answeredByEgon,'Egon');assert.equal(value.decisionStatusEgon,'entschieden');assert.equal(value.answeredAtElio,'');
 const unchanged={...value};stampDecision('tasks',unchanged,value,{name:'Alexander'},'2026-11-01T12:00:00Z');assert.equal(unchanged.answeredAtEgon,now);assert.equal(unchanged.answeredByEgon,'Egon');
 const old={answerEgon:'Schon entschieden',answerElio:''};stampDecision('decisions',old,{answerEgon:'Schon entschieden',answerElio:''},{name:'Alexander'},now);assert.equal(old.answeredAtEgon,'');assert.equal(old.decidedEgon,undefined);
 const clear={...value,answerEgon:''};stampDecision('decisions',clear,value,{name:'Alexander'},now);assert.equal(clear.answeredAtEgon,'');assert.equal(clear.decidedEgon,'');assert.equal(clear.decisionStatusEgon,'offen');
 const yes={answerEgon:'',answerElio:'',choiceEgon:'ja'};stampDecision('decisions',yes,null,{name:'Egon'},now);assert.equal(yes.answerEgon,'Ja');assert.equal(yes.decisionStatusEgon,'entschieden');assert.equal(yes.answeredByEgon,'Egon');
 const no={...yes,choiceEgon:'nein'};stampDecision('decisions',no,yes,{name:'Egon'},now);assert.equal(no.answerEgon,'Nein');
 const reopen={...no,choiceEgon:''};stampDecision('decisions',reopen,no,{name:'Egon'},now);assert.equal(reopen.answerEgon,'');assert.equal(reopen.decisionStatusEgon,'offen');
});
