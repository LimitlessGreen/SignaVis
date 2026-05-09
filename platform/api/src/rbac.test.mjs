import test from 'node:test';
import assert from 'node:assert/strict';

import { checkProjectRole, createRbacMiddleware } from './rbac.js';

function makePool(queryImpl) {
  return {
    query: queryImpl,
  };
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test('checkProjectRole allows platform_admin without DB lookup', async () => {
  const pool = makePool(async () => {
    throw new Error('DB query should not be called for platform_admin');
  });

  const result = await checkProjectRole(
    pool,
    { roles: ['platform_admin'] },
    { id: 'u1' },
    'p1',
    'manager',
  );

  assert.equal(result.ok, true);
  assert.equal(result.role, 'owner');
});

test('checkProjectRole enforces minimum role rank', async () => {
  const pool = makePool(async (sql) => {
    if (String(sql).includes('WITH direct_member')) {
      return { rows: [{ role: 'viewer' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  const denied = await checkProjectRole(pool, { roles: [] }, { id: 'u1' }, 'p1', 'annotator');
  assert.equal(denied.ok, false);
  assert.equal(denied.role, 'viewer');

  const allowed = await checkProjectRole(pool, { roles: [] }, { id: 'u1' }, 'p1', 'viewer');
  assert.equal(allowed.ok, true);
  assert.equal(allowed.role, 'viewer');
});

test('requireProjectScope resolves role and requireProjectRole blocks insufficient role', async () => {
  const pool = makePool(async (sql) => {
    if (String(sql).includes('WITH direct_member')) {
      return { rows: [{ role: 'viewer' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  const rbac = createRbacMiddleware(pool);
  const req = {
    params: { projectId: 'p1' },
    query: {},
    body: {},
    auth: { roles: [] },
    actor: { id: 'u1' },
  };
  const res = makeRes();

  let scopeNextCalled = false;
  await rbac.requireProjectScope(req, res, () => {
    scopeNextCalled = true;
  });

  assert.equal(scopeNextCalled, true);
  assert.equal(req.projectRole, 'viewer');

  const requireAnnotator = rbac.requireProjectRole('annotator');
  let roleNextCalled = false;
  await requireAnnotator(req, res, () => {
    roleNextCalled = true;
  });

  assert.equal(roleNextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body?.error, 'forbidden');
  assert.match(String(res.body?.message || ''), /project role "annotator" required/i);
});
