import test from 'node:test';
import assert from 'node:assert/strict';

import { enforceActorIdentity } from './identity.js';

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

test('enforceActorIdentity returns 400 when field is missing', () => {
  const req = { auth: { roles: [] }, actor: { id: 'u1' } };
  const res = makeRes();

  const result = enforceActorIdentity(req, res, '', 'createdBy');
  assert.equal(result.ok, false);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body?.error, 'createdBy is required');
});

test('enforceActorIdentity allows platform_admin override', () => {
  const req = { auth: { roles: ['platform_admin'] }, actor: { id: 'u1' } };
  const res = makeRes();

  const result = enforceActorIdentity(req, res, 'someone-else', 'createdBy');
  assert.equal(result.ok, true);
  assert.equal(res.statusCode, 200);
});

test('enforceActorIdentity returns 403 on actor mismatch for non-admin', () => {
  const req = { auth: { roles: [] }, actor: { id: 'u1' } };
  const res = makeRes();

  const result = enforceActorIdentity(req, res, 'u2', 'importedBy');
  assert.equal(result.ok, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body?.error, 'forbidden');
  assert.match(String(res.body?.message || ''), /importedBy must match authenticated actor/i);
});

test('enforceActorIdentity allows exact actor match', () => {
  const req = { auth: { roles: [] }, actor: { id: 'u1' } };
  const res = makeRes();

  const result = enforceActorIdentity(req, res, 'u1', 'createdBy');
  assert.equal(result.ok, true);
  assert.equal(res.statusCode, 200);
});
