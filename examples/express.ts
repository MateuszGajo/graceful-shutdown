import express, { Request, Response } from "express";
import http from "node:http";
import { httpGracefullShutdown } from "../gracefull";

const app = express();
const port = 3000;

const server: http.Server = app.listen(port, () => {
  console.log(`Listening at http://localhost:${port}`);
  console.log("Press Ctrl-C to test shutdown");
});

app.get("/", (req: Request, res: Response) => {
  setTimeout(() => res.send("Hello World!"), 6_500);
});

const shutdown = httpGracefullShutdown(server, { timeout: 30_000 });

process.on("SIGINT", () => {
  shutdown().then(() => {
    process.exit(0);
  });
});
