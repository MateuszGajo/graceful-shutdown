import http from "node:http";

interface Options {
  /**
   * Global shutdown budget in milliseconds.
   * Total time allowed for the entire shutdown sequence to complete
   * Must be greater than `serverCloseTimeout` to leave room for connection draining and other cleanup.
   * @default 10000
   */
  timeout?: number;
  /**
   * Budget in milliseconds only for `server.close()`.
   * Should cover the duration of your longest in-flight request.
   * Must be lower than `timeout` to leave room for connection draining and other cleanup.
   * @default 5000
   */
  serverCloseTimeout?: number;
  /**
   * When `true`, graceful shutdown is skipped entirely.
   * Useful during development to avoid delayed restarts.
   * @default false
   */
  development?: boolean;
}

export const httpGracefullShutdown = (
  server: http.Server,
  opts: Options,
): (() => Promise<void>) => {
  const options: Options = {
    timeout: 10000,
    serverCloseTimeout: 5000,
    development: false,
    ...opts,
  };

  const SHUTDOWN_POLL_INTERVAL_MS = 100;

  if (options.serverCloseTimeout > options.timeout) {
    throw new Error("serverCloseTimeout must be lower than timeout");
  }

  let isShuttingDown = false;
  let connections: Set<http.ServerResponse<http.IncomingMessage>> = new Set();

  server.on("request", (req, res) => {
    connections.add(res);
    res.once("finish", () => {
      connections.delete(res);
    });
    res.once("close", () => {
      connections.delete(res);
    });

    if (isShuttingDown && !res.headersSent) {
      res.setHeader("connection", "close");
    }
  });

  function notifyConnectionsToClose() {
    connections.forEach((con) => {
      if (con.headersSent) return;

      con.setHeader("connection", "close");
    });
  }
  function waitForReadyToShutDown(iteration: number): Promise<boolean> {
    console.log(`waitForReadyToShutDown...`);

    if (connections.size === 0) {
      console.log("all connections closed gracefully");
      return Promise.resolve(true);
    }

    if (iteration == 0) {
      console.log(
        `Could not close connections in time (${options.timeout}ms), will forcefully shut down`,
      );
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(waitForReadyToShutDown(iteration - 1));
      }, SHUTDOWN_POLL_INTERVAL_MS);
    });
  }

  async function shutdown() {
    if (isShuttingDown || options.development) return;
    isShuttingDown = true;
    console.log(`Shutting down, open connections: ${connections.size}`);

    const start = performance.now();

    notifyConnectionsToClose();

    let timeoutId: NodeJS.Timeout;
    const timeout = new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve(""), options.serverCloseTimeout);
    });

    const closeServer = new Promise((resolve) => {
      server.close((err) => {
        clearTimeout(timeoutId);
        if (err) {
          resolve(err);
        }
        resolve("");
      });
    });

    const err = await Promise.race([closeServer, timeout]);
    if (err) {
      console.error("Error clsoing server:", err);
    }

    const elapsed = performance.now() - start;
    const timeoutLeft = options.timeout - elapsed;
    const allConnectionClosed = await waitForReadyToShutDown(
      Math.floor(timeoutLeft / SHUTDOWN_POLL_INTERVAL_MS),
    );

    if (!allConnectionClosed) {
      server.closeAllConnections();

      connections = new Set();
    }
    server.removeAllListeners("request");
  }
  return shutdown;
};
