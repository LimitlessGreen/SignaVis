import { createRemoteJWKSet, jwtVerify } from 'jose';

function parseAuthMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'disabled' || mode === 'optional' || mode === 'required') {
    return mode;
  }
  return 'required';
}

function bearerTokenFromHeader(headerValue) {
  if (!headerValue || typeof headerValue !== 'string') {
    return null;
  }
  const [scheme, token] = headerValue.split(' ');
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') {
    return null;
  }
  return token.trim() || null;
}

function makeUnauthorized(message, reason = 'invalid_token') {
  return {
    status: 401,
    body: {
      error: 'unauthorized',
      reason,
      message,
    },
  };
}

export function createOidcAuthMiddleware(config = {}) {
  const issuer = (config.issuer || process.env.OIDC_ISSUER || '').trim().replace(/\/$/, '');
  const audience = (config.audience || process.env.OIDC_AUDIENCE || '').trim();
  const mode = parseAuthMode(config.mode || process.env.AUTH_MODE || 'required');

  if (!issuer || mode === 'disabled') {
    console.log(`[auth] disabled (mode=${mode}, issuer=${issuer || 'n/a'})`);
    return (_req, _res, next) => next();
  }

  const jwksBase = (config.jwksUrl || process.env.OIDC_JWKS_URL || '').trim().replace(/\/$/, '');
  const jwksUrl = new URL(jwksBase || `${issuer}/protocol/openid-connect/certs`);
  const jwks = createRemoteJWKSet(jwksUrl);
  console.log(`[auth] enabled issuer=${issuer} jwks=${jwksUrl.href} audience=${audience || 'n/a'} mode=${mode}`);

  return async (req, res, next) => {
    const token = bearerTokenFromHeader(req.headers.authorization);

    if (!token) {
      if (mode === 'optional') {
        return next();
      }
      const unauth = makeUnauthorized('missing bearer token', 'missing_token');
      return res.status(unauth.status).json(unauth.body);
    }

    try {
      const verifyOptions = {
        issuer,
      };
      if (audience) {
        verifyOptions.audience = audience;
      }

      const { payload, protectedHeader } = await jwtVerify(token, jwks, verifyOptions);

      req.auth = {
        token,
        claims: payload,
        header: protectedHeader,
        subject: payload.sub || null,
        email: payload.email || null,
        roles: payload.realm_access?.roles || [],
      };

      return next();
    } catch (err) {
      const code = err?.code || 'jwt_invalid';
      const unauth = makeUnauthorized(`token verification failed: ${code}`, 'invalid_token');
      return res.status(unauth.status).json(unauth.body);
    }
  };
}
