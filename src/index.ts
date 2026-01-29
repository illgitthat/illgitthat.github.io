import {
  ALLOWED_ORIGINS,
  GENERATED_SITE_CSP,
  GALLERY_INDEX_KEY,
  GALLERY_VERIFY_LIMIT,
  MAX_GALLERY_SIZE,
  MODELS,
  RATE_LIMIT_CONFIG,
  SCREENSHOT_PREFIX,
  SCREENSHOT_PROPAGATION_DELAY_MS,
  SITE_TTL_SECONDS,
  SYSTEM_PROMPTS,
} from './constants';

interface Env {
  ASSETS: Fetcher;
  ENVIRONMENT: string;
  CEREBRAS_API_KEY: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  SITES: KVNamespace;
  SCREENSHOTS: R2Bucket;
  RATE_LIMIT: KVNamespace;
}

interface GalleryEntry {
  siteId: string;
  prompt: string;
  createdAt: number;
  screenshotUrl?: string;
}

function isAllowedOrigin(origin: string): boolean {
  if (!origin) return true;
  const isLocalDev = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return isLocalDev || ALLOWED_ORIGINS.includes(origin);
}

function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') || '';

  if (origin && isAllowedOrigin(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Credentials': 'true',
      'Vary': 'Origin',
    };
  }

  // No Origin header (non-browser or same-origin) or disallowed origin
  return {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Create a JSON response with CORS headers
 */
function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return Response.json(data, {
    status,
    headers: { ...getSecurityHeaders(), ...extraHeaders },
  });
}

/**
 * Create a JSON response with request-specific CORS headers
 */
function jsonResponseWithCors(request: Request, data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return Response.json(data, {
    status,
    headers: { ...getCorsHeaders(request), ...getSecurityHeaders(), ...extraHeaders },
  });
}

function getSecurityHeaders(): Record<string, string> {
  return {
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'X-Content-Type-Options': 'nosniff',
  };
}

// ============================================================================
// STRUCTURED LOGGING
// ============================================================================

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  [key: string]: unknown;
}

const logger = {
  _format(level: LogLevel, component: string, message: string, context?: LogContext): string {
    const timestamp = new Date().toISOString();
    const contextStr = context ? ` ${JSON.stringify(context)}` : '';
    return `[${timestamp}] [${level.toUpperCase()}] [${component}] ${message}${contextStr}`;
  },

  debug(component: string, message: string, context?: LogContext): void {
    console.log(this._format('debug', component, message, context));
  },

  info(component: string, message: string, context?: LogContext): void {
    console.log(this._format('info', component, message, context));
  },

  warn(component: string, message: string, context?: LogContext): void {
    console.warn(this._format('warn', component, message, context));
  },

  error(component: string, message: string, context?: LogContext): void {
    console.error(this._format('error', component, message, context));
  },
};

// ============================================================================
// RATE LIMITING
// ============================================================================

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

function getRateLimitHeaders(rateLimit: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(RATE_LIMIT_CONFIG.MAX_REQUESTS),
    'X-RateLimit-Remaining': String(Math.max(0, rateLimit.remaining)),
    'X-RateLimit-Reset': String(rateLimit.resetAt),
  };
}

/**
 * Check and increment rate limit for an IP address
 * Uses KV with TTL for automatic expiration
 */
