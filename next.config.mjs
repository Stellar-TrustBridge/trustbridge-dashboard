/** @type {import('next').NextConfig} */

/**
 * Allowed origins for CORS on public API endpoints.
 *
 * The trustbridge-action runs server-side (Node.js fetch), so CORS does not
 * apply to it. We still lock down the origin list defensively in case a
 * browser-based tool (Swagger UI, custom script) calls these endpoints.
 *
 * To add a new origin, append it to ALLOWED_ORIGINS below.
 */
const ALLOWED_ORIGINS = [
  "https://github.com",
  "https://github.io",
];

/** Paths that receive CORS headers (public, no-auth endpoints). */
const CORS_PATHS = ["/api/actions/lookup", "/api/check"];

const nextConfig = {
  // Next 14: keep stellar-sdk out of the RSC bundler (native deps)
  experimental: {
    serverComponentsExternalPackages: ["stellar-sdk", "sodium-native"],
  },

  async headers() {
    return [
      {
        source: "/api/actions/lookup",
        headers: buildCorsHeaders(),
      },
      {
        source: "/api/check",
        headers: buildCorsHeaders(),
      },
    ];
  },

  webpack: (config, { isServer }) => {
    config.externals.push("pino-pretty", "lokijs", "encoding");

    // Block accidental client bundling of stellar-sdk / native crypto
    if (!isServer) {
      config.resolve.alias = {
        ...config.resolve.alias,
        "stellar-sdk": false,
        "@stellar/stellar-base": false,
        "sodium-native": false,
      };
    }

    return config;
  },
};

/**
 * Build CORS headers for a single path.
 *
 * Policy:
 * - Only origins in ALLOWED_ORIGINS may use credentials.
 * - No wildcard (*) with credentials.
 * - Methods: GET, POST, OPTIONS (preflight).
 * - The Action is server-side — CORS headers are defensive, not functional.
 */
function buildCorsHeaders() {
  return [
    {
      key: "Access-Control-Allow-Origin",
      value: ALLOWED_ORIGINS.join(", "),
    },
    {
      key: "Access-Control-Allow-Methods",
      value: "GET, POST, OPTIONS",
    },
    {
      key: "Access-Control-Allow-Headers",
      value: "Content-Type, Authorization, X-Cache-Bypass",
    },
    {
      key: "Access-Control-Max-Age",
      value: "86400",
    },
    {
      key: "Vary",
      value: "Origin",
    },
  ];
}

export default nextConfig;
