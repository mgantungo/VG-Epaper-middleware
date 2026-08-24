module.exports = {
  apps: [
    {
      name: 'epaper-middleware',
      script: 'src/server.js',
      cwd: __dirname,
      interpreter: 'node',
      // Plain request/response proxying + a JWT check per request — genuinely
      // stateless and CPU-light, so unlike ingest this one's a reasonable
      // candidate for cluster mode if you ever need more throughput. Left at
      // 1 for now; bump `instances` (and switch exec_mode stays 'cluster')
      // once you actually have a reason to.
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      // server.js -> config.js already runs `import 'dotenv/config'` itself,
      // so pm2 does NOT need an env_file option — .env is loaded by the app.
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