async function checkRateLimit(env: Env, ip: string): Promise<RateLimitResult> {
  if (!env.RATE_LIMIT) {
    // Rate limiting not configured, allow all requests
    return { allowed: true, remaining: RATE_LIMIT_CONFIG.MAX_REQUESTS, resetAt: 0 };
  }

  const key = `${RATE_LIMIT_CONFIG.KEY_PREFIX}${ip}`;
  const now = Math.floor(Date.now() / 1000);

  try {
    const data = await env.RATE_LIMIT.get(key);
    let count = 0;
    let windowStart = now;

    if (data) {
      const parsed = JSON.parse(data) as { count: number; windowStart: number };
      // Check if we're still in the same window
      if (now - parsed.windowStart < RATE_LIMIT_CONFIG.WINDOW_SECONDS) {
        count = parsed.count;
        windowStart = parsed.windowStart;
      }
    }

    const resetAt = windowStart + RATE_LIMIT_CONFIG.WINDOW_SECONDS;
    const remaining = Math.max(0, RATE_LIMIT_CONFIG.MAX_REQUESTS - count - 1);

    if (count >= RATE_LIMIT_CONFIG.MAX_REQUESTS) {
      logger.warn('RateLimit', 'Rate limit exceeded', { ip: ip.slice(0, 10) + '...', count });
      return { allowed: false, remaining: 0, resetAt };
    }

    // Increment counter
    await env.RATE_LIMIT.put(
      key,
      JSON.stringify({ count: count + 1, windowStart }),
      { expirationTtl: RATE_LIMIT_CONFIG.WINDOW_SECONDS }
    );

    return { allowed: true, remaining, resetAt };
  } catch (error) {
    // On error, allow the request but log the issue
    logger.error('RateLimit', 'Failed to check rate limit', {
      error: error instanceof Error ? error.message : 'Unknown'
    });
    return { allowed: true, remaining: RATE_LIMIT_CONFIG.MAX_REQUESTS, resetAt: 0 };
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const isApiRequest = url.pathname.startsWith('/api/');

    if (origin && !isAllowedOrigin(origin) && (isApiRequest || request.method === 'OPTIONS')) {
      return new Response('Forbidden', {
        status: 403,
        headers: getSecurityHeaders(),
      });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { ...getCorsHeaders(request), ...getSecurityHeaders() } });
    }

    // Serve stored sites at /site/:id
    const siteMatch = url.pathname.match(/^\/site\/([a-zA-Z0-9]+)$/);
    if (siteMatch) {
      return handleSiteView(siteMatch[1], env);
    }

    const screenshotMatch = url.pathname.match(/^\/screenshot\/([a-zA-Z0-9\-_.]+)$/);
    if (screenshotMatch) {
      return handleScreenshotView(screenshotMatch[1], env);
    }

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url, ctx);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleApi(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext
): Promise<Response> {
  if (url.pathname === '/api/health') {
    return jsonResponseWithCors(request, { status: 'ok' });
  }

  if (url.pathname === '/api/build' && request.method === 'POST') {
    return handleBuild(request, env, ctx);
  }

  if (url.pathname === '/api/build-stream' && request.method === 'POST') {
    return handleBuildStream(request, env, ctx);
  }

  if (url.pathname === '/api/surprise' && request.method === 'POST') {
    return handleSurprise(request, env);
  }

  if (url.pathname === '/api/gallery' && request.method === 'GET') {
    return handleGallery(request, env);
  }

  const screenshotStatusMatch = url.pathname.match(/^\/api\/screenshot-status\/([a-zA-Z0-9]+)$/);
  if (screenshotStatusMatch && request.method === 'GET') {
    return handleScreenshotStatus(request, screenshotStatusMatch[1], env);
  }

  return jsonResponseWithCors(request, { error: 'Not found' }, 404);
}

