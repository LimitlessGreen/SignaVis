function hasPlatformAdminRole(auth) {
  const roles = Array.isArray(auth?.roles) ? auth.roles : [];
  return roles.includes('platform_admin');
}

export function enforceActorIdentity(req, res, userId, fieldName) {
  if (!userId) {
    return {
      ok: false,
      response: res.status(400).json({ error: `${fieldName} is required` }),
    };
  }

  if (hasPlatformAdminRole(req.auth)) {
    return { ok: true };
  }

  if (!req.actor?.id || userId !== req.actor.id) {
    return {
      ok: false,
      response: res.status(403).json({
        error: 'forbidden',
        message: `${fieldName} must match authenticated actor`,
      }),
    };
  }

  return { ok: true };
}
