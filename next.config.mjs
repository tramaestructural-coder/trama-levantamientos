/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    config.externals = [...(config.externals || []), { canvas: "commonjs canvas" }];
    return config;
  },
};

export default nextConfig;
