export function loadReservationApprovalConfig(env: NodeJS.ProcessEnv = process.env) {
  const enabled=env.RESERVATION_APPROVAL_ENABLED==='true'; const managerUiEnabled=env.RESERVATION_MANAGER_UI_ENABLED==='true';
  const localSetupEnabled=env.LOCAL_SYNTHETIC_MANAGER_SETUP_ENABLED==='true'; const production=env.NODE_ENV==='production';
  if(production && (enabled||managerUiEnabled||localSetupEnabled)) throw new Error('Local reservation approval demonstration is refused in production.');
  return {enabled,managerUiEnabled,localSetupEnabled,production};
}
