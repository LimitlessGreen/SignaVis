function forbidden(res, message = 'forbidden') {
  return res.status(403).json({ error: 'forbidden', message });
}

async function resolveActor(pool, auth) {
  if (!auth) {
    return null;
  }

  const subject = auth.subject || null;
  const email = auth.email || null;

  if (!subject && !email) {
    return null;
  }

  const query = `
    SELECT id, external_auth_id AS "externalAuthId", email
    FROM users
    WHERE ($1::text IS NOT NULL AND external_auth_id = $1)
       OR ($2::text IS NOT NULL AND email = $2)
    ORDER BY created_at ASC
    LIMIT 1
  `;

  const result = await pool.query(query, [subject, email]);
  return result.rows[0] || null;
}

function hasRealmRole(auth, role) {
  const roles = Array.isArray(auth?.roles) ? auth.roles : [];
  return roles.includes(role);
}

async function hasTeamAccess(pool, teamId, userId) {
  const query = `
    SELECT 1
    FROM team_memberships
    WHERE team_id = $1 AND user_id = $2
    UNION
    SELECT 1
    FROM memberships
    WHERE team_id = $1 AND user_id = $2
    LIMIT 1
  `;
  const result = await pool.query(query, [teamId, userId]);
  return result.rowCount > 0;
}

async function hasProjectAccess(pool, projectId, userId) {
  const query = `
    SELECT 1
    FROM project_members
    WHERE project_id = $1 AND user_id = $2
    UNION
    SELECT 1
    FROM projects p
    JOIN team_memberships tm ON tm.team_id = p.team_id
    WHERE p.id = $1 AND tm.user_id = $2
    UNION
    SELECT 1
    FROM projects p
    JOIN memberships m ON m.team_id = p.team_id
    WHERE p.id = $1 AND m.user_id = $2
    LIMIT 1
  `;
  const result = await pool.query(query, [projectId, userId]);
  return result.rowCount > 0;
}

export async function checkProjectScope(pool, auth, actor, projectId) {
  if (!projectId || !actor) {
    return false;
  }
  if (hasRealmRole(auth, 'platform_admin')) {
    return true;
  }
  return hasProjectAccess(pool, projectId, actor.id);
}

export function createRbacMiddleware(pool) {
  async function requireActor(req, res, next) {
    try {
      if (!req.auth) {
        return forbidden(res, 'missing auth context');
      }
      const actor = await resolveActor(pool, req.auth);
      if (!actor) {
        return forbidden(res, 'no mapped platform user for token subject/email');
      }
      req.actor = actor;
      return next();
    } catch (err) {
      return res.status(500).json({ error: 'rbac_error', message: err.message });
    }
  }

  async function requireTeamScope(req, res, next) {
    const teamId = req.query.teamId || req.body?.teamId;
    if (!teamId) {
      return res.status(400).json({ error: 'teamId is required for scope check' });
    }

    if (hasRealmRole(req.auth, 'platform_admin')) {
      return next();
    }

    try {
      const ok = await hasTeamAccess(pool, teamId, req.actor.id);
      if (!ok) {
        return forbidden(res, 'team scope denied');
      }
      return next();
    } catch (err) {
      return res.status(500).json({ error: 'rbac_error', message: err.message });
    }
  }

  async function requireProjectScope(req, res, next) {
    const projectId = req.params.projectId || req.query.projectId || req.body?.projectId;
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required for scope check' });
    }

    if (hasRealmRole(req.auth, 'platform_admin')) {
      return next();
    }

    try {
      const ok = await hasProjectAccess(pool, projectId, req.actor.id);
      if (!ok) {
        return forbidden(res, 'project scope denied');
      }
      return next();
    } catch (err) {
      return res.status(500).json({ error: 'rbac_error', message: err.message });
    }
  }

  return {
    requireActor,
    requireTeamScope,
    requireProjectScope,
  };
}
