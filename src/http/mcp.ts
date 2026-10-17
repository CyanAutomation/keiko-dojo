import { authenticateRequest, AuthFailure } from '../auth/bearer-auth';
import { SessionService } from '../application/session-service';
import { jsonError } from './responses';

const MCP_VERSION = '2025-11-25';
const TOOLS = [
  {
    name: 'list_sessions',
    description: 'List the authenticated user’s Judo sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', format: 'date' },
        to: { type: 'string', format: 'date' },
        category: { type: 'string', enum: ['Technical', 'Randori', 'Shiai', 'Cardio', 'S&C'] },
        effort: { type: 'integer', minimum: 1, maximum: 5 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        cursor: { type: 'string' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_session',
    description: 'Retrieve one of the authenticated user’s Judo sessions.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}$' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_training_summary',
    description: 'Return session totals, effort averages, and category/effort distributions.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
];

type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

function rpc(id: unknown, result: unknown): Response {
  return Response.json(
    { jsonrpc: '2.0', id, result },
    { headers: { 'Cache-Control': 'no-store', 'MCP-Protocol-Version': MCP_VERSION } }
  );
}

function rpcError(id: unknown, code: number, message: string): Response {
  return Response.json(
    { jsonrpc: '2.0', id: id ?? null, error: { code, message } },
    { headers: { 'Cache-Control': 'no-store', 'MCP-Protocol-Version': MCP_VERSION } }
  );
}

function toolResult(value: unknown, isError = false) {
  const text = JSON.stringify(value);
  return {
    content: [{ type: 'text', text }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function authError(error: AuthFailure, requestId: string): Response {
  if (error.kind === 'rate_limited') {
    return jsonError(requestId, 429, 'rate_limited', error.message, { 'Retry-After': '60' });
  }
  const status = error.kind === 'forbidden' ? 403 : error.kind === 'unavailable' ? 503 : 401;
  const code = error.kind === 'forbidden' ? 'insufficient_scope' : error.kind === 'unavailable' ? 'authentication_unavailable' : 'authentication_required';
  return jsonError(requestId, status, code, error.message);
}

export async function handleMcpRequest(
  request: Request,
  env: Env,
  requestId: string,
  service: SessionService
): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonError(requestId, 405, 'method_not_allowed', 'Method not allowed', { Allow: 'POST' });
  }
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    return jsonError(requestId, 403, 'authentication_required', 'Request origin could not be verified');
  }
  let body: JsonRpcRequest;
  try {
    const length = Number(request.headers.get('content-length') ?? 0);
    if (length > 1024 * 1024) return jsonError(requestId, 413, 'payload_too_large', 'Request body exceeds the 1 MiB limit');
    const value: unknown = await request.json();
    if (!isObject(value)) return rpcError(null, -32600, 'Invalid request');
    body = value as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, 'Parse error');
  }
  if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return rpcError(body.id, -32600, 'Invalid request');
  }

  if (body.method === 'notifications/initialized') {
    try {
      await authenticateRequest(request, env, 'sessions:read');
      return new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      if (error instanceof AuthFailure) return authError(error, requestId);
      throw error;
    }
  }
  if (body.id === undefined || body.id === null || typeof body.id === 'object') {
    return rpcError(null, -32600, 'Request ID is required');
  }

  let userId: string;
  try {
    ({ userId } = await authenticateRequest(request, env, 'sessions:read'));
  } catch (error) {
    if (error instanceof AuthFailure) return authError(error, requestId);
    throw error;
  }

  if (body.method === 'initialize') {
    const params = isObject(body.params) ? body.params : {};
    const requestedVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_VERSION;
    const supported = new Set([MCP_VERSION, '2025-06-18', '2025-03-26']);
    if (!supported.has(requestedVersion)) return rpcError(body.id, -32602, 'Unsupported protocol version');
    return rpc(body.id, {
      protocolVersion: requestedVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'keiko-dojo', version: '1.0.0' },
      instructions: 'All tools are read-only and scoped to the authenticated user.',
    });
  }
  if (body.method === 'ping') return rpc(body.id, {});
  if (body.method === 'tools/list') return rpc(body.id, { tools: TOOLS });
  if (body.method !== 'tools/call') return rpcError(body.id, -32601, 'Method not found');

  const params = isObject(body.params) ? body.params : null;
  if (!params || typeof params.name !== 'string') return rpcError(body.id, -32602, 'Invalid tool arguments');
  const args = isObject(params.arguments) ? params.arguments : {};
  try {
    if (params.name === 'list_sessions') {
      const limit = args.limit === undefined ? 50 : args.limit;
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) {
        return rpc(body.id, toolResult({ error: 'Invalid limit' }, true));
      }
      const page = await service.list(userId, {
        from: typeof args.from === 'string' ? args.from : undefined,
        to: typeof args.to === 'string' ? args.to : undefined,
        category: typeof args.category === 'string' ? args.category : undefined,
        effort: typeof args.effort === 'number' ? args.effort : undefined,
        cursor: typeof args.cursor === 'string' ? args.cursor : undefined,
        limit,
      });
      return rpc(body.id, toolResult({ data: page.records, nextCursor: page.nextCursor }));
    }
    if (params.name === 'get_session') {
      if (typeof args.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(args.id)) {
        return rpc(body.id, toolResult({ error: 'Invalid session ID' }, true));
      }
      const record = await service.get(userId, args.id);
      return rpc(body.id, record ? toolResult(record) : toolResult({ error: 'Session not found' }, true));
    }
    if (params.name === 'get_training_summary') {
      return rpc(body.id, toolResult(await service.analytics(userId)));
    }
    return rpcError(body.id, -32602, 'Unknown tool');
  } catch {
    return rpc(body.id, toolResult({ error: 'Tool execution failed' }, true));
  }
}
