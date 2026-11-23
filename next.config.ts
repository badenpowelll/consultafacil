import type { NextConfig } from "next";

// Cabeçalhos fixos. A CSP com nonce é montada por requisição no middleware.
const cabecalhos = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  // Instruções explícitas a robôs de IA e indexadores: nada aqui é conteúdo público.
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, noai, noimageai" },
];

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  output: "standalone",
  async headers() {
    return [{ source: "/:path*", headers: cabecalhos }];
  },
};

export default config;