async function handleBuild(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Rate limiting check
  const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateLimit = await checkRateLimit(env, clientIp);
  const rateLimitHeaders = getRateLimitHeaders(rateLimit);

  if (!rateLimit.allowed) {
    return jsonResponseWithCors(
      request,
      {
        error: 'Rate limit exceeded. Please wait before making more requests.',
        retryAfter: rateLimit.resetAt - Math.floor(Date.now() / 1000)
      },
      429,
      {
        'Retry-After': String(rateLimit.resetAt - Math.floor(Date.now() / 1000)),
        ...rateLimitHeaders,
      }
    );
  }

  let body: { prompt?: string };
  try {
    body = (await request.json()) as { prompt?: string };
  } catch {
    return jsonResponseWithCors(request, { error: 'Invalid JSON body' }, 400, rateLimitHeaders);
  }

  const prompt = body.prompt?.trim();
  if (!prompt) {
    return jsonResponseWithCors(request, { error: 'Prompt required' }, 400, rateLimitHeaders);
  }

  if (prompt.length > 2000) {
    return jsonResponseWithCors(request, { error: 'Prompt too long' }, 400, rateLimitHeaders);
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPTS.BUILD },
    {
      role: 'user',
      content: `Brief: ${prompt}\n\nProduce the final HTML document now.`,
    },
  ];

  let html = '';
  try {
    logger.info('Build', 'Starting generation', { promptPreview: prompt.slice(0, 100) });
    const jsonText = await callCerebras(env, messages, {
      model: MODELS.BUILD,
      maxTokens: 16000,
    });
    const parsed = parseHtmlResponse(jsonText);
    html = parsed;
    logger.info('Build', 'Generated HTML', { length: html.length });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Build', 'Generation failed', { error: errorMessage });

    // Detect rate limiting or server overload
    const isRateLimit = errorMessage.includes('429') || errorMessage.toLowerCase().includes('rate');
    const isServerBusy = errorMessage.includes('503') || errorMessage.includes('502') || errorMessage.toLowerCase().includes('busy');

    let userMessage = 'AI service error';
    if (isRateLimit) {
      userMessage = 'The builder is busy. Please try again in a moment.';
    } else if (isServerBusy) {
      userMessage = 'The AI service is temporarily unavailable. Please try again shortly.';
    }

    return jsonResponseWithCors(request, { error: userMessage, detail: errorMessage }, 502, rateLimitHeaders);
  }

  html = html.trim();

  if (!html) {
    logger.error('Build', 'Empty response from AI - raw content was empty after parsing');
    return jsonResponseWithCors(request, { error: 'Empty response from AI. Please try again.' }, 502, rateLimitHeaders);
  }

  const normalizedHtml = normalizeHtml(html);

  // Store in KV with 24h TTL and return shareable URL
  const siteId = generateSiteId();
  try {
    await env.SITES.put(siteId, normalizedHtml, { expirationTtl: SITE_TTL_SECONDS });

    // Store prompt separately for regeneration on expiry (store longer than site)
    await env.SITES.put(`prompt:${siteId}`, prompt, { expirationTtl: SITE_TTL_SECONDS * 7 }); // 7 days

    // Add to gallery index
    await addToGalleryIndex(env, {
      siteId,
      prompt: prompt.slice(0, 150), // Truncate for display
      createdAt: Date.now()
    });
  } catch {
    // KV storage failed, still return the HTML but without share URL
    return jsonResponseWithCors(request, { html: normalizedHtml }, 200, rateLimitHeaders);
  }

  const shareUrl = `/site/${siteId}`;
  const origin = new URL(request.url).origin;
  ctx.waitUntil(
    generateScreenshotAndStore({
      env,
      siteId,
      origin,
    })
  );
  return jsonResponseWithCors(request, { html: normalizedHtml, shareUrl, siteId }, 200, rateLimitHeaders);
}

/**
 * Stream-based build endpoint using Server-Sent Events
 * Provides real-time progress updates during site generation
 */
