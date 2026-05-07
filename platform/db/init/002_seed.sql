INSERT INTO users (id, external_auth_id, email, display_name)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'local-admin', 'admin@local.test', 'Platform Admin'),
  ('00000000-0000-0000-0000-000000000002', 'local-annotator', 'annotator@local.test', 'Annotator One')
ON CONFLICT (email) DO NOTHING;

INSERT INTO teams (id, name)
VALUES ('10000000-0000-0000-0000-000000000001', 'Demo Team')
ON CONFLICT (id) DO NOTHING;

INSERT INTO team_memberships (team_id, user_id, is_admin)
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

INSERT INTO project_members (project_id, user_id, role)
VALUES
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'owner'),
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'annotator')
ON CONFLICT (project_id, user_id) DO NOTHING;
