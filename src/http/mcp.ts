import { authenticateRequest, AuthFailure } from '../auth/bearer-auth';
import { SessionService } from '../application/session-service';
import { authFailureResponse } from './auth-errors';
import { readJsonBodyLimited } from './request-body';
import { jsonError } from './responses';

const MCP_VERSION = '2025-11-25';
const MAX_MCP_BODY_BYTES = 64 * 1024;
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

async function parseJsonRpcRequest(
  request: Request,
  requestId: string
): Promise<JsonRpcRequest | Response> {
  const parsed = await readJsonBodyLimited(request, MAX_MCP_BODY_BYTES);
  if (!parsed.ok && parsed.reason === 'too_large') {
    return jsonError(requestId, 413, 'payload_too_large', 'Request body exceeds the 64 KiB limit');
  }
  if (!parsed.ok) {
    return rpcError(null, -32700, 'Parse error');
  }
  if (!isObject(parsed.value)) return rpcError(null, -32600, 'Invalid request');
  const body = parsed.value as JsonRpcRequest;
  if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return rpcError(body.id, -32600, 'Invalid request');
  }
  return body;
}

async function authenticateMcpUser(
  request: Request,
  env: Env,
  requestId: string
): Promise<string | Response> {
  try {
    const principal = await authenticateRequest(request, env, 'sessions:read');
    return principal.userId;
  } catch (error) {
    if (error instanceof AuthFailure) return authFailureResponse(error, requestId);
    throw error;
  }
}

function initialize(body: JsonRpcRequest): Response {
  const params = isObject(body.params) ? body.params : {};
  const requestedVersion = typeof params.protocolVersion === 'string'
    ? params.protocolVersion
    : MCP_VERSION;
  const supported = new Set([MCP_VERSION, '2025-06-18', '2025-03-26']);
  if (!supported.has(requestedVersion)) {
    return rpcError(body.id, -32602, 'Unsupported protocol version');
  }
  return rpc(body.id, {
    protocolVersion: requestedVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'keiko-dojo', version: '1.0.0' },
    instructions: 'All tools are read-only and scoped to the authenticated user.',
  });
}

function handleProtocolMethod(body: JsonRpcRequest): Response | null {
  if (body.method === 'initialize') return initialize(body);
  if (body.method === 'ping') return rpc(body.id, {});
  if (body.method === 'tools/list') return rpc(body.id, { tools: TOOLS });
  return null;
}

async function listSessionsTool(
  id: unknown,
  args: Record<string, unknown>,
  userId: string,
  service: SessionService
): Promise<Response> {
  const limit = args.limit === undefined ? 50 : args.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return rpc(id, toolResult({ error: 'Invalid limit' }, true));
  }
  const page = await service.list(userId, {
    from: typeof args.from === 'string' ? args.from : undefined,
    to: typeof args.to === 'string' ? args.to : undefined,
    category: typeof args.category === 'string' ? args.category : undefined,
    effort: typeof args.effort === 'number' ? args.effort : undefined,
    cursor: typeof args.cursor === 'string' ? args.cursor : undefined,
    limit,
  });
  return rpc(id, toolResult({ data: page.records, nextCursor: page.nextCursor }));
}

async function getSessionTool(
  id: unknown,
  args: Record<string, unknown>,
  userId: string,
  service: SessionService
): Promise<Response> {
  if (typeof args.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(args.id)) {
    return rpc(id, toolResult({ error: 'Invalid session ID' }, true));
  }
  const record = await service.get(userId, args.id);
  return rpc(id, record
    ? toolResult(record)
    : toolResult({ error: 'Session not found' }, true));
}

async function callTool(
  body: JsonRpcRequest,
  userId: string,
  service: SessionService
): Promise<Response> {
  const params = isObject(body.params) ? body.params : null;
  if (!params || typeof params.name !== 'string') {
    return rpcError(body.id, -32602, 'Invalid tool arguments');
  }
  const args = isObject(params.arguments) ? params.arguments : {};
  try {
    if (params.name === 'list_sessions') {
      return await listSessionsTool(body.id, args, userId, service);
    }
    if (params.name === 'get_session') {
      return await getSessionTool(body.id, args, userId, service);
    }
    if (params.name === 'get_training_summary') {
      return rpc(body.id, toolResult(await service.analytics(userId)));
    }
    return rpcError(body.id, -32602, 'Unknown tool');
  } catch {
    return rpc(body.id, toolResult({ error: 'Tool execution failed' }, true));
  }
}

async function handleAuthenticatedRequest(
  body: JsonRpcRequest,
  userId: string,
  service: SessionService
): Promise<Response> {
  const protocolResponse = handleProtocolMethod(body);
  if (protocolResponse) return protocolResponse;
  if (body.method === 'tools/call') return callTool(body, userId, service);
  return rpcError(body.id, -32601, 'Method not found');
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
  const userId = await authenticateMcpUser(request, env, requestId);
  if (userId instanceof Response) return userId;
  const body = await parseJsonRpcRequest(request, requestId);
  if (body instanceof Response) return body;
  if (body.method === 'notifications/initialized') {
    return new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  }
  if (body.id === undefined || body.id === null || typeof body.id === 'object') {
    return rpcError(null, -32600, 'Request ID is required');
  }
  return handleAuthenticatedRequest(body, userId, service);
}