async function handleBuildStream(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Rate limiting check
  const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateLimit = await checkRateLimit(env, clientIp);
  const rateLimitHeaders = getRateLimitHeaders(rateLimit);

  if (!rateLimit.allowed) {
    return jsonResponseWithCors(
      request,
      {
        error: 'Rate limit exceeded. Please wait before making more requests.',
        retryAfter: rateLimit.resetAt - Math.floor(Date.now() / 1000)
      },
      429,
      {
        'Retry-After': String(rateLimit.resetAt - Math.floor(Date.now() / 1000)),
        ...rateLimitHeaders,
      }
    );
  }

  let body: { prompt?: string };
  try {
    body = (await request.json()) as { prompt?: string };
  } catch {
    return jsonResponseWithCors(request, { error: 'Invalid JSON body' }, 400, rateLimitHeaders);
  }

  const prompt = body.prompt?.trim();
  if (!prompt) {
    return jsonResponseWithCors(request, { error: 'Prompt required' }, 400, rateLimitHeaders);
  }

  if (prompt.length > 2000) {
    return jsonResponseWithCors(request, { error: 'Prompt too long' }, 400, rateLimitHeaders);
  }

  // Create a TransformStream for SSE
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Helper to send SSE events
  const sendEvent = async (event: string, data: unknown) => {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    await writer.write(encoder.encode(message));
  };

  // Start the generation process in the background
  ctx.waitUntil((async () => {
    try {
      // Send initial progress
      await sendEvent('progress', {
        stage: 'started',
        message: 'Starting generation...',
        estimatedTime: 15 // seconds
      });

      const messages = [
        { role: 'system', content: SYSTEM_PROMPTS.BUILD },
        { role: 'user', content: `Brief: ${prompt}\n\nProduce the final HTML document now.` },
      ];

      await sendEvent('progress', {
        stage: 'generating',
        message: 'AI is generating your site...',
        progress: 20
      });

      logger.info('BuildStream', 'Starting generation', { promptPreview: prompt.slice(0, 100) });

      const jsonText = await callCerebras(env, messages, {
        model: MODELS.BUILD,
        maxTokens: 16000,
      });

      await sendEvent('progress', {
        stage: 'processing',
        message: 'Processing generated content...',
        progress: 70
      });

      const parsed = parseHtmlResponse(jsonText);
      let html = parsed.trim();

      if (!html) {
        await sendEvent('error', { error: 'Empty response from AI. Please try again.' });
        await writer.close();
        return;
      }

      const normalizedHtml = normalizeHtml(html);

      await sendEvent('progress', {
        stage: 'storing',
        message: 'Storing your site...',
        progress: 85
      });

      // Store in KV
      const siteId = generateSiteId();
      await env.SITES.put(siteId, normalizedHtml, { expirationTtl: SITE_TTL_SECONDS });
      await env.SITES.put(`prompt:${siteId}`, prompt, { expirationTtl: SITE_TTL_SECONDS * 7 });

      await addToGalleryIndex(env, {
        siteId,
        prompt: prompt.slice(0, 150),
        createdAt: Date.now()
      });

      const shareUrl = `/site/${siteId}`;
      const origin = new URL(request.url).origin;

      // Start screenshot generation in background
      ctx.waitUntil(generateScreenshotAndStore({ env, siteId, origin }));

      await sendEvent('progress', {
        stage: 'complete',
        message: 'Site ready!',
        progress: 100
      });

      // Send final result
      await sendEvent('complete', {
        html: normalizedHtml,
        shareUrl,
        siteId
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('BuildStream', 'Generation failed', { error: errorMessage });

      const isRateLimit = errorMessage.includes('429') || errorMessage.toLowerCase().includes('rate');
      const isServerBusy = errorMessage.includes('503') || errorMessage.includes('502');

      let userMessage = 'AI service error';
      if (isRateLimit) {
        userMessage = 'The builder is busy. Please try again in a moment.';
      } else if (isServerBusy) {
        userMessage = 'The AI service is temporarily unavailable. Please try again shortly.';
      }

      await sendEvent('error', { error: userMessage, detail: errorMessage });
    } finally {
      await writer.close();
    }
  })());

  // Return the SSE response immediately
  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...getCorsHeaders(request),
      ...getSecurityHeaders(),
      ...rateLimitHeaders,
    },
  });
}

async function handleSurprise(request: Request, env: Env): Promise<Response> {
  // Rate limiting check (shares limit with build)
  const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateLimit = await checkRateLimit(env, clientIp);
  const rateLimitHeaders = getRateLimitHeaders(rateLimit);

  if (!rateLimit.allowed) {
    return jsonResponseWithCors(
      request,
      {
        error: 'Rate limit exceeded. Please wait before making more requests.',
        retryAfter: rateLimit.resetAt - Math.floor(Date.now() / 1000)
      },
      429,
      {
        'Retry-After': String(rateLimit.resetAt - Math.floor(Date.now() / 1000)),
        ...rateLimitHeaders,
      }
    );
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPTS.SURPRISE },
    { role: 'user', content: 'Generate a fresh, creative website idea for me to build right now.' },
  ];

  try {
    const idea = await callCerebras(env, messages, {
      model: MODELS.SURPRISE,
      maxTokens: 400,
      temperature: 1.2,
    });
    return jsonResponseWithCors(request, { idea: idea.trim() }, 200, rateLimitHeaders);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Surprise', 'Generation failed', { error: errorMessage });
    return jsonResponseWithCors(request, { error: 'Could not generate idea. Try again!' }, 502, rateLimitHeaders);
  }
}

