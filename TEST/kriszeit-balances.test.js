"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {calculate,weeklySurcharges}=require("../kriszeit-balances");
const employee={id:"cathrin",personnelNumber:"276"};
test("approved October balances and November opening are preserved for every employee",()=>{
  for(const [pnr,time,vacation] of [[60,817,38.33],[384,30.65,7.77],[26,41.18,5.12],[276,50.61,8.17],[18,5.50,4.08],[39,-1.28,0],[139,55.84,5.09],[54,0,7.50],[14,69.05,19.06],[402,3.23,3.17],[20,1.67,0]]){
    const e={id:String(pnr),personnelNumber:String(pnr)};
    const oct=calculate(e,"2026-10",[],{},null,null);
    assert.equal(oct.newTime,time);assert.equal(oct.newVacation,vacation);
    const nov=calculate(e,"2026-11",[],{balanceMinutes:0},{monthlyDays:25/12},null);
    assert.equal(nov.openingTime,time);assert.equal(nov.openingVacation,vacation);
  }
});
test("vacation accrues monthly without resetting on anniversary; corrections and transfers remain separate",()=>{
  const adjustment={employeeId:"cathrin",month:"2026-11",kind:"correction",timeHours:1,vacationDays:-.5};
  const transfer={employeeId:"cathrin",from:"2026-11-01",type:"monthly_transfer",minutes:120,note:"Umbuchung Zeitkonto in ZA alt"};
  const nov=calculate(employee,"2026-11",[],{balanceMinutes:180,vacation:.5},{monthlyDays:25/12},{z10:5,z50:2},[adjustment],[transfer]);
  assert.equal(nov.newTime,52.61);assert.equal(nov.transferTime,-2);assert.equal(nov.correctionTime,1);
  assert.ok(Math.abs(nov.newVacation-(8.17+25/12-1))<1e-10);
  const dec=calculate(employee,"2026-12",[{employeeId:"cathrin",month:"2026-11",report:{balances:nov}}],{balanceMinutes:0,vacation:0},{monthlyDays:2.5},null);
  assert.equal(dec.openingTime,nov.newTime);assert.equal(dec.openingVacation,nov.newVacation);
  assert.equal(dec.newVacation,nov.newVacation+2.5);
  assert.equal(calculate(employee,"2026-12",[],{},null,null).newTime,null);
});
test("calendar-week thresholds allocate only the in-month increment, never duplicate a prior month",()=>{
  const days=[{date:"2026-10-26",minutes:2400},{date:"2026-10-31",minutes:240},{date:"2026-11-01",minutes:180},{date:"2026-11-02",minutes:600}];
  assert.deepEqual(weeklySurcharges(days,"2026-10-01","2026-10-31"),{z10:4,z50:0});
  assert.deepEqual(weeklySurcharges(days,"2026-11-01","2026-11-30"),{z10:1,z50:2});
});
