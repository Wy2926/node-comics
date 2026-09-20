import type { APIRoute } from 'astro';
import { absolute } from '../data/site';
export const GET: APIRoute = () => new Response(`User-agent: *\nAllow: /\nDisallow: /v1/\nDisallow: /internal/\nDisallow: /billing/\nDisallow: /webhooks/\nDisallow: /health/\nDisallow: /docs\nDisallow: /redoc\nDisallow: /openapi.json\nSitemap: ${absolute('/sitemap.xml')}\n`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
