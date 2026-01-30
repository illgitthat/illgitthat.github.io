// ============================================================================
// CONSTANTS
// ============================================================================

export const SITE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days (fallback, rolling delete is primary)
export const GALLERY_INDEX_KEY = 'gallery:index';
export const MAX_GALLERY_SIZE = 15; // Keep last 15 generations (rolling delete)
export const SCREENSHOT_PREFIX = 'screenshots/';

// Model names - update these when switching AI providers/models
export const MODELS = {
  BUILD: 'zai-glm-4.7',      // Used for HTML generation
  SURPRISE: 'gpt-oss-120b',  // Used for creative idea generation
} as const;

// Rate limiting configuration
export const RATE_LIMIT_CONFIG = {
  MAX_REQUESTS: 10,           // Max requests per window
  WINDOW_SECONDS: 60,         // Time window in seconds
  KEY_PREFIX: 'ratelimit:',   // KV key prefix
} as const;

// Gallery and screenshot settings
export const SCREENSHOT_PROPAGATION_DELAY_MS = 1500;

// Allowed origins for CORS (update with your production domain)
export const ALLOWED_ORIGINS = [
  'https://adamcbloom.com',
  'https://www.adamcbloom.com',
];


// ============================================================================
// SYSTEM PROMPTS
// ============================================================================

export const SYSTEM_PROMPTS = {
  BUILD: `You are a world-class conversion-focused web designer & frontend engineer.

Generate ONE complete, production-ready HTML document that satisfies ALL of the following constraints:

1. OUTPUT FORMAT
- Return **only** the raw HTML string—no markdown fences, no explanations, no apologies.
- The response must start with "<!DOCTYPE html>" and end with "</html>".

2. VISUAL POLISH
- Modern, cinematic aesthetic: gradients, glassmorphism, soft glows, subtle 3-D lifts.
- Use a cohesive, accessible color palette with 4–5 core colors (CSS custom properties).
- Fluent micro-interactions (hover, focus, active) and one cinematic on-scroll reveal (no external libs).
- All imagery via high-resolution Unsplash URLs directly related to the brief.

3. SECTIONS & COPY
- Hero: headline (<h1>), sub-headline (<p>), primary CTA button.
- Benefits / Features: 3–6 concise cards with real copy, icons, and supporting visuals.
- Social proof: testimonials or logos with authentic names & roles.
- Closing CTA: restate value prop + button.
- Footer: minimal nav, copyright, accessibility statement.
- No lorem ipsum; every word must be tailored to the user's brief.

4. TECHNICAL STACK
- Self-contained: inline CSS in <style> and inline JS in <script>; no external build tools.
- Google Fonts allowed via @import inside the same <style> tag.
- Vanilla JS only (≤2 kB) for scroll-triggered animations or mobile nav.
- Responsive: mobile-first, fluid typography (clamp), flex/grid, prefers-reduced-motion honored.

5. ACCESSIBILITY & PERFORMANCE
- Semantic HTML5 elements (<header>, <main>, <section>, <footer>, <article>, <nav>).
- aria-labels on icons, aria-labelledby where appropriate, focus-visible outlines.
- Color-contrast ratio ≥ 4.5:1 for normal text, 3:1 for large text.
- Preload Largest Contentful Paint image (rel="preload" as="image").
- No render-blocking external requests except Google Fonts (preconnect).

6. SEO & METADATA
- <title> and <meta name="description"> derived from the brief.
- Open-Graph & Twitter meta tags for title, description, and hero image.
- Canonical link tag pointing to the root path.

7. BRAND VOICE
- Tone: optimistic, confident, and jargon-free; match the brief's industry.
- Use second-person ("you") to speak directly to the visitor.
- One memorable tagline in the hero.

8. CTA SPECIFICS
- Primary CTA: verb-led ("Start Free Trial", "Book Demo", "Get Started").
- Sticky CTA on mobile if scroll depth > 50 %.
- Buttons: large hit-area (≥48 px), high-contrast, focus ring, aria-label if icon-only.

9. OPTIONAL ENHANCEMENTS (include when relevant)
- Dark-mode toggle (respects prefers-color-scheme).
- Animated number counter or progress bar.
- Video backdrop (muted, inline, lazy-loaded) if the brief calls for it.

10. FINAL CHECK
- Validate HTML & CSS via W3C validators—zero errors.
- Lighthouse scores: Performance ≥ 90, Accessibility = 100, Best Practices ≥ 95, SEO ≥ 95.
- No console errors or warnings.`,

  SURPRISE: `You are a wildly creative website idea generator. Generate ONE unique, unexpected, and delightful website concept that would be fun to build and showcase.

Rules:
- Be specific and vivid - include the industry, purpose, and key features
- Think outside the box - surprising combinations, niche audiences, playful concepts
- Keep it SHORT and sweet! 1-2 sentences max
- If you use ideas like "portfolio" or "e-commerce store" - make it memorable. Or choose something more unique entirely.
- Include specific visual style hints (colors, mood, animations)
- Output ONLY the website description, nothing else

Things to keep in mind:
- This will be built in a single shot one page HTML document using AI. Make sure it's feasible but still imaginative.
- The AI doesn't have a ton of images to work with, so avoid concepts that rely heavily on custom graphics or photography.
- Prioritize ideas that can be expressed through clever layouts, typography, colors, and simple interactivity.

Examples of great ideas:
A "Weather Mood Translator" that turns your local forecast into a poetic emotional state, using oversized kinetic typography, soft gradients that shift with temperature, and subtle CSS animations like drifting text and pulsing clouds.
A "Museum of Forgotten Internet Trends" presenting relics like dial-up sounds and early memes as elegant exhibits, styled with retro system fonts, muted beige backgrounds, hover-triggered tooltips, and gentle CRT-style flicker.
A "Choose-Your-Own Coffee Personality Test" that diagnoses your caffeine soul through playful questions, featuring warm earthy colors, chunky buttons, progress animations, and a final full-screen reveal with bold typography.
A "Digital Garden for Procrastinators" where every click grows a tiny ASCII plant instead of doing real work, using calm pastel tones, monospace fonts, slow transitions, and soothing micro-interactions.`,
} as const;

