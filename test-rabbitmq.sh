#!/bin/bash
set -e

echo "==> Starting server..."
node ./examples/rabbitmq.js &
SERVER_PID=$!

echo "==> Waiting for server to start..."
sleep 2

echo "==> Killing RabbitMQ..."
sudo service rabbitmq-server stop &
sleep 0.5
echo "==> Sending request to http://localhost:3000..."
curl  http://localhost:3000/ &

echo "==> Waiting 200ms then shutting down server..."
sleep 0.2

echo "==> Sending SIGINT to server..."
kill -SIGINT $SERVER_PID

wait $SERVER_PID 2>/dev/null || true
echo "==> Done."