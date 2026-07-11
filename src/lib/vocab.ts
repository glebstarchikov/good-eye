export const CATEGORIES = [
  "saas-landing", "marketing", "dashboard", "portfolio", "ecommerce",
  "docs", "blog", "mobile-app", "desktop-app", "other",
] as const;

export const STYLE_TAGS = [
  // Style
  "minimal", "maximalist", "brutalist", "neo-brutalist", "glassmorphic",
  "neumorphic", "flat", "editorial", "playful", "corporate", "luxury",
  "retro", "futuristic", "organic", "geometric", "hand-crafted",
  // Color/tone
  "dark-mode", "light-mode", "monochrome", "high-contrast", "pastel",
  "vibrant", "gradient-heavy", "muted", "duotone",
  // Layout
  "dense", "airy", "grid-led", "asymmetric", "single-column",
  "split-screen", "full-bleed", "card-based", "bento",
  // Content-led
  "typography-led", "photo-led", "illustration-led", "3d-led",
  "video-led", "data-viz-led", "motion-heavy",
] as const;

export const COMPONENT_TYPES = [
  "nav", "hero", "features", "pricing", "testimonials", "social-proof",
  "cta", "footer", "faq", "stats", "gallery", "form", "table",
  "product-card", "blog-list", "onboarding", "dashboard-shell",
  "settings", "empty-state", "modal", "other",
] as const;