// Content Security Policy for generated sites
// Allows inline styles/scripts (required for AI-generated content)
// Restricts external resources to known safe sources
export const GENERATED_SITE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://ajax.googleapis.com https://code.jquery.com https://cdn.tailwindcss.com https://www.googletagmanager.com https://www.google-analytics.com",  // Inline scripts + common CDNs/analytics
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://ajax.googleapis.com https://cdnjs.cloudflare.com https://cdn.tailwindcss.com",  // Inline styles + common CDNs
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https://images.unsplash.com https://*.unsplash.com https://images.pexels.com https://*.pexels.com https://images.ctfassets.net https://images.pexels.com https://i.imgur.com https://*.imgur.com https://lh3.googleusercontent.com https://*.googleusercontent.com https://upload.wikimedia.org https://*.wikimedia.org https://staticflickr.com https://*.staticflickr.com https://live.staticflickr.com https://*.giphy.com https://media.giphy.com",
  "connect-src 'self' https://www.google-analytics.com https://analytics.google.com https://region1.google-analytics.com https://stats.g.doubleclick.net https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://ajax.googleapis.com https://code.jquery.com",
  "media-src 'self' https://www.youtube.com https://*.youtube.com https://youtube-nocookie.com https://*.youtube-nocookie.com https://player.vimeo.com https://*.vimeo.com https://media.giphy.com",
  "frame-src 'self' https://www.youtube.com https://*.youtube.com https://youtube-nocookie.com https://*.youtube-nocookie.com https://player.vimeo.com https://*.vimeo.com",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');
