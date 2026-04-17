import http from "node:http";

interface Options {
  timeout?: number;
  development?: boolean;
}

export const GracefulShutdown = (
  server: http.Server,
  opts: Options,
): (() => Promise<void>) => {
  const options: Options = {
    timeout: 3000,
    development: false,
    ...opts,
  };

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

  function notifiyConnectionToClose(force = false) {
    connections.forEach((con) => {
      if (!con.headersSent && !force) {
        con.setHeader("connection", "close");
      }
    });
  }
  function waitForReadyToShutDown(iteration: number): Promise<boolean> {
    console.log(`waitForReadyToShutDown...`);

    if (connections.size == 0) {
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
      }, 100);
    });
  }

  async function shutdown() {
    console.log(
      "shutit down, currently open connection number: ",
      connections.size,
    );
    if (isShuttingDown || options.development) return;
    isShuttingDown = true;

    notifiyConnectionToClose();

    let timeoutId: NodeJS.Timeout;
    const timeout = new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve(""), options.timeout);
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
    const allConnectionClosed = await waitForReadyToShutDown(5);

    if (!allConnectionClosed) {
      console.log("forcefully closing connection");
      server.closeAllConnections();

      connections = new Set();
    }
    server.removeAllListeners("request");
  }
  return shutdown;
};
