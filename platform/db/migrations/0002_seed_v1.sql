INSERT INTO users (id, external_auth_id, email, display_name)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'local-admin', 'admin@local.test', 'Platform Admin'),
  ('00000000-0000-0000-0000-000000000002', 'local-annotator', 'annotator@local.test', 'Annotator One')
ON CONFLICT (email) DO NOTHING;

INSERT INTO teams (id, name)
VALUES ('10000000-0000-0000-0000-000000000001', 'Demo Team')
ON CONFLICT (id) DO NOTHING;

INSERT INTO memberships (team_id, user_id, is_admin)
VALUES
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', true),
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', false)
ON CONFLICT (team_id, user_id) DO NOTHING;

INSERT INTO projects (id, team_id, name, description, created_by)
VALUES (
  '20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'Demo Project',
  'Seed project for platform test environment',
  '00000000-0000-0000-0000-000000000001'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO assets (id, project_id, type, source_type, source_ref, storage_uri, created_by)
VALUES (
  '30000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  'audio',
  'local',
  '/tmp/demo.wav',
  's3://recordings/demo/demo.wav',
  '00000000-0000-0000-0000-000000000001'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO jobs (id, project_id, asset_id, type, backend, status, progress, payload_json, created_by)
VALUES (
  '40000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  'analysis',
  'local',
  'queued',
  0,
  '{"model":"birdnet-v2.4"}'::jsonb,
  '00000000-0000-0000-0000-000000000001'
)
ON CONFLICT (id) DO NOTHING;
