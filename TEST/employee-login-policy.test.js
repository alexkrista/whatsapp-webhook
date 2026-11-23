"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {personalLoginAllowed}=require("../employee-login-policy");
test("restricted login adds only explicitly configured full names",()=>{
 process.env.KRISTINE_PERSONAL_LOGIN_ENABLED="alexander";
 process.env.KRISTINE_PERSONAL_LOGIN_ADDITIONAL_NAMES="Dunja Türtscher|Bettina Eberle-Nigsch|Clemens Krista|Judith Krista";
 for(const name of ["Alexander Krista","Dunja Türtscher","Bettina Eberle-Nigsch","Clemens Krista","Judith Krista"]){
   assert.equal(personalLoginAllowed({name}),true);
 }
 for(const name of ["Dunja","Dunja Muster","Johannes Wiederin"]){
   assert.equal(personalLoginAllowed({name}),false);
 }
 assert.equal(personalLoginAllowed({name:"Judith Krista",active:false}),false);
});
