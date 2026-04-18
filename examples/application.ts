import express, { Request, Response } from "express";
import {
  AmqpConnectionManager,
  ChannelWrapper,
  connect,
} from "amqp-connection-manager";
import { EventEmitter } from "node:stream";
import { httpGracefullShutdown } from "../gracefull";
import http from "node:http";

const main = async () => {
  const app = express();
  const port = 3000;

  const rabbitmqConn = connect("amqp://localhost");

  rabbitmqConn.on("connect", () => {
    console.log("rabbitmq connected");
  });
  rabbitmqConn.on("connectFailed", (err) => {
    console.log("rabbitmq connecition failed", err);
  });
  const channel = rabbitmqConn.createChannel({
    setup: (channel: ChannelWrapper) => {
      channel.assertQueue("queue", { durable: true });
    },
  });
  const eventEmitter = new EventEmitter();

  const server = app.listen(port, () => {
    console.log(`Listening at http://localhost:${port}`);
    console.log("Press Ctrl-C to test shutdown");
  });

  app.get("/", (req: Request, res: Response) => {
    console.log("got request?");
    setTimeout(() => res.send("Hello World!"), 5000);
    console.log("Sent event");
    eventEmitter.emit("sendMessage");
  });

  const { consumerTag } = await channel.consume("queue", () => {
    console.log("got msg?");
  });

  eventEmitter.on("sendMessage", async () => {
    channel
      .sendToQueue("queue", "dummy msg")
      .then(() => console.log("msg send"))
      .catch((err) => console.log("msg wasn't sent try again", err));
  });

  const shutdown = shutdownFunc({
    server: {
      server: server,
    },
    rabbitMqOptions: {
      channel,
      rabbitmqConn,
      consumerTags: [consumerTag],
    },
    development: false,
  });

  process.on("SIGINT", () => shutdown().catch(console.error));
  process.on("SIGTERM", () => shutdown().catch(console.error));
};

try {
  main();
} catch (err) {
  console.error("error starting program", err);
}

interface RabbitMqOptions {
  /**
   * Consumer tags to cancel during shutdown.
   * Only include tags for queues that are actively being consumed —
   * cancelling stops new message delivery so in-flight handlers can finish.
   */
  consumerTags?: string[];
  channel: ChannelWrapper;
  rabbitmqConn: AmqpConnectionManager;
}

interface HttpServer {
  /**
   * Total budget in milliseconds for the HTTP server shutdown sequence,
   * including waiting for in-flight requests to complete.
   * Must be less than the global `ShutdownOptions.timeout`.
   * @default 10000
   */
  timeout?: number;
  /**
   * Budget in milliseconds only for `server.close()` to stop accepting new connections.
   * Should cover the duration of your longest in-flight request.
   * Must be lower than `timeout`.
   * @default 5000
   */
  serverCloseTimeout?: number;
  server: http.Server;
}

interface ShutdownOptions {
  /**
   * RabbitMQ resources to clean up during shutdown.
   * If not provided, RabbitMQ shutdown steps are skipped.
   */
  rabbitMqOptions?: RabbitMqOptions;
  /**
   * HTTP server to shut down gracefully.
   * If not provided, HTTP shutdown steps are skipped.
   */
  server?: HttpServer;
  /**
   * Global shutdown budget in milliseconds.
   * This is the hard deadline for the entire shutdown sequence.
   * If exceeded, the process is forcefully killed with `process.exit(1)`.
   * Must be greater than the sum of all other timeouts and `gracePeriod`.
   * @default 20000
   */
  timeout?: number;
  /**
   * Time in milliseconds to wait after stopping new work (HTTP requests, RabbitMQ consumers)
   * before closing resources. Gives in-flight message handlers, background tasks,
   * and pending async I/O a chance to complete naturally.
   * @default 5000
   */
  gracePeriod?: number;
  /**
   * When `true`, graceful shutdown is skipped entirely and the function returns immediately.
   * Useful during development to avoid delayed server restarts.
   * @default true
   */
  development?: boolean;
}

const shutdownFunc = (options: ShutdownOptions) => {
  let isShuttingDown = false;

  const opts = {
    development: options.development ?? true,
    timeout: options.timeout ?? 20000,
    server: options.server
      ? {
          serverCloseTimeout: options.server.serverCloseTimeout ?? 5000,
          timeout: options.server.timeout ?? 10000,
          server: options.server.server,
        }
      : undefined,
    gracePeriod: options.gracePeriod ?? 5000,
    rabbitMqOptions: options.rabbitMqOptions,
  };

  const httpShutdown = opts.server
    ? httpGracefullShutdown(opts.server.server, {
        serverCloseTimeout: opts.server.serverCloseTimeout,
        timeout: opts.server.timeout,
        development: opts.development,
      })
    : async () => {};

  const allTimeouts = [opts.server?.timeout, opts.gracePeriod].reduce(
    (sum, t) => sum + (t ?? 0),
    0,
  );

  if (opts.timeout < allTimeouts) {
    throw new Error(
      "General timeout should be grater than rest timeout combined: http server timeout, grace period",
    );
  }

  return async () => {
    if (opts.development) {
      process.exit(0);
    }

    if (isShuttingDown) return;

    isShuttingDown = true;
    const forceExit = setTimeout(() => {
      console.error("Shutdown timed out, forcing exit");
      process.exit(1);
    }, opts.timeout);
    forceExit.unref();

    // 1. stop accepting new work: request and rabbitmq
    const consumerTags = options.rabbitMqOptions?.consumerTags ?? [];
    const results = await Promise.allSettled([
      httpShutdown(),
      ...consumerTags?.map((consumer) =>
        options.rabbitMqOptions.channel.cancel(consumer),
      ),
    ]);
    results
      .filter((r) => r.status == "rejected")
      .forEach((r) =>
        console.error(
          "Shutdown step failed:",
          (r as PromiseRejectedResult).reason,
        ),
      );
    console.log("stopped accepting new work");

    // grace period: allow in-flight message handlers, async jobs, and
    // pending I/O to finish before closing app
    // tracking every listener, every backgroud track is expensive and requires good structure that fit the problem space.
    await new Promise<void>((res) => setTimeout(() => res(), opts.gracePeriod));
    console.log("Grace period finished");

    // 3 cleanup resources
    if (opts.rabbitMqOptions) {
      try {
        await opts.rabbitMqOptions.channel.close();
        await opts.rabbitMqOptions.rabbitmqConn.close();
      } catch (err) {
        console.error("error closing rabbitmq", err);
      }
    }

    console.log("Resources cleaned up");

    clearTimeout(forceExit);
    process.exit(0);
  };
};
