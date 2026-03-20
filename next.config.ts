import type { NextConfig } from "next";

const noIndexPrefixes = [
  "dashboard",
  "restaurants",
  "manager",
  "schedule",
  "reports",
  "staff",
  "chat",
  "billing",
  "subscribe",
  "review-requests",
  "time-off",
  "blocked-days",
  "business-hours",
  "profile",
  "account",
  "persona",
  "reset-passcode",
  "setup",
  "onboarding",
];

const stripeEmbeddedRoutePrefixes = ["setup", "subscribe", "onboarding"];

function buildStripeEmbeddedCsp(): string {
  const supabaseUrl = String(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  let supabaseOrigin = "";
  try {
    supabaseOrigin = supabaseUrl ? new URL(supabaseUrl).origin : "";
  } catch {
    supabaseOrigin = "";
  }

  const connectSources = [
    "'self'",
    "https://api.stripe.com",
    "https://*.stripe.com",
    "wss://*.stripe.com",
    "https://*.supabase.co",
    "wss://*.supabase.co",
    ...(supabaseOrigin ? [supabaseOrigin] : []),
  ];

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com",
    "frame-src 'self' https://js.stripe.com https://checkout.stripe.com https://*.stripe.com",
    `connect-src ${connectSources.join(" ")}`,
    "img-src 'self' data: https://*.stripe.com",
    "style-src 'self' 'unsafe-inline'",
  ].join("; ");
}

const nextConfig: NextConfig = {
  compiler: {
    removeConsole: {
      exclude: ['error'],
    },
  },
  allowedDevOrigins: [
    "http://192.168.1.4:3000",
    "http://169.254.5.254:3000",
    "http://localhost:3000",
  ],
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "www.crewshyft.com" }],
        destination: "https://crewshyft.com/:path*",
        permanent: true,
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/",
        has: [{ type: "host", value: "app.crewshyft.com" }],
        destination: "/dashboard",
      },
      {
        source: "/schedule",
        has: [{ type: "host", value: "app.crewshyft.com" }],
        destination: "/dashboard",
      },
    ];
  },
  async headers() {
    const noIndexHeaders = noIndexPrefixes.flatMap((prefix) => [
      {
        source: `/${prefix}`,
        headers: [
          {
            key: "X-Robots-Tag",
            value: "noindex, nofollow",
          },
        ],
      },
      {
        source: `/${prefix}/:path*`,
        headers: [
          {
            key: "X-Robots-Tag",
            value: "noindex, nofollow",
          },
        ],
      },
    ]);

    // Stripe embedded checkout payment methods (e.g. Cash App Pay) rely on popup flows.
    // Scope popup-friendly COOP/COEP and Stripe CSP allowlist only to payment-capable onboarding routes.
    const stripeEmbeddedCsp = buildStripeEmbeddedCsp();
    const stripePopupHeaders = stripeEmbeddedRoutePrefixes.flatMap((prefix) => [
      {
        source: `/${prefix}`,
        headers: [
          {
            key: "Cross-Origin-Opener-Policy",
            value: "same-origin-allow-popups",
          },
          {
            key: "Cross-Origin-Embedder-Policy",
            value: "unsafe-none",
          },
          {
            key: "Content-Security-Policy",
            value: stripeEmbeddedCsp,
          },
        ],
      },
      {
        source: `/${prefix}/:path*`,
        headers: [
          {
            key: "Cross-Origin-Opener-Policy",
            value: "same-origin-allow-popups",
          },
          {
            key: "Cross-Origin-Embedder-Policy",
            value: "unsafe-none",
          },
          {
            key: "Content-Security-Policy",
            value: stripeEmbeddedCsp,
          },
        ],
      },
    ]);

    return [...noIndexHeaders, ...stripePopupHeaders];
  },
};

export default nextConfig;
