import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ReservationApprovalService } from '../../reservationApproval/reservationApprovalService.ts';

class QueueDatabase {
  calls:string[]=[];
  async connect(){} async checkConnection(){}
  connection={execute:async(sql:string,params:any[])=>{
    this.calls.push(sql);
    if(sql.includes('COUNT(*) AS totalItems')) return [[{totalItems:27}]];
    if(sql.includes('ORDER BY r.id DESC')) { const match=sql.match(/LIMIT (\d+) OFFSET (\d+)/)!; const size=Number(match[1]); const offset=Number(match[2]); return [Array.from({length:Math.min(size,27-offset)},(_,i)=>({id:27-offset-i,status:'pending',decision_type:null,shadow_eligibility_outcome:null}))]; }
    throw new Error(`Unexpected queue query: ${sql} (${JSON.stringify(params)})`);
  }};
}

test('global operational queue paginates deterministically without losing recent nullable pending requests',async()=>{
  const db=new QueueDatabase(); const service=new ReservationApprovalService(db as any,{} as any,async()=>true);
  const first=await service.list(50,{status:'pending',page:1,pageSize:25}); const second=await service.list(50,{status:'pending',page:2,pageSize:25});
  assert.equal(first.totalItems,27); assert.equal(first.totalPages,2); assert.deepEqual(first.items.slice(0,2).map((x:any)=>x.id),[27,26]);
  assert.deepEqual(second.items.map((x:any)=>x.id),[2,1]);
  assert.equal(new Set([...first.items,...second.items].map((x:any)=>x.id)).size,27);
  const listSql=db.calls.find(sql=>sql.includes('ORDER BY r.id DESC'))!;
  assert.match(listSql,/LEFT JOIN reservation_semantic_evidence_links/); assert.match(listSql,/LEFT JOIN reservation_decisions/);
});

test('the queue is global: it never consults asset scopes and never filters by a per-asset predicate',async()=>{
  const db=new QueueDatabase(); const service=new ReservationApprovalService(db as any,{} as any,async()=>true);
  await service.list(50,{status:'all'});
  assert.ok(!db.calls.some(sql=>/reservation_management_scopes/.test(sql)),'global queue never consults asset scopes');
  assert.ok(!db.calls.some(sql=>/r\.asset_id IN/.test(sql)),'no per-asset scope predicate is applied');
});

test('an operational manager with zero active asset scopes still receives the full global queue',async()=>{
  const db=new QueueDatabase(); const service=new ReservationApprovalService(db as any,{} as any,async()=>true);
  const all=await service.list(51,{status:'all'});
  assert.equal(all.totalItems,27); assert.equal(all.items.length,25);
});

test('manager proxy and frontend expose totals/filtering/refresh and the route uses the operationalManagement capability',()=>{
  const proxy=fs.readFileSync(path.resolve(import.meta.dirname,'../../../front/app/api/manager/[...path]/route.ts'),'utf8');
  const page=fs.readFileSync(path.resolve(import.meta.dirname,'../../../front/app/(admin)/dashboard/reservations/page.tsx'),'utf8');
  assert.match(proxy,/cache:\s*'no-store'/); assert.match(proxy,/['"]Cache-Control['"]:\s*'no-store'/);
  assert.match(page,/\{rows\.length\} de \{pagination\.totalItems\} pedidos/); assert.match(page,/Atualizar fila/); assert.match(page,/Anterior/); assert.match(page,/Seguinte/);
  const route=fs.readFileSync(path.resolve(import.meta.dirname,'../../routes/managerReservations.ts'),'utf8');
  assert.match(route,/operationalManagement/); assert.match(route,/operational_management_required/);
  assert.doesNotMatch(route,/applicationArea\(/);
});

test('the reservation queue load is gated by confirmed operationalManagement (session resolved first)',()=>{
  const page=fs.readFileSync(path.resolve(import.meta.dirname,'../../../front/app/(admin)/dashboard/reservations/page.tsx'),'utf8');
  // An authorized flag defaults to false; the queue effect only loads when it is true.
  assert.match(page,/const \[authorized, setAuthorized\] = useState\(false\)/);
  assert.match(page,/if \(authorized\) void load/);
  assert.match(page,/\[authorized, page, statusFilter\]/);
  // Session is resolved first and drives the flag / redirects; no load before it.
  assert.match(page,/fetchSession\(\)\.then/);
  assert.match(page,/setAuthorized\(true\)/);
  assert.match(page,/status === 401[^\n]*"\/login"/);
  assert.match(page,/\.catch\(\(\) => \{ if \(!cancelled\) window\.location\.assign\("\/login"\)/);
  // A BIM-only account is redirected and never reaches the load.
  assert.match(page,/derived\.bimManagement \? "\/dashboard"/);
});
