const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const address=require('../public/ui/project-address');
const expected={street:'Mariagrünerstr.',houseNumber:'30',postalCode:'6820',city:'Frastanz'};
test('WW-Adresse ohne Komma wird vollständig zerlegt',()=>assert.deepEqual(address.parse('Mariagrünerstr. 30 6820 Frastanz'),expected));
test('Kommas, Zeilenumbrüche und getrennte Hausnummer bleiben unterstützt',()=>{
 for(const raw of ['Mariagrünerstr. 30, 6820 Frastanz','Mariagrünerstr. 30\n6820 Frastanz','Mariagrünerstr., 30, 6820 Frastanz'])assert.deepEqual(address.parse(raw),expected);
 assert.deepEqual(address.parse('Am 3. Weg 12a/2 6800 Feldkirch'),{street:'Am 3. Weg',houseNumber:'12a/2',postalCode:'6800',city:'Feldkirch'});
});
test('Strukturierte WW-Felder haben Vorrang vor dem Freitext',()=>assert.deepEqual(address.parse({address:'Andere Straße 8 6700 Bludenz',...expected}),expected));
test('Unvollständige Adresse erzeugt keine erfundene PLZ oder Hausnummer',()=>assert.deepEqual(address.parse('Bergweg'),{street:'Bergweg',houseNumber:'',postalCode:'',city:''}));
test('Echte Kundenauswahl füllt die vier Neuanlagefelder und behält WW-Verknüpfung',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../public/kristine.html'),'utf8'),a=html.indexOf('function splitQuickWwAddress('),b=html.indexOf('\nfunction ',html.indexOf('function selectQuickWwCustomer(',a)+10),fields={};
 const ctx={window:{KristaProjectAddress:address},document:{getElementById:id=>fields[id]||=({value:'',innerHTML:''})},esc:x=>x};vm.createContext(ctx);vm.runInContext(html.slice(a,b),ctx);
 ctx.selectQuickWwCustomer({name:'Angela Wiederin',address:'Mariagrünerstr. 30 6820 Frastanz',customerIndex:11199,customerNumber:11282});
 assert.equal(fields.quickNewStreet.value,expected.street);assert.equal(fields.quickNewHouse.value,'30');assert.equal(fields.quickNewPostal.value,'6820');assert.equal(fields.quickNewCity.value,'Frastanz');assert.equal(fields.quickWwAddressId.value,'11199');assert.equal(fields.quickWwCustomerNumber.value,'11282');
});
