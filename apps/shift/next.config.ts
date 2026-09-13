import type { NextConfig } from 'next';
const config:NextConfig={
  async headers(){return [{source:'/:path*',headers:[
    {key:'Content-Security-Policy',value:"default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://*.line.me https://*.line-scdn.net; frame-src https://access.line.me"},
    {key:'Referrer-Policy',value:'no-referrer'},{key:'X-Content-Type-Options',value:'nosniff'},
    {key:'X-Frame-Options',value:'DENY'},{key:'Permissions-Policy',value:'camera=(), microphone=(), geolocation=()'},
    {key:'Cache-Control',value:'private, no-store, max-age=0'},
  ]}];},
};
export default config;
