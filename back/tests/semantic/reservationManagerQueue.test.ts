import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ReservationApprovalService } from '../../reservationApproval/reservationApprovalService.ts';

class QueueDatabase {
  calls:string[]=[];
  constructor(private scoped=true) {}
  async connect(){} async checkConnection(){}
  connection={execute:async(sql:string,params:any[])=>{
    this.calls.push(sql);
    if(sql.includes('FROM reservation_management_scopes')) return [this.scoped?[{asset_id:3},{asset_id:9}]:[]];
    if(sql.includes('COUNT(*) AS totalItems')) return [[{totalItems:27}]];
    if(sql.includes('ORDER BY r.id DESC')) { const match=sql.match(/LIMIT (\d+) OFFSET (\d+)/)!; const size=Number(match[1]); const offset=Number(match[2]); return [Array.from({length:Math.min(size,27-offset)},(_,i)=>({id:27-offset-i,status:'pending',decision_type:null,shadow_eligibility_outcome:null}))]; }
    throw new Error(`Unexpected queue query: ${sql}`);
  }};
}

test('manager queue paginates deterministically without losing recent nullable pending requests',async()=>{
  const db=new QueueDatabase(); const service=new ReservationApprovalService(db as any,{} as any,async()=>true);
  const first=await service.list(50,{status:'pending',page:1,pageSize:25}); const second=await service.list(50,{status:'pending',page:2,pageSize:25});
  assert.equal(first.totalItems,27); assert.equal(first.totalPages,2); assert.deepEqual(first.items.slice(0,2).map((x:any)=>x.id),[27,26]);
  assert.deepEqual(second.items.map((x:any)=>x.id),[2,1]);
  assert.equal(new Set([...first.items,...second.items].map((x:any)=>x.id)).size,27);
  const listSql=db.calls.find(sql=>sql.includes('ORDER BY r.id DESC'))!;
  assert.match(listSql,/LEFT JOIN reservation_semantic_evidence_links/); assert.match(listSql,/LEFT JOIN reservation_decisions/);
});

test('manager queue applies scope to count and items and rejects an account without scope',async()=>{
  const db=new QueueDatabase(); const service=new ReservationApprovalService(db as any,{} as any,async()=>true); await service.list(50,{status:'all'});
  const scoped=db.calls.filter(sql=>sql.includes('r.asset_id IN'));
  assert.equal(scoped.length,2,'count and list use the same scope predicate');
  const denied=new ReservationApprovalService(new QueueDatabase(false) as any,{} as any,async()=>true);
  await assert.rejects(()=>denied.list(51), (error:any)=>error.httpStatus===403);
});

test('manager proxy and frontend explicitly disable cache and expose totals, filtering, refresh and navigation',()=>{
  const proxy=fs.readFileSync(path.resolve(import.meta.dirname,'../../../front/app/api/manager/[...path]/route.ts'),'utf8');
  const page=fs.readFileSync(path.resolve(import.meta.dirname,'../../../front/app/(admin)/dashboard/reservations/page.tsx'),'utf8');
  assert.match(proxy,/cache:\s*'no-store'/); assert.match(proxy,/['"]Cache-Control['"]:\s*'no-store'/);
  assert.match(page,/\{rows\.length\} de \{pagination\.totalItems\} pedidos/); assert.match(page,/Atualizar fila/); assert.match(page,/Anterior/); assert.match(page,/Seguinte/);
});
