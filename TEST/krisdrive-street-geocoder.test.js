"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createStreetLookup, streetFromPhoton } = require("../krisdrive-street-geocoder");
const point = {lat:47.222,lng:9.61};
const feature = (properties={},coordinates=[9.61,47.222]) => ({type:"Feature",geometry:{type:"Point",coordinates},properties:{city:"Frastanz",postcode:"6820",...properties}});
const missing = () => { throw Object.assign(Error("empty"),{code:"empty_address"}); };

test("street without a house number works; localities, coordinates and distant roads are rejected", () => {
  assert.equal(streetFromPhoton({features:[feature({osm_key:"highway",name:"Rungeldonweg"})]},point),"Rungeldonweg, 6820 Frastanz");
  assert.equal(streetFromPhoton({features:[feature({street:"Walgaustraße",housenumber:"47"})]},point),"Walgaustraße, 6820 Frastanz");
  assert.equal(streetFromPhoton({features:[feature({name:"Frastanz",osm_key:"place"})]},point),"");
  assert.equal(streetFromPhoton({features:[feature({street:"Falsche Straße"},[10,48])]},point),"");
  assert.equal(streetFromPhoton({features:[feature({street:"Falsche Straße"},["9.61",47.222])]},point),"");
});

test("Traccar is preferred; failures use a credential-free fallback", async () => {
  let called=0;
  const request=async(url,opts)=>{
    called++; assert.equal(opts.headers.Authorization,undefined);
    assert.match(opts.headers["User-Agent"],/Kristine/);
    assert.deepEqual([...new URL(url).searchParams.keys()].sort(),["lang","lat","limit","lon","radius"]);
    return {ok:true,json:async()=>({features:[feature({street:"Walgaustraße"})]})};
  };
  const primary=createStreetLookup({primary:async()=>"Bahnhofstraße, 6800 Feldkirch",request});
  assert.equal((await primary(point)).provider,"traccar"); assert.equal(called,0);
  const fallback=createStreetLookup({primary:missing,request});
  assert.equal((await fallback(point)).address,"Walgaustraße, 6820 Frastanz");assert.equal(called,1);
  const unauth=createStreetLookup({primary:()=>{throw Object.assign(Error("unauthorized"),{status:401})},request});
  await assert.rejects(unauth(point));assert.equal(called,1);
});

test("fallback requests are serialized and rate limited, including provider cooldown", async () => {
  let now=1000, active=0, maximum=0;const waits=[],stamps=[];
  const request=async()=>{active++;maximum=Math.max(maximum,active);stamps.push(now);await Promise.resolve();active--;return{ok:true,json:async()=>({features:[feature({street:"Walgaustraße"})]})}};
  const lookup=createStreetLookup({primary:missing,request,clock:()=>now,wait:async delay=>{waits.push(delay);now+=delay}});
  await Promise.all([lookup(point),lookup(point),lookup(point)]);
  assert.equal(maximum,1);assert.deepEqual(stamps,[1000,6000,11000]);assert.deepEqual(waits,[5000,5000]);
  let calls=0;
  const limited=createStreetLookup({primary:missing,clock:()=>now,wait:async delay=>{now+=delay},request:async()=>{calls++;return{ok:false,status:429}}});
  await assert.rejects(limited(point));await assert.rejects(limited(point));assert.equal(calls,1);
});

test("fallback can be switched off and invalid endpoints are rejected", async()=>{
  const disabled=createStreetLookup({primary:missing,fallbackUrl:"",request:()=>{throw Error("must not request")}});
  await assert.rejects(disabled(point),e=>e.code==="empty_address");
  assert.throws(()=>createStreetLookup({primary:missing,fallbackUrl:"http://example.org/reverse"}));
});
