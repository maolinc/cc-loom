# Loom Server

The Fastify, SQLite, WebSocket, and static web application server for Loom.
Initialize the first administrator explicitly on the first run:

```bash
npm install --global @maolinc/cc-loom-server

LOOM_ADMIN_EMAIL=admin@example.com \
LOOM_ADMIN_PASSWORD='replace-with-a-long-unique-password' \
loom-server

# 或临时运行
npx @maolinc/cc-loom-server
```

See the repository root README for deployment and security configuration.
Licensed under the MIT License.
