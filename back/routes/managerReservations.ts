import express from 'express';
import { buildErrorResponse } from '../utils/responseHandler.ts';
import { applicationIdentityRuntime } from '../applicationIdentity/applicationIdentityMiddleware.ts';
import { ReservationApprovalService } from '../reservationApproval/reservationApprovalService.ts';
import { loadReservationApprovalConfig } from '../reservationApproval/reservationApprovalConfig.ts';
import { runManagerRequest } from '../reservationApproval/managerApiContract.ts';
import { ApplicationIdentityDatabase } from '../applicationIdentity/applicationIdentityDatabase.ts';
const router=express.Router(); router.use(express.json()); const service=new ReservationApprovalService();
async function identity(req:express.Request,res:express.Response){ if(!loadReservationApprovalConfig().enabled){ buildErrorResponse(res,404,'Reservation management is disabled.','reservation_management_disabled'); return null;} if(applicationIdentityRuntime().config.mode!=='local_session'||!req.applicationIdentity){ buildErrorResponse(res,401,'A manager session is required.','manager_session_required'); return null;} const accountId=req.applicationIdentity.accountId as number; if(await new ApplicationIdentityDatabase().applicationArea(accountId)!=='manager'){ buildErrorResponse(res,403,'This workspace is available only to an active reservation manager.','manager_role_required'); return null;} return {accountId,sessionUuid:req.applicationIdentity.sessionUuid as string}; }
router.get('/reservations',async(req,res)=>{const i=await identity(req,res);if(i)return runManagerRequest(res,()=>service.list(i.accountId,{page:req.query.page,pageSize:req.query.pageSize,status:req.query.status}));});
router.get('/reservations/:reservationId',async(req,res)=>{const i=await identity(req,res);if(i)return runManagerRequest(res,()=>service.detail(i.accountId,i.sessionUuid,Number(req.params.reservationId)));});
router.post('/reservations/:reservationId/refresh-evidence',async(req,res)=>{const i=await identity(req,res);if(i)return runManagerRequest(res,()=>service.reviewReservation(i.accountId,i.sessionUuid,Number(req.params.reservationId),true));});
for(const kind of ['approve','reject','cancel'] as const) router.post(`/reservations/:reservationId/${kind}`,async(req,res)=>{const i=await identity(req,res);if(i)return runManagerRequest(res,()=>service.decide(i.accountId,i.sessionUuid,Number(req.params.reservationId),kind==='approve'?'approved':kind==='reject'?'rejected':'cancelled',req.body??{}));});
export default router;
