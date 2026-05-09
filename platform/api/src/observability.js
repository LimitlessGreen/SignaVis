import { randomUUID } from 'node:crypto';

const metrics = {
  requestsTotal: 0,
  requestsByMethod: {},
  requestsByPath: {},
  responseByStatus: {},
  latencyMsByPath: {},
};

function addCount(bucket, key, inc = 1) {
  bucket[key] = (bucket[key] || 0) + inc;
}

function addLatency(path, ms) {
  if (!metrics.latencyMsByPath[path]) {
    metrics.latencyMsByPath[path] = { count: 0, sum: 0, p95Approx: 0, max: 0 };
  }
  const entry = metrics.latencyMsByPath[path];
  entry.count += 1;
  entry.sum += ms;
  entry.max = Math.max(entry.max, ms);
  // lightweight approximation; avoids in-memory histograms for now
  entry.p95Approx = Math.max(entry.p95Approx * 0.95, ms);
}

export function observabilityMiddleware(req, res, next) {
  const startedAt = Date.now();
  const path = req.path;
  const method = req.method;
  const correlationId = String(req.headers['x-correlation-id'] || randomUUID());

  req.correlationId = correlationId;
  res.setHeader('x-correlation-id', correlationId);

  metrics.requestsTotal += 1;
  addCount(metrics.requestsByMethod, method);
  addCount(metrics.requestsByPath, `${method} ${path}`);

  res.on('finish', () => {
    const duration = Date.now() - startedAt;
    addCount(metrics.responseByStatus, String(res.statusCode));
    addLatency(`${method} ${path}`, duration);

    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        correlationId,
        method,
        path,
        status: res.statusCode,
        latencyMs: duration,
        actor: req.actor?.id || null,
      }),
    );
  });

  next();
}

export function metricsSnapshot() {
  const latency = Object.fromEntries(
    Object.entries(metrics.latencyMsByPath).map(([path, value]) => [
      path,
      {
        count: value.count,
        avg: value.count > 0 ? value.sum / value.count : 0,
        p95Approx: value.p95Approx,
        max: value.max,
      },
    ]),
  );

  return {
    requestsTotal: metrics.requestsTotal,
    requestsByMethod: metrics.requestsByMethod,
    requestsByPath: metrics.requestsByPath,
    responseByStatus: metrics.responseByStatus,
    latency,
  };
}