async function handleSiteView(siteId: string, env: Env): Promise<Response> {
  const html = await env.SITES.get(siteId);
  if (!html) {
    // Check if we have the original prompt stored for regeneration
    const storedPrompt = await env.SITES.get(`prompt:${siteId}`);
    const encodedPrompt = storedPrompt ? encodeURIComponent(storedPrompt) : '';

    const expiredHtml = `<!DOCTYPE html>
<html>
<head>
  <title>Site Expired</title>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0b0d24;
      color: #e5e7eb;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      text-align: center;
    }
    .container {
      max-width: 450px;
      padding: 2rem;
    }
    h1 {
      margin-bottom: 1rem;
      font-size: 1.5rem;
    }
    p {
      margin-bottom: 1rem;
      opacity: 0.8;
    }
    .prompt-preview {
      background: rgba(255,255,255,0.1);
      padding: 1rem;
      border-radius: 8px;
      margin: 1.5rem 0;
      font-size: 0.9rem;
      text-align: left;
    }
    .prompt-preview strong {
      display: block;
      margin-bottom: 0.5rem;
      opacity: 0.7;
    }
    a {
      color: #74b0ff;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
    .btn {
      display: inline-block;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 0.75rem 1.5rem;
      border-radius: 8px;
      text-decoration: none;
      margin-top: 0.5rem;
    }
    .btn:hover {
      opacity: 0.9;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>This site has expired</h1>
    <p>Generated sites are available for 24 hours.</p>
    ${storedPrompt ? `
    <div class="prompt-preview">
      <strong>Original prompt:</strong>
      ${escapeHtml(storedPrompt.slice(0, 200))}${storedPrompt.length > 200 ? '...' : ''}
    </div>
    <a href="/?prompt=${encodedPrompt}" class="btn">Regenerate with same prompt →</a>
    <p style="margin-top: 1.5rem;"><a href="/">Or create something new</a></p>
    ` : `
    <p><a href="/">Create a new one →</a></p>
    `}
  </div>
</body>
</html>`;

    return new Response(expiredHtml, {
      status: 404,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        ...getSecurityHeaders(),
      },
    });
  }
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': GENERATED_SITE_CSP,
      'X-Frame-Options': 'SAMEORIGIN',
      ...getSecurityHeaders(),
    }
  });
}

async function handleScreenshotView(key: string, env: Env): Promise<Response> {
  const object = await env.SCREENSHOTS.get(`${SCREENSHOT_PREFIX}${key}`);
  if (!object) {
    return new Response('Not found', { status: 404 });
  }

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'image/png');
  headers.set('Cache-Control', 'public, max-age=2592000, immutable'); // 30 days, immutable content
  Object.entries(getSecurityHeaders()).forEach(([keyName, value]) => headers.set(keyName, value));

  return new Response(object.body, { headers });
}

