// pm2 ecosystem file
// Usage:
//   pm2 start ecosystem.config.js
//   pm2 stop gemma-gateway
//   pm2 restart gemma-gateway
//   pm2 logs gemma-gateway
//   pm2 monit

module.exports = {
  apps: [
    {
      name: 'gemma-gateway',
      script: './server.js',

      // Single instance — Ollama is the bottleneck, not this process
      instances: 1,

      // Use fork mode (not cluster) — we don't need HTTP load balancing here
      exec_mode: 'fork',

      // Restart policy
      autorestart:    true,
      max_restarts:   10,
      min_uptime:     '10s',   // must stay up 10s to count as a stable start
      restart_delay:  2000,    // ms between restart attempts

      // Crash loop breaker: stop after max_restarts in the exp_backoff window
      exp_backoff_restart_delay: 100,

      // Watch (disabled in prod — use a deploy hook instead)
      watch: false,

      // Memory guard: restart if RSS exceeds this (adjust to taste)
      max_memory_restart: '512M',

      // Environment variables (override .env for PM2-managed deployments)
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV:    'production',
        HOST:        '127.0.0.1',
        PORT:        '3000',
        // Add any prod-specific overrides here
      },

      // Logging
      out_file:    './logs/out.log',
      error_file:  './logs/error.log',
      merge_logs:  true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',

      // Graceful shutdown: give the server time to unload the model
      kill_timeout: 8000,   // ms PM2 waits before SIGKILL
      wait_ready:   false,   // set to true if you emit process.send('ready')
    },
  ],
}
