/** @type {import('next').NextConfig} */
const path = require('path');

const nextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      '@': path.resolve(__dirname),
    };
    return config;
  },
};

if (process.env.NEXT_STANDALONE !== 'false') {
  nextConfig.output = 'standalone';
}

module.exports = nextConfig;
