/** @type {import('next').NextConfig} */
const nextConfig = {
  // Next 14: keep stellar-sdk out of the RSC bundler (native deps)
  experimental: {
    serverComponentsExternalPackages: ["stellar-sdk", "sodium-native"],
    // Enables src/instrumentation.ts (opt-in OpenTelemetry tracing, issue #203).
    instrumentationHook: true,
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

export default nextConfig;
