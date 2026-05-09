function forbidden(res, message = 'forbidden') {
  return res.status(403).json({ error: 'forbidden', message });
}

const PROJECT_ROLE_RANK = {
  viewer: 1,
  reviewer: 2,
  annotator: 3,
  manager: 4,
  owner: 5,
};

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

async function resolveProjectRole(pool, projectId, userId) {
  const query = `
    WITH direct_member AS (
      SELECT pm.role
      FROM project_members pm
      WHERE pm.project_id = $1
        AND pm.user_id = $2
      LIMIT 1
    ),
    team_member AS (
      SELECT CASE
               WHEN COALESCE(tm.is_admin, false) OR COALESCE(m.is_admin, false) THEN 'manager'
               ELSE 'viewer'
             END AS role
      FROM projects p
      LEFT JOIN team_memberships tm
        ON tm.team_id = p.team_id AND tm.user_id = $2
      LEFT JOIN memberships m
        ON m.team_id = p.team_id AND m.user_id = $2
      WHERE p.id = $1
        AND (tm.user_id IS NOT NULL OR m.user_id IS NOT NULL)
      LIMIT 1
    )
    SELECT role
    FROM direct_member
    UNION ALL
    SELECT role
    FROM team_member
    LIMIT 1
  `;

  const result = await pool.query(query, [projectId, userId]);
  return result.rows[0]?.role || null;
}

function hasRequiredProjectRole(currentRole, requiredRole) {
  const currentRank = PROJECT_ROLE_RANK[currentRole] || 0;
  const requiredRank = PROJECT_ROLE_RANK[requiredRole] || Number.MAX_SAFE_INTEGER;
  return currentRank >= requiredRank;
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

export async function checkProjectRole(pool, auth, actor, projectId, requiredRole = 'viewer') {
  if (!projectId || !actor) {
    return { ok: false, role: null };
  }
  if (hasRealmRole(auth, 'platform_admin')) {
    return { ok: true, role: 'owner' };
  }

  const role = await resolveProjectRole(pool, projectId, actor.id);
  if (!role) {
    return { ok: false, role: null };
  }
  return {
    ok: hasRequiredProjectRole(role, requiredRole),
    role,
  };
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
      const role = await resolveProjectRole(pool, projectId, req.actor.id);
      if (!role) {
        return forbidden(res, 'project scope denied');
      }
      req.projectRole = role;
      return next();
    } catch (err) {
      return res.status(500).json({ error: 'rbac_error', message: err.message });
    }
  }

  function requireProjectRole(minRole = 'viewer') {
    return async (req, res, next) => {
      const projectId = req.params.projectId || req.query.projectId || req.body?.projectId;
      if (!projectId) {
        return res.status(400).json({ error: 'projectId is required for role check' });
      }

      if (hasRealmRole(req.auth, 'platform_admin')) {
        req.projectRole = 'owner';
        return next();
      }

      try {
        const role = req.projectRole || await resolveProjectRole(pool, projectId, req.actor.id);
        if (!role) {
          return forbidden(res, 'project scope denied');
        }
        if (!hasRequiredProjectRole(role, minRole)) {
          return forbidden(res, `project role \"${minRole}\" required`);
        }
        req.projectRole = role;
        return next();
      } catch (err) {
        return res.status(500).json({ error: 'rbac_error', message: err.message });
      }
    };
  }

  return {
    requireActor,
    requireTeamScope,
    requireProjectScope,
    requireProjectRole,
  };
}
