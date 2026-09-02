export function isProjectPoolV2Enabled() {
  return process.env.PROJECT_POOL_V2_ENABLED?.trim().toLowerCase() !== 'false';
}

export function isPublicProjectPoolV2Enabled() {
  return process.env.NEXT_PUBLIC_PROJECT_POOL_V2_ENABLED?.trim().toLowerCase() !== 'false';
}
