import test from 'node:test';
import assert from 'node:assert/strict';

import { createRbacMiddleware } from './rbac.js';

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

function makePool({ actorId = 'u1', role = 'viewer' } = {}) {
  return {
    async query(sql) {
      const statement = String(sql);

      if (statement.includes('FROM users')) {
        return {
          rows: [{ id: actorId, externalAuthId: actorId, email: `${actorId}@example.test` }],
          rowCount: 1,
        };
      }

      if (statement.includes('WITH direct_member')) {
        return {
          rows: role ? [{ role }] : [],
          rowCount: role ? 1 : 0,
        };
      }

      return { rows: [], rowCount: 0 };
    },
  };
}

async function runMiddleware(mw, req, res) {
  let nextCalled = false;
  await mw(req, res, () => {
    nextCalled = true;
  });
  return nextCalled;
}

test('route flow: viewer can access viewer-protected endpoint', async () => {
  const rbac = createRbacMiddleware(makePool({ role: 'viewer' }));
  const req = {
    params: { projectId: 'p1' },
    query: {},
    body: {},
    auth: { subject: 'u1', email: 'u1@example.test', roles: [] },
  };
  const res = makeRes();

  assert.equal(await runMiddleware(rbac.requireActor, req, res), true);
  assert.equal(await runMiddleware(rbac.requireProjectScope, req, res), true);

  const requireViewer = rbac.requireProjectRole('viewer');
  assert.equal(await runMiddleware(requireViewer, req, res), true);
  assert.equal(req.projectRole, 'viewer');
  assert.equal(res.statusCode, 200);
});

test('route flow: viewer is denied annotator-protected endpoint', async () => {
  const rbac = createRbacMiddleware(makePool({ role: 'viewer' }));
  const req = {
    params: { projectId: 'p1' },
    query: {},
    body: {},
    auth: { subject: 'u1', email: 'u1@example.test', roles: [] },
  };
  const res = makeRes();

  assert.equal(await runMiddleware(rbac.requireActor, req, res), true);
  assert.equal(await runMiddleware(rbac.requireProjectScope, req, res), true);

  const requireAnnotator = rbac.requireProjectRole('annotator');
  assert.equal(await runMiddleware(requireAnnotator, req, res), false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body?.error, 'forbidden');
  assert.match(String(res.body?.message || ''), /project role "annotator" required/i);
});

test('route flow: manager can access manager-protected endpoint', async () => {
  const rbac = createRbacMiddleware(makePool({ role: 'manager' }));
  const req = {
    params: { projectId: 'p1' },
    query: {},
    body: {},
    auth: { subject: 'u1', email: 'u1@example.test', roles: [] },
  };
  const res = makeRes();

  assert.equal(await runMiddleware(rbac.requireActor, req, res), true);
  assert.equal(await runMiddleware(rbac.requireProjectScope, req, res), true);

  const requireManager = rbac.requireProjectRole('manager');
  assert.equal(await runMiddleware(requireManager, req, res), true);
  assert.equal(req.projectRole, 'manager');
  assert.equal(res.statusCode, 200);
});