async function handleScreenshotStatus(request: Request, siteId: string, env: Env): Promise<Response> {
  try {
    // Check if R2 bucket is available (might not be in dev mode)
    if (!env.SCREENSHOTS) {
      logger.info('ScreenshotStatus', 'R2 bucket not available');
      return jsonResponseWithCors(request, { ready: false, reason: 'storage_unavailable' });
    }

    const screenshotKey = `${SCREENSHOT_PREFIX}${siteId}.png`;
    const object = await env.SCREENSHOTS.head(screenshotKey);

    if (object) {
      logger.info('ScreenshotStatus', 'Found screenshot', { siteId });
      return jsonResponseWithCors(request, { ready: true, screenshotUrl: `/screenshot/${siteId}.png` });
    }

    logger.debug('ScreenshotStatus', 'Screenshot not ready', { siteId });
    return jsonResponseWithCors(request, { ready: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown';
    logger.error('ScreenshotStatus', 'Error checking status', { siteId, error: message });
    return jsonResponseWithCors(request, { ready: false, error: message });
  }
}

async function handleGallery(request: Request, env: Env): Promise<Response> {
  try {
    const indexJson = await env.SITES.get(GALLERY_INDEX_KEY);
    if (!indexJson) {
      return jsonResponseWithCors(request, { sites: [] }, 200, { 'Cache-Control': 'public, max-age=60' });
    }

    const entries: GalleryEntry[] = JSON.parse(indexJson);
    const now = Date.now();
    const cutoff = now - SITE_TTL_SECONDS * 1000;

    // Filter out expired entries (older than 24h)
    const validEntries = entries.filter(e => e.createdAt > cutoff);

    // Verify sites still exist (in parallel, limit to 12 for perf)
    const toCheck = validEntries.slice(0, GALLERY_VERIFY_LIMIT);
    const checks = await Promise.all(
      toCheck.map(async entry => {
        const exists = (await env.SITES.get(entry.siteId)) !== null;
        return exists ? entry : null;
      })
    );

    const sites = checks.filter((e): e is GalleryEntry => e !== null);

    return jsonResponseWithCors(request, { sites }, 200, { 'Cache-Control': 'public, max-age=60' });
  } catch {
    return jsonResponseWithCors(request, { sites: [] }, 200, { 'Cache-Control': 'public, max-age=60' });
  }
}

async function addToGalleryIndex(env: Env, entry: GalleryEntry): Promise<void> {
  try {
    const indexJson = await env.SITES.get(GALLERY_INDEX_KEY);
    let entries: GalleryEntry[] = indexJson ? JSON.parse(indexJson) : [];

    // Add new entry at the beginning
    entries.unshift(entry);

    // Filter out expired entries
    const now = Date.now();
    const cutoff = now - SITE_TTL_SECONDS * 1000;
    entries = entries.filter(e => e.createdAt > cutoff);

    // Keep only the most recent entries
    entries = entries.slice(0, MAX_GALLERY_SIZE);

    // Store with same TTL
    await env.SITES.put(GALLERY_INDEX_KEY, JSON.stringify(entries), {
      expirationTtl: SITE_TTL_SECONDS
    });
  } catch {
    // Silently fail - gallery is non-critical
  }
}

async function updateGalleryScreenshot(env: Env, siteId: string, screenshotUrl: string): Promise<void> {
  try {
    const indexJson = await env.SITES.get(GALLERY_INDEX_KEY);
    if (!indexJson) {
      logger.info('Gallery', 'No index found when updating screenshot');
      return;
    }

    const entries: GalleryEntry[] = JSON.parse(indexJson);
    const updated = entries.map(entry =>
      entry.siteId === siteId ? { ...entry, screenshotUrl } : entry
    );

    await env.SITES.put(GALLERY_INDEX_KEY, JSON.stringify(updated), {
      expirationTtl: SITE_TTL_SECONDS
    });
    logger.info('Gallery', 'Updated screenshot URL', { siteId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown';
    logger.error('Gallery', 'Failed to update screenshot URL', { error: message });
  }
}

/**
 * Attempt to take a screenshot with retry logic and exponential backoff
 */
async function takeScreenshotWithRetry(
  apiUrl: string,
  targetUrl: string,
  apiToken: string,
  maxRetries = 3
): Promise<ArrayBuffer | null> {
  const baseDelayMs = 1000; // 1 second base delay

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info('Screenshot', `Attempt ${attempt}/${maxRetries}`, { url: targetUrl });

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiToken}`,
        },
        body: JSON.stringify({
          url: targetUrl,
          viewport: { width: 720, height: 450 }, // Optimized for gallery display (360x225 @ 2x)
          screenshotOptions: { fullPage: false },
          gotoOptions: {
            waitUntil: 'networkidle0', // Wait until no network connections for 500ms
          },
          waitForTimeout: 300, // Additional .3s wait for animations/renders to settle
        }),
      });

      if (response.ok) {
        const imageBuffer = await response.arrayBuffer();
        return imageBuffer;
      }

      const errorText = await safeResponseText(response);
      logger.warn('Screenshot', `Attempt ${attempt} failed`, {
        status: response.status,
        error: errorText.slice(0, 200)
      });

      // Don't retry on client errors (4xx), only on server errors (5xx)
      if (response.status < 500) {
        logger.error('Screenshot', 'Non-retryable error', { status: response.status });
        return null;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('Screenshot', `Attempt ${attempt} threw error`, { error: message });
    }

    // Exponential backoff: 1s, 2s, 4s
    if (attempt < maxRetries) {
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      logger.info('Screenshot', `Retrying in ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  logger.error('Screenshot', 'All retry attempts exhausted');
  return null;
}

async function generateScreenshotAndStore(params: {
  env: Env;
  siteId: string;
  origin: string;
}): Promise<void> {
  const { env, siteId, origin } = params;

  // Skip screenshot generation in dev mode (Browser Rendering can't access localhost)
  if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
    logger.info('Screenshot', 'Skipping - localhost not accessible by Browser Rendering API');
    return;
  }

  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
    logger.warn('Screenshot', 'Missing Cloudflare Browser Rendering credentials');
    return;
  }

  // Small delay to ensure KV write has propagated
  await new Promise(resolve => setTimeout(resolve, SCREENSHOT_PROPAGATION_DELAY_MS));

  // Verify site exists before taking screenshot
  const siteHtml = await env.SITES.get(siteId);
  if (!siteHtml) {
    logger.error('Screenshot', 'Site not found in KV, skipping screenshot', { siteId });
    return;
  }

  const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/screenshot`;
  const url = `${origin}/site/${siteId}`;

  const imageBuffer = await takeScreenshotWithRetry(apiUrl, url, env.CLOUDFLARE_API_TOKEN);

  if (!imageBuffer) {
    logger.error('Screenshot', 'Failed to capture screenshot after retries', { siteId });
    return;
  }

  try {
    const screenshotKey = `${SCREENSHOT_PREFIX}${siteId}.png`;
    logger.info('Screenshot', 'Storing screenshot', { siteId, size: imageBuffer.byteLength });
    await env.SCREENSHOTS.put(screenshotKey, imageBuffer, {
      httpMetadata: { contentType: 'image/png' },
    });
    logger.info('Screenshot', 'Successfully stored screenshot', { siteId });
    await updateGalleryScreenshot(env, siteId, `/screenshot/${siteId}.png`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Screenshot', 'Failed to store screenshot', { error: message });
  }
}

function generateSiteId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}

/**
 * Sanitize HTML to prevent XSS attacks
 * Removes dangerous patterns while preserving safe inline scripts/styles
 */
function sanitizeHtml(html: string): string {
  let sanitized = html;

  // Remove dangerous event handlers (onclick, onerror, onload, etc.)
  sanitized = sanitized.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');
  sanitized = sanitized.replace(/\s+on\w+\s*=\s*[^\s>]+/gi, '');

  // Remove javascript: URLs
  sanitized = sanitized.replace(/href\s*=\s*["']javascript:[^"']*["']/gi, 'href="#"');
  sanitized = sanitized.replace(/src\s*=\s*["']javascript:[^"']*["']/gi, '');

  // Remove data: URLs in src attributes (potential XSS vector, except for images)
  sanitized = sanitized.replace(/src\s*=\s*["']data:(?!image\/)[^"']*["']/gi, '');

  // Remove external scripts (keep inline scripts only)
  sanitized = sanitized.replace(/<script[^>]+src\s*=\s*["'][^"']+["'][^>]*>[\s\S]*?<\/script>/gi, '');

  // Remove iframes
  sanitized = sanitized.replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '');

  // Remove object/embed tags
  sanitized = sanitized.replace(/<object[^>]*>[\s\S]*?<\/object>/gi, '');
  sanitized = sanitized.replace(/<embed[^>]*>/gi, '');

  // Remove base tags (could redirect relative URLs)
  sanitized = sanitized.replace(/<base[^>]*>/gi, '');

  // Remove meta refresh
  sanitized = sanitized.replace(/<meta[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, '');

  return sanitized;
}

function normalizeHtml(html: string): string {
  // First sanitize, then normalize
  const sanitized = sanitizeHtml(html);
  const hasDoc = /<!doctype html>/i.test(sanitized);
  if (hasDoc) return sanitized;

  return `<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Generated Site</title>\n</head>\n<body>\n${sanitized}\n</body>\n</html>`;
}

/**
 * Escape HTML special characters to prevent XSS in dynamic content
 */
function escapeHtml(text: string): string {
  const htmlEscapes: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return text.replace(/[&<>"']/g, char => htmlEscapes[char] || char);
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return 'Unknown error';
  }
}

interface CerebrasOptions {
  model: string;
  maxTokens: number;
  temperature?: number;
  topP?: number;
}

async function callCerebras(
  env: Env,
  messages: Array<{ role: string; content: string }>,
  options: CerebrasOptions
): Promise<string> {
  if (!env.CEREBRAS_API_KEY) {
    throw new Error('Cerebras API key not configured');
  }

  const { model, maxTokens, temperature = 1, topP = 0.95 } = options;
  const apiUrl = 'https://api.cerebras.ai/v1/chat/completions';

  logger.debug('Cerebras', 'Starting API call', { model, maxTokens });

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.CEREBRAS_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      top_p: topP,
    }),
  });

  logger.debug('Cerebras', 'Response status', { status: response.status, statusText: response.statusText });

  if (!response.ok) {
    const errorText = await safeResponseText(response);
    logger.error('Cerebras', 'API Error', {
      status: response.status,
      statusText: response.statusText,
      body: errorText.slice(0, 500),
    });
    throw new Error(`Cerebras API error ${response.status}: ${errorText}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string; type?: string };
  };

  if (data.error) {
    logger.error('Cerebras', 'Error in response body', { error: data.error });
    throw new Error(`Cerebras error: ${data.error.message || JSON.stringify(data.error)}`);
  }

  const content = data.choices?.[0]?.message?.content || '';
  logger.debug('Cerebras', 'Response received', { contentLength: content.length });

  return content;
}

function parseHtmlResponse(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed) as { html?: string };
    if (parsed?.html) return parsed.html;
  } catch {
    // fall through
  }
  return trimmed;
}
